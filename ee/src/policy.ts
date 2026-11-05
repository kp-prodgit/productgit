// Product Git Commercial License. See ee/LICENSE.
import type { PersonalConfig, TeamConfig } from "../../src/core/config.js";
import type { Size } from "../../src/core/types.js";
import { readJson, writeJson } from "../../src/core/fsutil.js";
import { paths } from "../../src/core/paths.js";
import type { Cloud } from "../../src/cloud/client.js";

export interface Policy {
  version: number;
  updatedAt: string;
  allowedCategories: string[];
  allowedSources: ("transcripts" | "slack")[];
  allowedPlans: string[];
  egressAllowlist: string[];
  model?: string;
  reviewQueueCap?: number;
  teamDefaults?: { repo?: string; linearTeamKey?: string; linearProjectId?: string };
  /** The brain's permission (BRAIN-1). Absent means off. */
  brain?: BrainPolicy;
}

export const BRAIN_ACTIONS = ["make-ready", "set-priority", "set-size", "start-run", "release", "pause-category", "hold"] as const;
export type BrainAction = (typeof BRAIN_ACTIONS)[number];

export interface BrainPolicy {
  level: "off" | "recommend" | "approve" | "autopilot";
  /** Agent handle of the one machine that runs the brain; null means the team's synthesizer. */
  machine: string | null;
  everyHours: number;
  autopilot: {
    actions: Exclude<BrainAction, "hold">[];
    maxSize: Size;
    /** Empty means every allowed category. */
    categories: string[];
    maxRunsPerDay: number;
  };
}

export const BRAIN_OFF: BrainPolicy = {
  level: "off", machine: null, everyHours: 4,
  autopilot: { actions: [], maxSize: "S", categories: [], maxRunsPerDay: 0 },
};

interface Cached {
  fetchedAt: string;
  orgId: string;
  policy: Policy;
}

const FRESH_MS = 60 * 60 * 1000;
const STALE_MS = 7 * 86400000;

/**
 * Gets the admin policy (ADMIN-2): from cache if under an hour old, else from the control plane.
 * If the server can't be reached and the cache is over 7 days old, it fails closed.
 */
export async function getPolicy(cloud: Cloud, orgId: string, now: Date): Promise<Policy> {
  const cached = await readJson<Cached>(paths.policy());
  const age = cached && cached.orgId === orgId ? now.getTime() - Date.parse(cached.fetchedAt) : Infinity;
  if (age < FRESH_MS) return cached!.policy;
  try {
    const policy = await cloud.call<Policy>("GET", `/orgs/${orgId}/policy`);
    await writeJson(paths.policy(), { fetchedAt: now.toISOString(), orgId, policy } satisfies Cached, 0o600);
    return policy;
  } catch (e: any) {
    if (age < STALE_MS) return cached!.policy;
    throw new Error(`Can't reach the Product Git control plane and the cached admin policy is missing or over 7 days old, so runs are stopped (fail closed): ${e.message}`);
  }
}

const meet = <T>(a: T[], b: T[]) => (b.length ? a.filter((x) => b.includes(x)) : a);

/**
 * Applies policy as an intersection with team config: something is allowed only if both allow it.
 * Returns why runs must stop, if the PM's model plan isn't allowed.
 */
export function applyPolicy(team: TeamConfig, personal: PersonalConfig, p: Policy): { team: TeamConfig; blockRuns: string | null } {
  const categories = Object.fromEntries(Object.entries(team.categories).filter(([c]) => !p.allowedCategories.length || p.allowedCategories.includes(c)));
  const out: TeamConfig = {
    ...team,
    categories,
    allowedSources: meet(team.allowedSources, p.allowedSources),
    egress: meet(team.egress, p.egressAllowlist),
    model: p.model ?? team.model,
    reviewQueueCap: p.reviewQueueCap ?? team.reviewQueueCap,
  };
  const blockRuns = p.allowedPlans.length && !p.allowedPlans.includes(personal.plan)
    ? `your model plan "${personal.plan}" isn't allowed by your admin's policy (allowed: ${p.allowedPlans.join(", ")})`
    : null;
  return { team: out, blockRuns };
}
