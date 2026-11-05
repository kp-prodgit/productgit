import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { natural, enforceCitations } from "../core/citations.js";
import { isoWeek, type Ctx } from "../core/context.js";
import { totalHeld, type HoldReason } from "../core/filter.js";
import { privateDir, writeText } from "../core/fsutil.js";
import { paths } from "../core/paths.js";
import { DATA_RULES, dataBlock } from "../core/prompt.js";
import { newReceiptId, writeReceipt, type RunReceipt } from "../core/receipt.js";
import { loadSkill, skillBody, SKILL_USES } from "../core/skills.js";
import type { SignalItem } from "../core/types.js";
import type { RunResult } from "../runtime/types.js";
import { gather } from "./gather.js";

export interface DigestDraft {
  week: string;
  path: string;
  markdown: string;
  items: number;
  held: Record<HoldReason, number>;
  heldItems: number;
  removedClaims: number;
  result: RunResult;
  /** Read and used counts and the receipt, for the terminal summary and `pmx explain`. */
  read: number;
  receipt: RunReceipt;
}

export function stagingPath(week: string): string {
  return join(paths.staging(), `digest-${week}.md`);
}

function sourceList(items: SignalItem[], used: string[]): string {
  const byId = new Map(items.map((i) => [i.id, i]));
  return used
    .map((id) => {
      const i = byId.get(id)!;
      const where = i.kind === "slack" ? i.ref : basename(i.ref);
      return `- **[${id}]** ${i.title} (${i.at.slice(0, 10)}) — ${where}`;
    })
    .join("\n");
}

/**
 * Builds the weekly digest (DIG-1) and stages it outside git (PRIV-3).
 * The model gets no tools at all: it reads redacted source text as data and writes text back (SEC-1).
 */
export async function buildDigest(ctx: Ctx, o: { days?: number } = {}): Promise<DigestDraft | null> {
  const week = isoWeek(ctx.now());
  const g = await gather(ctx, { days: o.days ?? 7, scope: "personal" });
  const receipt: RunReceipt = {
    v: 1, id: newReceiptId("digest", ctx.now()), type: "digest", at: ctx.now().toISOString(), agent: ctx.agent, outcome: "no-signal",
    ...g.receipt, skills: [], model: null,
  };
  if (g.items.length === 0) {
    await writeReceipt(receipt, ctx.now());
    ctx.out.info(`No usable signal in the last ${o.days ?? 7} days (${g.read} found, ${totalHeld(g.held)} left out or cut). See why: pmx explain`);
    return null;
  }

  const skill = await loadSkill(ctx.personal.repoPath, SKILL_USES.digest[0]!);
  receipt.skills = [{ name: SKILL_USES.digest[0]!, version: skill.version, source: skill.source }];
  const { tag, block } = dataBlock(g.items);
  const prompt = [
    skillBody(skill.text),
    "",
    DATA_RULES(tag),
    "",
    `Week: ${week}. Source IDs you may cite: ${g.items.map((i) => i.id).join(", ")}.`,
    "",
    block,
  ].join("\n");

  const result = await ctx.runtime.run({
    team: ctx.team,
    cwd: ctx.personal.repoPath,
    prompt,
    tools: [],
    maxTurns: 1,
  });
  receipt.model = {
    name: ctx.team.model, runtime: ctx.runtime.name, tools: "none: no files, no web, no personal Claude settings",
    costUsd: result.costUsd, tokens: result.tokens, durationMs: result.durationMs,
    promptSha256: createHash("sha256").update(prompt).digest("hex"),
  };
  if (!result.ok) {
    await writeReceipt({ ...receipt, outcome: "failed", error: result.error ?? "unknown error" }, ctx.now());
    throw new Error(`Digest run failed: ${result.error ?? "unknown error"}`);
  }

  const checked = enforceCitations(result.text, new Set(g.items.map((i) => i.id)));
  const markdown = [
    `# Signal digest · ${week}`,
    "",
    `_Drafted by Product Git for ${ctx.personal.handle}. ${g.items.length} sources; ${totalHeld(g.held)} personal items held back and discarded; ${checked.removed} uncited claims removed._`,
    "",
    checked.text.replace(/^#\s.*\n/, "").trim(),
    "",
    "## Sources",
    "",
    sourceList(g.items, checked.used.sort(natural)),
    "",
  ].join("\n");

  const path = stagingPath(week);
  await privateDir(paths.staging());
  await writeText(path, markdown, 0o600);
  receipt.outcome = "staged";
  receipt.digest = { cited: checked.used, removedClaims: checked.removed, staged: path };
  await writeReceipt(receipt, ctx.now());
  return { week, path, markdown, items: g.items.length, held: g.held, heldItems: g.heldItems, removedClaims: checked.removed, result, read: g.read, receipt };
}

export async function readStaged(week: string): Promise<string | null> {
  return readFile(stagingPath(week), "utf8").catch(() => null);
}

/** Rejected or committed: either way the staged copy is deleted. */
export async function discardStaged(week: string): Promise<void> {
  await rm(stagingPath(week), { force: true });
}
