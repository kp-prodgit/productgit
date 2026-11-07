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
  /** The personal daily cap that applied each ledger day, so the flow view shows past days against their own cap (FLOW-1). */
  caps: Record<string, number>;
  /**
   * What each collection run skipped before saving anything (FLOW-1), as counts only: meetings the Claude task
   * never wrote because of the do-not-read list leave no other trace on this Mac. Newest last, 14 days.
   */
  collectReports: { at: string; connector: string | null; saved: number; skipped: Record<CollectSkip, number> }[];
  /** When this Mac's pmx started tracking task runs. Older runs left no record, so "never ran" counts from here. */
  taskRunsSince: string | null;
}

const EMPTY: State = { lastDigestWeek: null, lastSynthAt: null, ledger: {}, eeTrialStartedAt: null, lastEventSyncAt: null, lastPipelineSyncAt: null, lastBrainAt: null, lastCollectAt: null, lastRollupAt: null, cloudVersions: null, autoUpdate: null, lastTick: null, taskRuns: {}, taskRunsSince: null, caps: {}, collectReports: [] };

/** Why the collection task skipped a meeting without saving it. */
export const COLLECT_SKIPS = ["never-ingest-title", "never-ingest-person", "no-transcript", "already-collected", "outside-window"] as const;
export type CollectSkip = (typeof COLLECT_SKIPS)[number];

export async function loadState(): Promise<State> {
  return { ...EMPTY, ...((await readJson<Partial<State>>(paths.state())) ?? {}) };
}

export async function saveState(s: State): Promise<void> {
  // Keep 60 days of ledger.
  const days = Object.keys(s.ledger).sort();
  for (const d of days.slice(0, Math.max(0, days.length - 60))) delete s.ledger[d];
  for (const d of Object.keys(s.caps ?? {}).sort().slice(0, Math.max(0, Object.keys(s.caps ?? {}).length - 60))) delete s.caps[d];
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString();
  s.collectReports = (s.collectReports ?? []).filter((r) => r.at >= cutoff).slice(-200);
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
