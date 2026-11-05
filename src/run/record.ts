import type { TeamConfig } from "../core/config.js";
import { envFingerprint, profileChecks } from "../core/profile.js";

/**
 * The run record (B5, NEUT-3). Committed with every output at `.pmx/runs/<task>.json`, so anyone
 * can check that the draft came from a clean, neutral run. CI recomputes the fingerprint.
 */
export interface RunRecord {
  version: 1;
  provenance: "pmx-run";
  task: { id: string; identifier: string; category: string; size: string; sources: string[] };
  agent: string;
  machine: string;
  runtime: { name: string; version: string | null };
  model: string;
  profile: { checksPassed: string[]; checksFailed: string[]; fingerprint: string };
  skill: { name: string; version: string; commit: string | null };
  context: { claudeMdCommit: string | null; memoryCommit: string | null; baseCommit: string };
  lease: { kind: "git" | "cloud"; token: string };
  startedAt: string;
  durationMs: number;
  tokens: number | null;
  costUsd: number | null;
  outcome: "ok" | "failed" | "capped";
  checklist: { ok: boolean; problems: string[] };
}

export async function profileSummary(repoPath: string, team: TeamConfig): Promise<RunRecord["profile"]> {
  const checks = await profileChecks(team);
  return {
    checksPassed: checks.filter((c) => c.ok).map((c) => c.id),
    checksFailed: checks.filter((c) => !c.ok).map((c) => c.id),
    fingerprint: await envFingerprint(repoPath, team),
  };
}

export const REQUIRED_CHECKS = [
  "profile.dir", "profile.settings", "profile.model", "profile.memory-off", "profile.connectors-off", "profile.no-bypass",
  "profile.reads-limited", "profile.sandbox", "profile.egress", "profile.strict-mcp", "profile.invocation",
];

export interface RecordVerdict {
  ok: boolean;
  problems: string[];
}

/** What CI checks on every PR that adds an output (B5). `expectedFingerprint` is recomputed from the PR's base. */
export function verifyRecord(r: RunRecord, team: TeamConfig, expectedFingerprint: string): RecordVerdict {
  const problems: string[] = [];
  if (r.version !== 1 || r.provenance !== "pmx-run") problems.push("not a pmx-run record");
  for (const c of REQUIRED_CHECKS) if (!r.profile?.checksPassed?.includes(c)) problems.push(`clean-profile check ${c} not passed`);
  if (r.profile?.checksFailed?.length) problems.push(`failed checks: ${r.profile.checksFailed.join(", ")}`);
  if (r.model !== team.model) problems.push(`model ${r.model} is not the team model ${team.model}`);
  if (r.profile?.fingerprint !== expectedFingerprint) problems.push("environment fingerprint doesn't match the repo's CLAUDE.md, project settings and team profile");
  if (!r.skill?.version) problems.push("skill version missing");
  if (!r.task?.category || !team.categories[r.task.category]) problems.push(`category ${r.task?.category} not in team config`);
  else if (team.categories[r.task.category]!.skill !== r.skill.name) problems.push(`skill ${r.skill.name} doesn't match category ${r.task.category}`);
  return { ok: problems.length === 0, problems };
}
