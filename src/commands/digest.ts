import { notify } from "../core/notify.js";
import type { Asker } from "../core/ask.js";
import { isoWeek, type Ctx } from "../core/context.js";
import { totalHeld } from "../core/filter.js";
import { RunLogStore } from "../core/runlog-store.js";
import { updateState } from "../core/state.js";
import { buildDigest, discardStaged, readStaged, stagingPath } from "../digest/digest.js";
import { dmDigest, publishDigest } from "../digest/publish.js";
import { exec } from "../core/exec.js";
import { recordSpend } from "../budget/provider.js";
import { receiptSummary } from "../explain/format.js";

/**
 * `pmx digest`: build this week's digest, show it, and commit it only if the PM approves (DIG-2, PRIV-3).
 * `--stage` (used by the background job) builds and stages it without asking.
 * `--review` shows a staged digest for approval.
 */
export async function runDigest(ctx: Ctx, ask: Asker, o: { stage?: boolean; review?: boolean; days?: number; editor?: string }): Promise<string> {
  const log = new RunLogStore(ctx);
  const week = isoWeek(ctx.now());
  let markdown: string | null = null;

  if (o.review) {
    markdown = await readStaged(week);
    if (!markdown) return `No staged digest for ${week}. Run \`pmx digest\`.`;
  } else {
    const draft = await buildDigest(ctx, { days: o.days });
    if (!draft) return "Nothing to digest.";
    await updateState((s) => (s.lastDigestWeek = week));
    const held = totalHeld(draft.held);
    ctx.out.info(receiptSummary(draft.receipt));
    await log.record({
      type: "digest", agent: ctx.agent, machine: ctx.personal.machineId, outcome: "staged", items: draft.items, held,
      durationMs: draft.result.durationMs, tokens: draft.result.tokens, costUsd: draft.result.costUsd,
    });
    await updateState((s) => recordSpend(s, ctx.personal, ctx.now(), draft.result.costUsd));
    markdown = draft.markdown;
    if (o.stage) {
      await notify("Product Git", `Your ${week} digest is ready. Run: pmx digest --review`);
      return `Staged at ${stagingPath(week)}. Approve with \`pmx digest --review\`.`;
    }
  }

  ctx.out.info("\n" + markdown);
  const choice = await ask.choose("Approve this digest for the PMX repo?", ["approve", "edit", "reject"], "reject");
  if (choice === "edit") {
    const editor = o.editor ?? process.env.EDITOR ?? "vi";
    const { spawnSync } = await import("node:child_process");
    spawnSync(editor, [stagingPath(week)], { stdio: "inherit" });
    return runDigest(ctx, ask, { ...o, review: true });
  }
  if (choice === "reject") {
    await discardStaged(week);
    await log.record({ type: "digest", agent: ctx.agent, machine: ctx.personal.machineId, outcome: "rejected", items: 0, held: 0, durationMs: 0, tokens: null, costUsd: null });
    return "Rejected. The draft was deleted and nothing reached git.";
  }
  const pr = await publishDigest(ctx, week, markdown);
  await discardStaged(week);
  await log.record({ type: "digest", agent: ctx.agent, machine: ctx.personal.machineId, outcome: "approved", items: 0, held: 0, durationMs: 0, tokens: null, costUsd: null });
  const dm = await dmDigest(ctx, markdown).catch((e) => (ctx.out.warn(`Slack DM failed: ${e.message}`), false));
  return `Approved. ${pr.url.startsWith("branch:") ? `Committed on ${pr.url.slice(7)}` : `PR: ${pr.url}`}${dm ? " · sent to your Slack DMs" : ""}`;
}
