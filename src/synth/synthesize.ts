import type { Ctx } from "../core/context.js";
import { totalHeld } from "../core/filter.js";
import { DATA_RULES, dataBlock } from "../core/prompt.js";
import { RunLogStore } from "../core/runlog-store.js";
import type { Services } from "../core/services.js";
import { createHash } from "node:crypto";
import { newReceiptId, writeReceipt, type RunReceipt, type SizeFlag, type Sizing } from "../core/receipt.js";
import { parseRubric, type SizeRubric } from "../core/skillcheck.js";
import { loadSkill, skillBody, SKILL_USES } from "../core/skills.js";
import { updateState } from "../core/state.js";
import { SIZES, type CandidateTask, type SignalItem, type Size } from "../core/types.js";
import { recordSpend } from "../budget/provider.js";
import { gather } from "../digest/gather.js";
import { planMeetings, startOfDay } from "../meetings/ledger.js";
import type { MeetingEntry } from "../tracker/types.js";

export interface SynthResult {
  posted: { identifier: string; title: string }[];
  skipped: string[];
  held: number;
  /** The meeting ledger (MEET-2): lodged and finished now, already done by someone, claimed elsewhere, before the window. */
  meetings: { processed: { entry: string; tasks: string[] }[]; already: number; busy: number; before: number };
}

/** Model output derived from source text stays on one line, so it can never start a `pmx:` control line. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const cellKey = (s: string) => s.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();

/**
 * Checks the model's size against the rubric (PRIV-4, sizing): the cell it quotes must be the rubric's
 * cell for that category and size, and countable categories must cite a fitting number of sources.
 * Disagreements are flags for the human at triage; they never drop a task.
 */
export function checkSizing(t: { category: string; size: Size; sources: string[] }, raw: unknown, rubric?: SizeRubric): Sizing {
  const given = raw && typeof raw === "object" ? (raw as { cell?: unknown; why?: unknown }) : {};
  const cell = given.cell ? oneLine(String(given.cell)).slice(0, 200) : null;
  const why = given.why ? oneLine(String(given.why)).slice(0, 300) : "";
  const expectedCell = rubric?.cells[t.category]?.[t.size] ?? null;
  const flags: SizeFlag[] = [];
  if (!why) flags.push("no-reason");
  if (cell && expectedCell && cellKey(cell) !== cellKey(expectedCell)) flags.push("cell-mismatch");
  const range = rubric?.ranges[t.category]?.[t.size];
  if (range) {
    const [min, max] = range;
    if (t.sources.length < min) flags.push("count-below");
    if (max !== null && t.sources.length > max) flags.push("count-above");
  }
  return { cell, expectedCell, why, flags };
}

export const FLAG_TEXT: Record<SizeFlag, string> = {
  "no-reason": "the model gave no reason for this size",
  "cell-mismatch": "the rubric cell it quoted isn't the one for this category and size",
  "count-below": "it cites fewer sources than this size expects",
  "count-above": "it cites more sources than this size expects",
};

/** Pulls the JSON object out of the model's reply and validates every task against team config. */
export function parseCandidates(text: string, categories: string[], validIds: Set<string>, rubric?: SizeRubric): { tasks: CandidateTask[]; skipped: string[] } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Synthesis returned no JSON.");
  const raw = JSON.parse(text.slice(start, end + 1));
  const tasks: CandidateTask[] = [];
  const skipped: string[] = [];
  for (const t of (raw.tasks ?? []).slice(0, 10)) {
    const title = oneLine(String(t.title ?? "")).slice(0, 120);
    const sources = (Array.isArray(t.sources) ? t.sources : []).map(String).filter((id: string) => validIds.has(id));
    if (!title) { skipped.push("untitled task"); continue; }
    if (!categories.includes(t.category)) { skipped.push(`${title}: unknown category ${t.category}`); continue; }
    if (!SIZES.includes(t.size)) { skipped.push(`${title}: bad size ${t.size}`); continue; }
    if (!sources.length) { skipped.push(`${title}: no valid sources`); continue; }
    const sizing = checkSizing({ category: t.category, size: t.size, sources }, t.sizing, rubric);
    tasks.push({ title, category: t.category, size: t.size as Size, rationale: oneLine(String(t.rationale ?? "")).slice(0, 1000), sources, sizing });
  }
  return { tasks, skipped };
}

