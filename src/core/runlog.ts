import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The run log (OUT-3, SEC-7): `runs/YYYY-MM.jsonl`, append-only and hash-chained.
 *
 * Several machines append to the same file, and git merges their lines with the `union`
 * driver. A single global chain would break on every merge, so each agent keeps its own
 * chain: `prev` is the hash of that agent's previous entry. Any reordering by a merge
 * keeps every per-agent chain verifiable, and any edit or deletion breaks one.
 *
 * Entries hold IDs, sizes, timings and outcomes only. Never task text or source content.
 */

export type RunLogEntry =
  | ({ type: "run"; taskId: string; category: string; size: string; skill: string; skillVersion: string;
      outcome: "ok" | "failed" | "capped" | "refused"; durationMs: number; tokens: number | null; costUsd: number | null;
      runtime: string; fencingToken?: number } & Base)
  | ({ type: "digest"; outcome: "approved" | "rejected" | "staged"; items: number; held: number; durationMs: number;
      tokens: number | null; costUsd: number | null; receipt?: string } & Base)
  /** `receipt` is the run's receipt ID on the machine that ran it (FLOW-1): a timestamp, no content. */
  | ({ type: "synthesize"; posted: number; held: number; durationMs: number; tokens: number | null; costUsd: number | null; receipt?: string } & Base)
  | ({ type: "verdict"; taskId: string; category: string; size: string; verdict: "accepted" | "rejected" | "redo";
      reviewMinutes: number | null; editSize: number | null } & Base)
  | ({ type: "release"; taskId: string; reason: "stale" | "manual" | "redo" | "failed" | "brain" } & Base)
  | ({ type: "unpause"; category: string } & Base)
  /** The brain paused a category (BRAIN-2). `rule` is its fixed rule ID; `pmx review --unpause` lifts it. */
  | ({ type: "pause"; category: string; by: "brain"; rule: string } & Base);

interface Base {
  ts: string;
  agent: string;
  machine: string;
  prev?: string | null;
  hash?: string;
}

export type NewEntry = RunLogEntry extends infer E ? (E extends RunLogEntry ? Omit<E, "prev" | "hash" | "ts"> & { ts?: string } : never) : never;

function canonical(o: Record<string, unknown>): string {
  return JSON.stringify(o, Object.keys(o).sort());
}

export function hashEntry(e: Omit<RunLogEntry, "hash">): string {
  const { hash: _h, ...rest } = e as RunLogEntry;
  return createHash("sha256").update(canonical(rest as Record<string, unknown>)).digest("hex");
}

export function monthFile(dir: string, ts: string): string {
  return join(dir, "runs", `${ts.slice(0, 7)}.jsonl`);
}

export async function readAll(dir: string): Promise<RunLogEntry[]> {
  const runs = join(dir, "runs");
  let files: string[] = [];
  try {
    files = (await readdir(runs)).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort();
  } catch {
    return [];
  }
  const out: RunLogEntry[] = [];
  for (const f of files) {
    for (const line of (await readFile(join(runs, f), "utf8")).split("\n")) {
      if (line.trim()) out.push(JSON.parse(line));
    }
  }
  return out;
}

export async function append(dir: string, e: NewEntry): Promise<RunLogEntry> {
  const all = await readAll(dir);
  const mine = all.filter((x) => x.agent === e.agent);
  const entry = { ...e, ts: e.ts ?? new Date().toISOString(), prev: mine.at(-1)?.hash ?? null } as RunLogEntry;
  entry.hash = hashEntry(entry);
  await mkdir(join(dir, "runs"), { recursive: true });
  await appendFile(monthFile(dir, entry.ts), JSON.stringify(entry) + "\n");
  return entry;
}

export interface VerifyResult {
  ok: boolean;
  entries: number;
  agents: number;
  problems: string[];
}

export function verify(entries: RunLogEntry[]): VerifyResult {
  const last = new Map<string, string | null>();
  const problems: string[] = [];
  entries.forEach((e, i) => {
    if (e.hash !== hashEntry(e)) problems.push(`entry ${i + 1} (${e.agent}): hash does not match its content`);
    const expected = last.has(e.agent) ? last.get(e.agent)! : null;
    if ((e.prev ?? null) !== expected) problems.push(`entry ${i + 1} (${e.agent}): chain broken (an entry is missing or out of order)`);
    last.set(e.agent, e.hash ?? null);
  });
  return { ok: problems.length === 0, entries: entries.length, agents: last.size, problems };
}
