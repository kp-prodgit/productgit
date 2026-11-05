import type { Ctx } from "../core/context.js";
import { killSwitchOn } from "../core/killswitch.js";
import { RunLogStore } from "../core/runlog-store.js";
import { loadState } from "../core/state.js";
import { budget } from "../budget/provider.js";

export async function runStatus(ctx: Ctx, extra: string[] = []): Promise<string> {
  const lines: string[] = [];
  const { team, personal } = ctx;
  lines.push(`Team ${team.team} · agent ${ctx.agent} · model ${team.model}`);
  lines.push(`PMX repo: ${personal.repoPath}`);
  const ks = await killSwitchOn(ctx.repo).catch(() => ({ on: false, reason: null }));
  lines.push(ks.on ? `Kill switch: ON (${ks.reason})` : "Kill switch: off");

  const state = await loadState();
  const b = budget(personal, team, state, ctx.now());
  lines.push(`Spend today: $${b.spentUsd.toFixed(2)} of $${b.capUsd.toFixed(2)} (${b.source}); resets in ${Math.floor(b.minutesToReset / 60)}h ${b.minutesToReset % 60}m`);
  lines.push(`Last digest: ${state.lastDigestWeek ?? "never"}`);

  const store = new RunLogStore(ctx);
  if (await store.exists()) {
    const entries = (await store.entries()).filter((e) => e.agent === ctx.agent);
    const last = entries.at(-1);
    lines.push(`Run log: ${entries.length} entries from this agent${last ? `, last ${last.type} at ${last.ts}` : ""}`);
  } else lines.push("Run log: no entries yet");
  lines.push(...extra);
  return lines.join("\n");
}
