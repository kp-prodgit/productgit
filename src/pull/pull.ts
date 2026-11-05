import { budget } from "../budget/provider.js";
import type { Ctx } from "../core/context.js";
import { killSwitchOn } from "../core/killswitch.js";
import { RunLogStore } from "../core/runlog-store.js";
import type { Services } from "../core/services.js";
import { loadState } from "../core/state.js";
import type { Task } from "../core/types.js";
import { leaseTtlSeconds } from "../lease/types.js";
import { runTask, type RunOutcome } from "../run/run.js";
import { explain, selectTasks, type Selection } from "./select.js";

export interface PullResult {
  dryRun: boolean;
  selection: Selection | null;
  text: string;
  ran: RunOutcome | null;
}

/** `--dry-run` is the default for the first week after install (PULL-9). */
export function isDryRunDefault(ctx: Ctx): boolean {
  return ctx.now().getTime() - new Date(ctx.personal.installedAt).getTime() < 7 * 86400000;
}

export async function plan(ctx: Ctx, svc: Services): Promise<Selection> {
  const [tasks, leases, paused, state] = await Promise.all([svc.tracker.list(), svc.lease.list(), svc.paused(), loadState()]);
  const now = ctx.now();
  const live = new Set(leases.filter((l) => l.holder !== ctx.agent && new Date(l.expiresAt) > now).map((l) => l.taskId));
  return selectTasks({
    tasks,
    agent: ctx.agent,
    personal: ctx.personal,
    team: ctx.team,
    budget: budget(ctx.personal, ctx.team, state, now),
    now,
    inReview: tasks.filter((t) => t.status === "review" && t.agent === ctx.agent).length,
    pausedCategories: paused,
    leasedTaskIds: live,
  });
}

/** Claims a task: lease first (atomic), then mark it in the tracker. */
export async function claim(ctx: Ctx, svc: Services, task: Task) {
  const ttl = leaseTtlSeconds(ctx.team.sizes[task.size ?? "M"].minutes);
  const got = await svc.lease.acquire(task.id, ctx.agent, ttl);
  if (!got.ok) return got;
  // Re-check after winning: someone may have moved it out of ready since we listed.
  const fresh = await svc.tracker.get(task.id);
  if (fresh.status !== "ready") {
    await svc.lease.release(task.id, ctx.agent);
    return { ok: false as const, holder: "tracker", expiresAt: "" , reason: `status is now ${fresh.status}` };
  }
  await svc.tracker.setAgent(task.id, ctx.agent);
  await svc.tracker.setStatus(task.id, "claimed");
  return got;
}

/**
 * `pmx pull` (PULL-1). Checks the kill switch, then the policy, then tries candidates in order
 * until one lease is won, and runs it. One task per pull.
 */
export async function pull(ctx: Ctx, svc: Services, o: { dryRun: boolean }): Promise<PullResult> {
  const ks = await killSwitchOn(ctx.repo);
  if (ks.on) return { dryRun: o.dryRun, selection: null, text: `Kill switch is on (${ks.reason}). Nothing pulled.`, ran: null };
  const sel = await plan(ctx, svc);
  const text = explain(sel, o.dryRun);
  if (o.dryRun || !sel.candidates.length) return { dryRun: o.dryRun, selection: sel, text, ran: null };

  for (const task of sel.candidates) {
    const got = await claim(ctx, svc, task);
    if (!got.ok) {
      ctx.out.info(`${task.identifier} was claimed by ${got.holder} first; trying the next one.`);
      continue;
    }
    const ran = await runTask(ctx, svc, { ...task, agent: ctx.agent, status: "claimed" }, got.lease);
    return { dryRun: false, selection: sel, text: `${text}\n\n${ran.message}`, ran };
  }
  return { dryRun: false, selection: sel, text: `${text}\n\nEvery candidate was claimed by someone else.`, ran: null };
}

/**
 * Releases leases older than their TTL on tasks that aren't running (PULL-7), and puts the task back
 * to ready. Any machine may do this.
 */
export async function releaseStale(ctx: Ctx, svc: Services): Promise<string[]> {
  const now = ctx.now();
  const out: string[] = [];
  const log = new RunLogStore(ctx);
  for (const l of await svc.lease.list()) {
    if (new Date(l.expiresAt) > now) continue;
    const task = await svc.tracker.get(l.taskId).catch(() => null);
    if (task?.status === "running") continue;
    if (!(await svc.lease.forceRelease(l.taskId, l.token))) continue;
    if (task && (task.status === "claimed" || task.status === null)) {
      await svc.tracker.setAgent(task.id, null);
      await svc.tracker.setStatus(task.id, "ready");
    }
    await log.record({ type: "release", agent: ctx.agent, machine: ctx.personal.machineId, taskId: task?.identifier ?? l.taskId, reason: "stale" });
    out.push(`released stale claim on ${task?.identifier ?? l.taskId} (held by ${l.holder} since ${l.acquiredAt})`);
  }
  return out;
}
