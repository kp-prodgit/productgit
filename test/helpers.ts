import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TEAM, type PersonalConfig, type TeamConfig } from "../src/core/config.js";
import { makeCtx, type Ctx, type Out } from "../src/core/context.js";
import { exec, execOk } from "../src/core/exec.js";
import { memoryKeychain, type Keychain } from "../src/core/keychain.js";
import { fakeLaunchd } from "../src/core/launchd.js";
import { writeProfile } from "../src/core/profile.js";
import { scaffoldRepo } from "../src/core/scaffold.js";
import type { AgentRuntime } from "../src/runtime/types.js";
import { mockRuntime } from "../src/runtime/mock.js";

export async function tmp(prefix = "pmx-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Points PMX_HOME at a fresh temp dir so tests never touch ~/.pmx. */
export async function freshHome(): Promise<string> {
  const h = await tmp("pmx-home-");
  process.env.PMX_HOME = h;
  return h;
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execOk("git", args, { cwd })).trim();
}

export async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.name", "Test");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "commit.gpgsign", "false");
}

/** A bare "origin" plus a scaffolded PMX repo clone pushed to it. */
export async function pmxRepo(team: Partial<TeamConfig> = {}, opts: { remote?: boolean } = {}): Promise<{ repo: string; origin: string | null }> {
  const root = await tmp("pmx-repo-");
  const repo = join(root, "pmx");
  await initRepo(repo);
  await scaffoldRepo(repo, { team: "test", ...team });
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "init");
  let origin: string | null = null;
  if (opts.remote) {
    origin = join(root, "origin.git");
    await execOk("git", ["init", "-q", "--bare", "-b", "main", origin]);
    await git(repo, "remote", "add", "origin", origin);
    await git(repo, "push", "-q", "-u", "origin", "main");
    await git(repo, "remote", "set-head", "origin", "main");
  }
  return { repo, origin };
}

export function personal(repoPath: string, over: Partial<PersonalConfig> = {}): PersonalConfig {
  return {
    version: 1,
    handle: "ana",
    machineId: "m1",
    repoPath,
    installedAt: "2026-01-01T00:00:00.000Z",
    plan: "team",
    categories: Object.keys(DEFAULT_TEAM.categories),
    workingHours: { days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" },
    budget: { dailyUsd: 10, resetHour: 0, overrideUsd: null },
    sources: { transcriptDirs: [], slackChannel: null },
    neverIngest: { people: [], channels: [], meetingTitles: [] },
    crmNamesFile: null,
    digest: { weekday: 5, slackDmUserId: null },
    ...over,
  };
}

export const quietOut = (): Out & { lines: string[] } => {
  const lines: string[] = [];
  return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(`WARN ${m}`), error: (m) => lines.push(`ERR ${m}`) };
};

export async function testCtx(o: {
  repo: string;
  team?: Partial<TeamConfig>;
  personal?: Partial<PersonalConfig>;
  runtime?: AgentRuntime;
  keychain?: Keychain;
  fetch?: typeof fetch;
  now?: Date;
}): Promise<Ctx & { out: ReturnType<typeof quietOut> }> {
  const team: TeamConfig = { ...DEFAULT_TEAM, team: "test", ...o.team } as TeamConfig;
  await writeProfile(team);
  const out = quietOut();
  return makeCtx({
    team,
    personal: personal(o.repo, o.personal),
    runtime: o.runtime ?? mockRuntime(() => ""),
    keychain: o.keychain ?? memoryKeychain(),
    launchd: fakeLaunchd(),
    fetch: o.fetch ?? (async () => { throw new Error("network disabled in tests"); }) as any,
    exec,
    now: () => o.now ?? new Date("2026-11-06T10:00:00Z"),
    out,
  }) as Ctx & { out: ReturnType<typeof quietOut> };
}

export async function writeTranscript(dir: string, name: string, body: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const p = join(dir, name);
  await writeFile(p, body);
  return p;
}
