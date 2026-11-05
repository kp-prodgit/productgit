import type { Ctx } from "../core/context.js";
import { outputHost, type OutputHost } from "../core/host.js";
import { RunLogStore } from "../core/runlog-store.js";
import type { RunLogEntry } from "../core/runlog.js";
import type { Services } from "../core/services.js";
import type { Task } from "../core/types.js";
import type { RunRecord } from "../run/record.js";

export interface ReviewItem {
  task: Task;
  prId: string;
  prUrl: string;
  files: { path: string; content: string }[];
  record: RunRecord | null;
  /** Source ID → the approved quote from the task, for citation hovercards. */
  citations: Record<string, string>;
}

export type Verdict = "accepted" | "rejected" | "redo";

export function prIdFromUrl(url: string): string {
  if (url.startsWith("branch:")) return url.slice(7);
  const m = url.match(/\/pull\/(\d+)/);
  if (!m) throw new Error(`Can't read a PR number from ${url}`);
  return m[1]!;
}

export function citationsOf(t: Task): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of t.description.matchAll(/^- \[([A-Z]\d+)\] (.+)$/gm)) out[m[1]!] = m[2]!;
  return out;
}

/** Drafts waiting for review. By default your own agent's; `all` for the whole team. */
export async function loadQueue(ctx: Ctx, svc: Services, o: { all?: boolean } = {}): Promise<{ items: ReviewItem[]; host: OutputHost }> {
  const host = await outputHost(ctx.repo, ctx.keychain, ctx.exec, ctx.fetch);
  const inReview = (await svc.tracker.list({ status: ["review"] })).filter((t) => o.all || t.agent === ctx.agent);
  const items: ReviewItem[] = [];
  for (const t of inReview) {
    const task = await svc.tracker.get(t.id);
    if (!task.prUrl) continue;
    const prId = prIdFromUrl(task.prUrl);
    if (!(await host.isOpen(prId))) continue;
    const files = await host.files(prId);
    const rec = files.find((f) => f.path === `.pmx/runs/${task.identifier}.json`);
    items.push({
      task, prId, prUrl: task.prUrl,
      files: files.filter((f) => !f.path.startsWith(".pmx/")),
      record: rec ? (JSON.parse(rec.content) as RunRecord) : null,
      citations: citationsOf(task),
    });
  }
  return { items, host };
}

/**
 * Records a human decision (REV-1, REV-2). Accept merges the PR and marks the task done. Reject closes
 * the PR and blocks the task with the reason. Redo closes the PR, adds the note to the task and puts
 * it back to ready, so the next pull drafts it again with the note.
 */
export async function decide(
  ctx: Ctx, svc: Services, host: OutputHost, item: ReviewItem, verdict: Verdict, o: { note?: string; reviewMinutes?: number | null } = {},
): Promise<string> {
  const { task } = item;
  const who = ctx.personal.handle;
  if ((verdict === "rejected" || verdict === "redo") && !o.note?.trim()) throw new Error(`A ${verdict === "redo" ? "redo" : "reject"} needs a note.`);
  if (verdict === "accepted") {
    await host.accept(item.prId);
    await svc.tracker.comment(task.id, `Accepted by ${who}.`);
    await svc.tracker.setStatus(task.id, "done");
  } else if (verdict === "rejected") {
    await host.reject(item.prId, `Rejected by ${who}: ${o.note}`);
    await svc.tracker.comment(task.id, `Rejected by ${who}: ${o.note}`);
    await svc.tracker.setAgent(task.id, null);
    await svc.tracker.setStatus(task.id, "blocked");
  } else {
    await host.reject(item.prId, `Redo requested by ${who}: ${o.note}`);
    await svc.tracker.addNote(task.id, o.note!);
    await svc.tracker.comment(task.id, `Redo requested by ${who}: ${o.note}`);
    await svc.tracker.setAgent(task.id, null);
    await svc.tracker.setStatus(task.id, "ready");
  }
  await new RunLogStore(ctx).record({
    type: "verdict", agent: ctx.agent, machine: ctx.personal.machineId, taskId: task.identifier,
    category: task.category ?? "unknown", size: task.size ?? "?", verdict, reviewMinutes: o.reviewMinutes ?? null, editSize: null,
  });
  return `${task.identifier} ${verdict}.`;
}

export interface CategoryStats {
  accepted: number;
  rejected: number;
  redo: number;
  total: number;
  rate: number;
}

/** Accept rate per category over a window (REV-3, MET-1). Redo counts against acceptance. */
export function acceptStats(entries: RunLogEntry[], now: Date, windowDays: number): Record<string, CategoryStats> {
  const since = now.getTime() - windowDays * 86400000;
  const unpausedAt = new Map<string, number>();
  for (const e of entries) if (e.type === "unpause") unpausedAt.set(e.category, Math.max(unpausedAt.get(e.category) ?? 0, Date.parse(e.ts)));
  const out: Record<string, CategoryStats> = {};
  for (const e of entries) {
    if (e.type !== "verdict") continue;
    const t = Date.parse(e.ts);
    // An unpause resets the window for that category, so it gets a fresh chance.
    if (t < since || t < (unpausedAt.get(e.category) ?? 0)) continue;
    const s = (out[e.category] ??= { accepted: 0, rejected: 0, redo: 0, total: 0, rate: 0 });
    s[e.verdict]++;
    s.total++;
  }
  for (const s of Object.values(out)) s.rate = s.total ? s.accepted / s.total : 0;
  return out;
}

export function formatStats(stats: Record<string, CategoryStats>): string {
  const rows = Object.entries(stats).sort(([a], [b]) => a.localeCompare(b));
  if (!rows.length) return "No review decisions yet.";
  return rows.map(([c, s]) => `${c.padEnd(22)} ${(s.rate * 100).toFixed(0).padStart(3)}% accepted  (${s.accepted} accepted, ${s.redo} redo, ${s.rejected} rejected)`).join("\n");
}
