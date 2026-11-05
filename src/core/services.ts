import { gitRefLease } from "../lease/git-ref.js";
import type { LeaseProvider } from "../lease/types.js";
import { linearTracker } from "../tracker/linear.js";
import { memoryTracker, type Tracker } from "../tracker/types.js";
import type { Ctx } from "./context.js";
import type { PersonalConfig, TeamConfig } from "./config.js";

export interface Services {
  tracker: Tracker;
  lease: LeaseProvider;
  /** Categories blocked by admin policy or auto-paused, with the reason. */
  paused(): Promise<Map<string, string>>;
}

type Factory<T> = (ctx: Ctx) => Promise<T | null>;

export type TeamTransform = (team: TeamConfig, personal: PersonalConfig) => Promise<{ team: TeamConfig; blockRuns: string | null }>;
const transforms: TeamTransform[] = [];

/** ee/ registers admin policy here. It narrows team config before any command uses it. */
export function registerTeamTransform(t: TeamTransform): void {
  transforms.push(t);
}

export async function effectiveTeam(team: TeamConfig, personal: PersonalConfig): Promise<{ team: TeamConfig; blockRuns: string | null }> {
  let cur = team;
  let blockRuns: string | null = null;
  for (const t of transforms) {
    const r = await t(cur, personal);
    cur = r.team;
    blockRuns ??= r.blockRuns;
  }
  return { team: cur, blockRuns };
}

export type ProjectRef = { teamKey: string; projectId: string };
type ProjectFactory = (ctx: Ctx, p: ProjectRef) => Promise<Tracker | null>;

/** ee/ registers the cloud lease, the brokered Linear token, policy and auto-pause here. */
const overrides: { tracker?: Factory<Tracker>; lease?: Factory<LeaseProvider>; paused?: ((ctx: Ctx) => Promise<Map<string, string>>)[]; project?: ProjectFactory } = { paused: [] };

export function registerServices(o: { tracker?: Factory<Tracker>; lease?: Factory<LeaseProvider>; paused?: (ctx: Ctx) => Promise<Map<string, string>>; project?: ProjectFactory }): void {
  if (o.tracker) overrides.tracker = o.tracker;
  if (o.project) overrides.project = o.project;
  if (o.lease) overrides.lease = o.lease;
  if (o.paused) overrides.paused!.push(o.paused);
}

export async function services(ctx: Ctx, test?: Partial<Services>): Promise<Services> {
  const tracker = test?.tracker ?? (await overrides.tracker?.(ctx)) ?? (await defaultTracker(ctx));
  const lease = test?.lease ?? (await overrides.lease?.(ctx)) ?? gitRefLease(ctx.repo, ctx.now);
  return {
    tracker,
    lease,
    paused:
      test?.paused ??
      (async () => {
        const m = new Map<string, string>();
        for (const f of overrides.paused ?? []) for (const [k, v] of await f(ctx)) m.set(k, v);
        return m;
      }),
  };
}

/** A read-mostly tracker for another team's PMX project (COMPANY-1). Same token as this team's. */
export async function projectTracker(ctx: Ctx, p: ProjectRef): Promise<Tracker> {
  const viaEe = await overrides.project?.(ctx, p);
  if (viaEe) return viaEe;
  const token = await ctx.keychain.get("linear-token");
  if (!token) throw new Error("No Linear token in the keychain. Run `pmx init`, or `pmx login` if your team uses the control plane.");
  return linearTracker({ token, teamKey: p.teamKey, projectId: p.projectId, fetch: ctx.fetch });
}

async function defaultTracker(ctx: Ctx): Promise<Tracker> {
  const t = ctx.team.tracker;
  if (t.kind !== "linear") {
    ctx.out.warn("No tracker configured in pmx.config.json; using an empty in-memory queue.");
    return memoryTracker();
  }
  const token = await ctx.keychain.get("linear-token");
  if (!token) throw new Error("No Linear token in the keychain. Run `pmx init`, or `pmx login` if your team uses the control plane.");
  return linearTracker({ token, teamKey: t.teamKey, projectId: t.projectId, fetch: ctx.fetch });
}
