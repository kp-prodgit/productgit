import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ItemDecision, HoldReason } from "./filter.js";
import { TOPICS } from "./filter.js";
import { privateDir, readJson, writeJson } from "./fsutil.js";
import { paths } from "./paths.js";
import type { RedactionKind } from "./redact.js";
import type { Size } from "./types.js";

/**
 * A run receipt (PRIV-4): how one digest or synthesis run decided what to read, what it left out
 * and why, what was masked, which skills and model ran, and what it cost. `pmx explain` shows it.
 *
 * It lives only in ~/.pmx/receipts (0700 folder, 0600 files) for at most 14 days, and never in git.
 * It never holds what was left out: held sources are a path hash plus the rule, held passages a hash
 * plus the rule. `pmx explain` finds them again in the PM's own files, on screen only.
 */
export interface RunReceipt {
  v: 1;
  id: string;
  type: "digest" | "synthesize";
  at: string;
  agent: string;
  dryRun?: boolean;
  outcome: "staged" | "no-signal" | "failed" | "posted" | "dry-run";
  window: { days: number; since: string; scope: "personal" | "team" };
  rules: {
    internalDomains: string[];
    requireExternalParticipant: boolean;
    topicRulesHash: string;
    /** How many entries each do-not-read list has. Never the entries. */
    neverIngest: { people: number; channels: number; meetingTitles: number };
    folders: string[];
  };
  /** Sources that couldn't be read at all, e.g. "Slack: no token in the keychain". */
  skippedSources: string[];
  sources: SourceReceipt[];
  masked: Record<RedactionKind, number>;
  skills: { name: string; version: string; source: "team" | "bundled" }[];
  model: { name: string; runtime: string; tools: string; costUsd: number | null; tokens: number | null; durationMs: number; promptSha256: string } | null;
  digest?: { cited: string[]; removedClaims: number; staged: string };
  synth?: { tasks: TaskReceipt[]; skipped: string[] };
  error?: string;
}

export interface SourceReceipt {
  kind: "transcript" | "slack";
  /** sha256 of the absolute path or permalink, so `pmx explain` can find a left-out file again. */
  refHash: string;
  decision: "used" | "left-out";
  /** Only for used sources: they're cited in the draft anyway. */
  id?: string;
  file?: string;
  title?: string;
  at?: string;
  rule?: HoldReason | "all-passages-held";
  detail: string;
  passagesCut: { rule: HoldReason; hash: string }[];
  passagesUsed: number;
}

export interface TaskReceipt {
  title: string;
  category: string;
  size: Size;
  sources: string[];
  sizing: Sizing | null;
}

export type SizeFlag = "no-reason" | "cell-mismatch" | "count-below" | "count-above";

export interface Sizing {
  /** The rubric cell the model says it matched, e.g. "Themes across 3–8 sources". */
  cell: string | null;
  /** The rubric's own cell for this category and size. */
  expectedCell: string | null;
  why: string;
  /** Deterministic checks that disagree with the model's size. They flag, never block. */
  flags: SizeFlag[];
}

export const refHash = (ref: string) => createHash("sha256").update(ref.startsWith("http") ? ref : resolve(ref)).digest("hex").slice(0, 16);

export const topicRulesHash = () =>
  createHash("sha256").update(Object.values(TOPICS).map((r) => r.source).join("\n")).digest("hex").slice(0, 12);

export function sourceReceipts(decisions: ItemDecision[], titleOf: (t: string) => string): SourceReceipt[] {
  return decisions.map((d) => {
    const base = { kind: d.item.kind, refHash: refHash(d.item.ref), detail: d.detail, passagesCut: d.passages, passagesUsed: d.passagesKept };
    if (d.decision === "held") return { ...base, decision: "left-out", rule: d.rule };
    return { ...base, decision: "used", id: d.item.id, file: d.item.kind === "slack" ? d.item.ref : basename(d.item.ref), title: titleOf(d.item.title), at: d.item.at };
  });
}

export function newReceiptId(type: RunReceipt["type"], at: Date): string {
  return `${type}-${at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
}

const ID = /^(digest|synthesize)-\d{8}T\d{6}Z$/;
const KEEP_DAYS = 14;
const KEEP_MAX = 50;

export async function writeReceipt(r: RunReceipt, now = new Date()): Promise<void> {
  await privateDir(paths.home());
  await privateDir(paths.receipts());
  await writeJson(join(paths.receipts(), `${r.id}.json`), r, 0o600);
  await pruneReceipts(now);
}

export async function listReceipts(): Promise<string[]> {
  const names = await readdir(paths.receipts()).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).filter((id) => ID.test(id)).sort((a, b) => stamp(b).localeCompare(stamp(a)));
}

const stamp = (id: string) => id.split("-").pop()!;

/** `id` must be a listed receipt ID, never a path. */
export async function readReceipt(id: string): Promise<RunReceipt | null> {
  if (!ID.test(id) || !(await listReceipts()).includes(id)) return null;
  return readJson<RunReceipt>(join(paths.receipts(), `${id}.json`));
}

async function pruneReceipts(now: Date): Promise<void> {
  const ids = await listReceipts();
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 86400000).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  for (const [i, id] of ids.entries()) if (i >= KEEP_MAX || stamp(id) < cutoff) await rm(join(paths.receipts(), `${id}.json`), { force: true });
}
