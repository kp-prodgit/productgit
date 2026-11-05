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

export interface SynthResult {
  posted: { identifier: string; title: string }[];
  skipped: string[];
  held: number;
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
export async function synthesize(ctx: Ctx, svc: Services, o: { days: number; dryRun?: boolean }): Promise<SynthResult> {
  const g = await gather(ctx, { days: o.days, scope: "team" });
  const receipt: RunReceipt = {
    v: 1, id: newReceiptId("synthesize", ctx.now()), type: "synthesize", at: ctx.now().toISOString(), agent: ctx.agent, dryRun: !!o.dryRun,
    outcome: "no-signal", ...g.receipt, skills: [], model: null,
  };
  if (!g.items.length) {
    await writeReceipt(receipt, ctx.now());
    return { posted: [], skipped: [], held: totalHeld(g.held) };
  }

  const [synthName, sizeName] = SKILL_USES.synthesize;
  const synth = await loadSkill(ctx.personal.repoPath, synthName);
  const rubric = await loadSkill(ctx.personal.repoPath, sizeName);
  receipt.skills = [
    { name: synthName, version: synth.version, source: synth.source },
    { name: sizeName, version: rubric.version, source: rubric.source },
  ];
  const categories = Object.keys(ctx.team.categories);
  const { tag, block } = dataBlock(g.items);
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
    throw new Error(`Synthesis run failed: ${result.error ?? "unknown"}`);
  }

  const { tasks, skipped } = parseCandidates(result.text, categories, new Set(g.items.map((i) => i.id)), parseRubric(rubric.text));
  const existing = new Set((await svc.tracker.list()).filter((t) => t.status !== "done").map((t) => norm(t.title)));
  const posted: SynthResult["posted"] = [];
  for (const c of tasks) {
    if (existing.has(norm(c.title))) { skipped.push(`${c.title}: already in the PMX project`); continue; }
    if (o.dryRun) { posted.push({ identifier: "(dry run)", title: c.title }); continue; }
    const t = await svc.tracker.createInbox({ title: c.title, description: describe(c, g.items), category: c.category, size: c.size, sources: c.sources });
    posted.push({ identifier: t.identifier, title: t.title });
    existing.add(norm(c.title));
  }
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
  return { posted, skipped, held: totalHeld(g.held) };
}
