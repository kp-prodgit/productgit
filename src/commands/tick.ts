import { scriptedAsker } from "../core/ask.js";
import { isoWeek, type Ctx } from "../core/context.js";
import { killSwitchOn } from "../core/killswitch.js";
import { loadState, updateState } from "../core/state.js";
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

/** Saves the pass's failures, so `pmx status` and `pmx doctor` show a job that keeps failing. Never throws. */
export async function recordTick(lines: string[], now = new Date()): Promise<void> {
  const failed = lines.filter((l) => /^[\w-]+: failed: /.test(l));
  await updateState((s) => {
    s.lastTick = { at: now.toISOString(), failed, failStreak: failed.length ? (s.lastTick?.failStreak ?? 0) + 1 : 0 };
  }).catch(() => {});
}

/** What `pmx status` and `pmx doctor` say about the background job's recent passes. Null before its first pass. */
export function tickHealth(t: { at: string; failed: string[]; failStreak: number } | null, minStreak = 3): { ok: boolean; detail: string } | null {
  if (!t) return null;
  const when = t.at.slice(0, 16).replace("T", " ");
  if (!t.failed.length) return { ok: true, detail: `background job's last pass ${when} UTC: no failures` };
  const first = (t.failed[0] ?? "").slice(0, 300);
  return {
    ok: t.failStreak < minStreak,
    detail: `background job failed ${t.failStreak} pass${t.failStreak === 1 ? "" : "es"} in a row (last ${when} UTC): ${first}. Log: ~/.pmx/logs/tick.log`,
  };
}