/** The task description: rationale, cited quotes (redacted) as evidence, and `pmx:source` lines. */
export function describe(c: CandidateTask, items: SignalItem[]): string {
  const byId = new Map(items.map((i) => [i.id, i]));
  const quotes = c.sources.map((id) => {
    const i = byId.get(id)!;
    const excerpt = i.text.replace(/\s+/g, " ").slice(0, 400);
    return `- [${id}] ${i.title} (${i.at.slice(0, 10)}): ${excerpt}${i.text.length > 400 ? "…" : ""}`;
  });
  const sz = c.sizing;
  const why = sz
    ? [`**Why size ${c.size}:** ${sz.cell ?? "no rubric cell given"}${sz.why ? `. ${sz.why}` : ""}`, ...sz.flags.map((f) => `**Check the size:** ${FLAG_TEXT[f]}.`), ""]
    : [];
  return [c.rationale, "", ...why, "**Sources**", "", ...quotes, "", ...c.sources.map((id) => `pmx:source ${id} ${byId.get(id)!.kind === "slack" ? byId.get(id)!.ref : ""}`.trim())].join("\n");
}

/**
 * `pmx synthesize` (SIG-2, SIG-4). Reads team sources with no tools, proposes sized tasks and
 * posts them to the PMX project's inbox only. A human triages before anything runs (SEC-2).
 */
