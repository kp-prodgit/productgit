import { readJson, writeJson } from "./fsutil.js";
import { paths } from "./paths.js";

/** Personal machine state in `~/.pmx/state.json`. Never synced. */
export interface State {
  lastDigestWeek: string | null;
  lastSynthAt: string | null;
  /** Self-tracked spend ledger (PULL-5): day (YYYY-MM-DD, in budget-reset time) → USD. */
  ledger: Record<string, number>;
  eeTrialStartedAt: string | null;
  lastEventSyncAt: string | null;
  lastPipelineSyncAt: string | null;
  lastBrainAt: string | null;
  lastCollectAt: string | null;
  lastRollupAt: string | null;
  /** What the hosted app last said about CLI versions (COMPAT-5). */
  cloudVersions: { latest: string | null; min: string | null; seenAt: string } | null;
  /** The background auto-update (COMPAT-6): when it last looked, and what last happened. */
  autoUpdate: { checkedAt: string; result: string; version: string | null; notifiedFor: string | null } | null;
  /** The background job's last pass: which steps failed, and how many passes in a row had a failure. */
  lastTick: { at: string; failed: string[]; failStreak: number } | null;
  /** Each Claude scheduled task's last run, as PMX saw it: its `--prompt` call starts one, its last step finishes it. */
  taskRuns: Record<string, { startedAt: string; finishedAt: string | null }>;
  /** When this Mac's pmx started tracking task runs. Older runs left no record, so "never ran" counts from here. */
  taskRunsSince: string | null;
}

const EMPTY: State = { lastDigestWeek: null, lastSynthAt: null, ledger: {}, eeTrialStartedAt: null, lastEventSyncAt: null, lastPipelineSyncAt: null, lastBrainAt: null, lastCollectAt: null, lastRollupAt: null, cloudVersions: null, autoUpdate: null, lastTick: null, taskRuns: {}, taskRunsSince: null };

export async function loadState(): Promise<State> {
  return { ...EMPTY, ...((await readJson<Partial<State>>(paths.state())) ?? {}) };
}

export async function saveState(s: State): Promise<void> {
  // Keep 60 days of ledger.
  const days = Object.keys(s.ledger).sort();
  for (const d of days.slice(0, Math.max(0, days.length - 60))) delete s.ledger[d];
  await writeJson(paths.state(), s);
}

export async function updateState(fn: (s: State) => void): Promise<State> {
  const s = await loadState();
  fn(s);
  await saveState(s);
  return s;
}

/** Records a Claude scheduled task's run starting (its `--prompt` step) or finishing (its last step). Never throws. */
export async function markTaskRun(taskId: string, phase: "start" | "finish", now = new Date()): Promise<void> {
  await updateState((s) => {
    const at = now.toISOString();
    if (phase === "start") s.taskRuns = { ...s.taskRuns, [taskId]: { startedAt: at, finishedAt: null } };
    else if (s.taskRuns[taskId] && !s.taskRuns[taskId].finishedAt) s.taskRuns[taskId].finishedAt = at;
  }).catch(() => {});
}
