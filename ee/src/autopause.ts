// Product Git Commercial License. See ee/LICENSE.
import type { TeamConfig } from "../../src/core/config.js";
import type { Ctx } from "../../src/core/context.js";
import type { RunLogEntry } from "../../src/core/runlog.js";
import { RunLogStore } from "../../src/core/runlog-store.js";
import { acceptStats } from "../../src/review/queue.js";

/**
 * Auto-pause (REV-3): a category whose accept rate falls below the threshold (default 30%) over
 * the window, with at least `minVerdicts` decisions, stops being pulled until someone unpauses it.
 * Computed from the team's run log, so every machine reaches the same answer. A brain pause
 * (BRAIN-2) holds until a later unpause.
 */
export function pausedFrom(entries: RunLogEntry[], team: Pick<TeamConfig, "autoPause">, now: Date): Map<string, string> {
  const { minVerdicts, threshold, windowDays } = team.autoPause;
  const out = new Map<string, string>();
  const manual = new Map<string, Extract<RunLogEntry, { type: "pause" }> | null>();
  for (const e of entries) {
    if (e.type === "pause") manual.set(e.category, e);
    else if (e.type === "unpause") manual.set(e.category, null);
  }
  for (const [cat, p] of manual)
    if (p) out.set(cat, `paused by the PMX brain on ${p.ts.slice(0, 10)} (${p.rule}); unpause with \`pmx review --unpause ${cat}\``);
  for (const [cat, s] of Object.entries(acceptStats(entries, now, windowDays))) {
    if (s.total >= minVerdicts && s.rate < threshold)
      out.set(cat, `accept rate ${(s.rate * 100).toFixed(0)}% over ${s.total} reviews (auto-pause below ${(threshold * 100).toFixed(0)}%); unpause with \`pmx review --unpause ${cat}\``);
  }
  return out;
}

export async function autoPaused(ctx: Ctx): Promise<Map<string, string>> {
  const store = new RunLogStore(ctx);
  if (!(await store.exists())) return new Map();
  return pausedFrom(await store.entries(), ctx.team, ctx.now());
}

export async function unpause(ctx: Ctx, category: string): Promise<string> {
  if (!ctx.team.categories[category]) throw new Error(`Unknown category ${category}.`);
  await new RunLogStore(ctx).record({ type: "unpause", agent: ctx.agent, machine: ctx.personal.machineId, category });
  return `Unpaused ${category}. Its accept rate starts fresh from now.`;
}
