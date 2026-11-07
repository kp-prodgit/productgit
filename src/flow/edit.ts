import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { savePersonalConfig, type PersonalConfig } from "../core/config.js";
import { paths } from "../core/paths.js";
import { listReceipts, readReceipt } from "../core/receipt.js";

/**
 * Edits the flow view may make (FLOW-6). Only ones that make PMX stricter: adding to the PM's own do-not-read
 * list. Loosening a rule, unpausing, releasing or reviewing stay CLI or PR only, because any Claude chat on
 * this Mac can call the local MCP server that offers this edit.
 */
export type NeverIngestKind = "title" | "person" | "channel";
const FIELD = { title: "meetingTitles", person: "people", channel: "channels" } as const;

export function checkNeverIngest(kind: string, value: unknown): { kind: NeverIngestKind; value: string } {
  if (!(kind in FIELD)) throw new Error(`Unknown kind "${kind}": use title, person or channel.`);
  const v = typeof value === "string" ? value.trim() : "";
  if (v.length < 3 || v.length > 120 || /[\r\n\t]/.test(v)) throw new Error("Give 3 to 120 characters on one line.");
  return { kind: kind as NeverIngestKind, value: v };
}

/**
 * What the new rule would have held in the last 14 days, from this Mac's run records. Titles are all PMX keeps
 * of a used meeting, so only a title rule can be replayed; people and channels apply from the next run.
 */
export async function whatIf(kind: NeverIngestKind, value: string): Promise<{ meetings: number; tasks: number; note: string }> {
  if (kind !== "title") return { meetings: 0, tasks: 0, note: "PMX's records don't keep participants or channels of past meetings, so this applies from the next run." };
  const lc = value.toLowerCase();
  const hits = new Set<string>();
  let tasks = 0;
  for (const id of await listReceipts()) {
    const r = await readReceipt(id);
    if (!r) continue;
    const ids = new Set(r.sources.filter((s) => s.decision === "used" && (s.title ?? "").toLowerCase().includes(lc)).map((s) => { hits.add(s.refHash); return s.id; }));
    tasks += (r.synth?.tasks ?? []).filter((t) => t.sources.some((s) => ids.has(s))).length;
  }
  return { meetings: hits.size, tasks, note: "Tasks already in Linear stay there; archive them in Linear if they shouldn't be." };
}

/** Adds one entry to the PM's do-not-read list and logs the edit on this Mac. Never removes anything. */
export async function addNeverIngest(personal: PersonalConfig, kind: NeverIngestKind, value: string, via: "cli" | "flow"): Promise<{ added: boolean }> {
  const list = personal.neverIngest[FIELD[kind]];
  if (list.some((x) => x.toLowerCase() === value.toLowerCase())) return { added: false };
  list.push(value);
  await savePersonalConfig(personal);
  await mkdir(paths.logs(), { recursive: true });
  // The edit log records that a rule was added, never the entry itself: the list is the PM's secret.
  await appendFile(join(paths.logs(), "edits.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), edit: "never-ingest-add", kind, via })}\n`, { mode: 0o600 });
  return { added: true };
}
