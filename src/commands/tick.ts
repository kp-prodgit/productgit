import { scriptedAsker } from "../core/ask.js";
import { isoWeek, type Ctx } from "../core/context.js";
import { killSwitchOn } from "../core/killswitch.js";
import { loadState } from "../core/state.js";
import { runDigest } from "./digest.js";

export type TickStep = (ctx: Ctx) => Promise<string | null>;

/** The digest step: on the PM's digest weekday, build and stage the digest once per week. */
export const digestStep: TickStep = async (ctx) => {
  const state = await loadState();
  const now = ctx.now();
  if (now.getDay() !== ctx.personal.digest.weekday) return null;
  if (state.lastDigestWeek === isoWeek(now)) return null;
  return runDigest(ctx, scriptedAsker({}), { stage: true });
};

/**
 * `pmx tick`, run by launchd every 30 minutes. Each step is independent: one failing
 * doesn't stop the others. The kill switch stops everything (SEC-6).
 */
export async function runTick(ctx: Ctx, steps: [string, TickStep][]): Promise<string[]> {
  const ks = await killSwitchOn(ctx.repo).catch(() => ({ on: false, reason: null }));
  if (ks.on) return [`kill switch on (${ks.reason}): nothing ran`];
  const out: string[] = [];
  for (const [name, step] of steps) {
    try {
      const r = await step(ctx);
      if (r) out.push(`${name}: ${r}`);
    } catch (e: any) {
      out.push(`${name}: failed: ${e.message}`);
    }
  }
  return out;
}
