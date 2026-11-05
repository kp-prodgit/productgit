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
}

const EMPTY: State = { lastDigestWeek: null, lastSynthAt: null, ledger: {}, eeTrialStartedAt: null, lastEventSyncAt: null, lastPipelineSyncAt: null, lastBrainAt: null, lastCollectAt: null, lastRollupAt: null, cloudVersions: null };

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