export async function synthesize(
  ctx: Ctx, svc: Services,
  o: { days: number; dryRun?: boolean; since?: Date; skipIfNothingNew?: boolean },
): Promise<SynthResult> {
  const g = await gather(ctx, { days: o.days, scope: "team" });
  // Without `since`, the whole `days` window counts; the CLI and the polling step pass `since` (MEET-3).
  const since = o.since ?? startOfDay(ctx.now(), o.days);
  const receipt: RunReceipt = {
    v: 1, id: newReceiptId("synthesize", ctx.now()), type: "synthesize", at: ctx.now().toISOString(), agent: ctx.agent, dryRun: !!o.dryRun,
    outcome: "no-signal", ...g.receipt, skills: [], model: null,
  };
  const result0: SynthResult = { posted: [], skipped: [], held: totalHeld(g.held), meetings: { processed: [], already: 0, busy: 0, before: 0 } };

  // The team's meeting ledger (MEET-2): skip meetings someone already processed, claim the rest.
  const plan = planMeetings(g.items, await svc.tracker.listMeetings(), since);
  const mark = (item: SignalItem, state: NonNullable<RunReceipt["sources"][number]["ledger"]>["state"], entry: string | null) => {
    const src = receipt.sources.find((x) => x.id === item.id);
    if (src) src.ledger = { state, entry };
  };
  for (const a of plan.already) mark(a.item, "already-processed", a.entry.identifier);
  for (const b of plan.before) mark(b, "before-window", null);
  result0.meetings.already = plan.already.length;
  result0.meetings.before = plan.before.length;

  const lodged: { item: SignalItem; entry: MeetingEntry; lease: string }[] = [];
  if (o.dryRun) for (const f of plan.fresh) mark(f.item, "would-process", f.entry?.identifier ?? null);
  else {
    for (const f of plan.fresh) {
      const lease = `meeting-${f.item.keys![0]}`;
      const got = await svc.lease.acquire(lease, ctx.agent, 1800);
      if (!got.ok) {
        mark(f.item, "in-progress-elsewhere", f.entry?.identifier ?? null);
        result0.meetings.busy++;
        continue;
      }
      const entry = f.entry ?? (await svc.tracker.lodgeMeeting({
        title: f.item.title, keys: f.item.keys!, at: f.item.at.slice(0, 10), source: f.item.origin?.source ?? "transcript file", agent: ctx.agent,
      }));
      mark(f.item, "processed-now", entry.identifier);
      lodged.push({ item: f.item, entry, lease });
    }
  }
  const work = [...plan.other, ...(o.dryRun ? plan.fresh.map((f) => f.item) : lodged.map((l) => l.item))];
  const release = async () => { for (const l of lodged) await svc.lease.release(l.lease, ctx.agent).catch(() => false); };
  // Polling (MEET-3): with nothing new, no model call and no receipt.
  if (o.skipIfNothingNew && !lodged.length && !(o.dryRun && plan.fresh.length)) return result0;
  if (!work.length) {
    await writeReceipt(receipt, ctx.now());
    return result0;
  }

  const [synthName, sizeName] = SKILL_USES.synthesize;
  const synth = await loadSkill(ctx.personal.repoPath, synthName);
  const rubric = await loadSkill(ctx.personal.repoPath, sizeName);
  receipt.skills = [
    { name: synthName, version: synth.version, source: synth.source },
    { name: sizeName, version: rubric.version, source: rubric.source },
  ];
  const categories = Object.keys(ctx.team.categories);
  const { tag, block } = dataBlock(work);
  const prompt = [
    skillBody(synth.text),
    "",
    "## Size rubric",
    skillBody(rubric.text),
    "",
    `Categories you may use: ${categories.join(", ")}.`,
    DATA_RULES(tag),
    "",
    block,
  ].join("\n");

  const result = await ctx.runtime.run({ team: ctx.team, cwd: ctx.personal.repoPath, prompt, tools: [], maxTurns: 1 });
  await updateState((s) => recordSpend(s, ctx.personal, ctx.now(), result.costUsd));
  receipt.model = {
    name: ctx.team.model, runtime: ctx.runtime.name, tools: "none: no files, no web, no personal Claude settings",
    costUsd: result.costUsd, tokens: result.tokens, durationMs: result.durationMs, promptSha256: createHash("sha256").update(prompt).digest("hex"),
  };
  if (!result.ok) {
    await writeReceipt({ ...receipt, outcome: "failed", error: result.error ?? "unknown" }, ctx.now());
    for (const l of lodged) await svc.tracker.finishMeeting(l.entry.id, { status: "blocked", tasks: [], note: `PMX couldn't process this meeting (${result.error ?? "the run failed"}). The next pass retries it.` }).catch(() => {});
    await release();
    throw new Error(`Synthesis run failed: ${result.error ?? "unknown"}`);
  }

  const { tasks, skipped } = parseCandidates(result.text, categories, new Set(work.map((i) => i.id)), parseRubric(rubric.text));
  const existing = new Set((await svc.tracker.list()).filter((t) => t.status !== "done").map((t) => norm(t.title)));
  const posted: SynthResult["posted"] = [];
  const bySource = new Map<string, string[]>();
  for (const c of tasks) {
    if (existing.has(norm(c.title))) { skipped.push(`${c.title}: already in the PMX project`); continue; }
    if (o.dryRun) { posted.push({ identifier: "(dry run)", title: c.title }); continue; }
    const t = await svc.tracker.createInbox({ title: c.title, description: describe(c, work), category: c.category, size: c.size, sources: c.sources });
    posted.push({ identifier: t.identifier, title: t.title });
    for (const id of c.sources) bySource.set(id, [...(bySource.get(id) ?? []), t.identifier]);
    existing.add(norm(c.title));
  }
  // Mark each lodged meeting complete in the tracker, with the tasks it produced (MEET-2).
  for (const l of lodged) {
    const made = bySource.get(l.item.id) ?? [];
    await svc.tracker.finishMeeting(l.entry.id, {
      status: "done", tasks: made,
      note: made.length ? `PMX processed this meeting: ${made.length} suggested task(s), ${made.join(", ")}. See why with \`pmx explain ${receipt.id}\` on ${ctx.agent}.` : "PMX processed this meeting: nothing in it fits a PMX task.",
    });
    result0.meetings.processed.push({ entry: l.entry.identifier, tasks: made });
  }
  await release();

  receipt.outcome = o.dryRun ? "dry-run" : "posted";
  receipt.synth = { tasks: tasks.map((c) => ({ title: c.title, category: c.category, size: c.size, sources: c.sources, sizing: c.sizing ?? null })), skipped };
  await writeReceipt(receipt, ctx.now());
  if (!o.dryRun) {
    await updateState((s) => (s.lastSynthAt = ctx.now().toISOString()));
    await new RunLogStore(ctx).record({
      type: "synthesize", agent: ctx.agent, machine: ctx.personal.machineId, posted: posted.length, held: totalHeld(g.held),
      durationMs: result.durationMs, tokens: result.tokens, costUsd: result.costUsd,
    });
  }
  return { ...result0, posted, skipped };
}
