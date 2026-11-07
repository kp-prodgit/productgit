import { chmod, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";
import { COLLECT_TASK, nextCronTime, taskFile, taskRunHealth } from "../src/claude/tasks.js";
import { runDoctor } from "../src/commands/doctor.js";
import { recordTick, tickHealth } from "../src/commands/tick.js";
import { claudeAbsolutePath, profileSignedIn } from "../src/core/claude-bin.js";
import { exec, type Exec } from "../src/core/exec.js";
import { memoryKeychain } from "../src/core/keychain.js";
import { fakeLaunchd, jobEnv, plist } from "../src/core/launchd.js";
import { paths } from "../src/core/paths.js";
import { loadState, markTaskRun } from "../src/core/state.js";
import { claudeCode } from "../src/runtime/claude-code.js";
import { freshHome, tmp } from "./helpers.js";

const root = new URL("..", import.meta.url).pathname;
const team = { egress: ["api.anthropic.com"], model: "claude-sonnet-5-5", caps: { perRunUsd: 1 } } as any;

/** Claude Code on PATH, answering `--version`, `auth status` and `-p` the way the tester's Mac did. */
function fakeClaude(o: { loggedIn?: boolean; run?: object }): Exec {
  return async (cmd, args, opts) => {
    if (cmd !== "claude") return exec(cmd, args, opts);
    if (args[0] === "--version") return { stdout: "2.1.300 (Claude Code)", stderr: "", code: 0 };
    if (args[0] === "auth") return { stdout: JSON.stringify({ loggedIn: o.loggedIn ?? true, authMethod: o.loggedIn === false ? "none" : "claude.ai" }), stderr: "", code: o.loggedIn === false ? 1 : 0 };
    return { stdout: JSON.stringify(o.run ?? {}), stderr: "", code: 0 };
  };
}

describe("0.10.1: runs that fail say why, and doctor catches it first", () => {
  beforeEach(async () => {
    await freshHome();
    process.env.PMX_CLAUDE_HOME = await tmp("claude-home-");
  });

  it("shows Claude's own error text when a run fails, never \"success\"", async () => {
    const notLoggedIn = { type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", terminal_reason: "api_error", duration_ms: 12 };
    const r = await claudeCode(fakeClaude({ run: notLoggedIn })).run({ team, cwd: ".", prompt: "say ok", tools: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Not logged in");
    expect(r.error).toContain("pmx claude login");
    expect(r.error).not.toMatch(/^success$/);

    const capped = await claudeCode(fakeClaude({ run: { subtype: "error_max_turns", is_error: false, result: "" } })).run({ team, cwd: ".", prompt: "x", tools: [] });
    expect(capped).toMatchObject({ ok: false, capped: true, error: "error_max_turns" });
  });

  it("checks that PMX's own Claude profile is signed in, in doctor and before runs", async () => {
    expect(await profileSignedIn(fakeClaude({ loggedIn: true }))).toMatchObject({ ok: true });
    expect(await profileSignedIn(fakeClaude({ loggedIn: false }))).toMatchObject({ ok: false, detail: expect.stringContaining("pmx claude login") });
    // An older Claude Code without `auth status` can't say: no check rather than a false alarm.
    const old: Exec = async (cmd, args, o) => (cmd === "claude" ? { stdout: "2.1.0 (Claude Code)", stderr: "", code: args[0] === "--version" ? 0 : 1 } : exec(cmd, args, o));
    expect(await profileSignedIn(old)).toBeNull();

    const checks = await runDoctor({ personal: null, team: null, keychain: memoryKeychain(), launchd: fakeLaunchd(), exec: fakeClaude({ loggedIn: false }) });
    expect(checks.find((c) => c.id === "profile.signed-in")).toMatchObject({ ok: false, level: "fail" });
    const probe = await claudeCode(fakeClaude({ loggedIn: false })).probe(team);
    expect(probe.problems.join(" ")).toContain("isn't signed in");
  });

  it("gives the background job the Claude Code an nvm install put outside its PATH", async () => {
    const bin = join(await tmp("nvm-"), ".nvm/versions/node/v22.2.0/bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "claude"), "#!/bin/sh\necho 2.1.300\n");
    await chmod(join(bin, "claude"), 0o755);
    const onShellPath = fakeClaude({});
    expect(await claudeAbsolutePath(onShellPath, `/usr/bin:${bin}`)).toBe(join(bin, "claude"));

    const p = plist({ node: "/opt/homebrew/bin/node", cli: "/x/cli.js", pmxHome: "/h/.pmx", home: "/h", claude: join(bin, "claude") });
    const env = jobEnv(p);
    expect(env.PATH.split(":")[0]).toBe(bin);
    expect(env.PMX_CLAUDE).toBe(join(bin, "claude"));
    expect(jobEnv(plist({ node: "n", cli: "c", pmxHome: "/h", home: "/h" }))).toEqual({ PATH: "/h/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", PMX_CLAUDE: null });
  });

  it("fails doctor when the background job can't find Claude Code, though the shell can", async () => {
    const launchd = fakeLaunchd();
    await launchd.install(plist({ node: "n", cli: "c", pmxHome: "/h", home: "/h" }));
    // The shell finds `claude`; with the job's PATH it doesn't, like the tester's "spawn claude ENOENT".
    const shellOnly: Exec = async (cmd, args, o) =>
      cmd === "claude" && o?.env?.PATH === jobEnv((await launchd.installed())!).PATH ? { stdout: "", stderr: "spawn claude ENOENT", code: 127 } : fakeClaude({})(cmd, args, o);
    const checks = await runDoctor({ personal: null, team: null, keychain: memoryKeychain(), launchd, exec: shellOnly });
    expect(checks.find((c) => c.id === "schedule.job-claude")).toMatchObject({ ok: false, level: "fail", detail: expect.stringContaining("pmx init") });

    const fine = await runDoctor({ personal: null, team: null, keychain: memoryKeychain(), launchd, exec: fakeClaude({}) });
    expect(fine.find((c) => c.id === "schedule.job-claude")).toMatchObject({ ok: true });
  });

  it("remembers background passes that keep failing, for status and doctor", async () => {
    await recordTick(["digest: failed: Digest run failed: spawn claude ENOENT"], new Date("2026-11-05T10:00:00Z"));
    await recordTick(["digest: failed: Digest run failed: spawn claude ENOENT"], new Date("2026-11-05T10:30:00Z"));
    expect(tickHealth((await loadState()).lastTick)).toMatchObject({ ok: true });
    await recordTick(["sync: 3 events", "digest: failed: Digest run failed: spawn claude ENOENT"], new Date("2026-11-05T11:00:00Z"));
    const bad = tickHealth((await loadState()).lastTick)!;
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/failed 3 passes in a row.*spawn claude ENOENT/);
    await recordTick(["sync: 1 event"]);
    expect((await loadState()).lastTick).toMatchObject({ failed: [], failStreak: 0 });
    expect(tickHealth(null)).toBeNull();
  });
});

describe("0.10.1: \"set up\" scheduled tasks that never ran", () => {
  beforeEach(async () => {
    await freshHome();
    process.env.PMX_CLAUDE_HOME = await tmp("claude-home-");
    await mkdir(join(taskFile(COLLECT_TASK.id), ".."), { recursive: true });
    await writeFile(taskFile(COLLECT_TASK.id), `---\nname: ${COLLECT_TASK.id}\n---\n\n${COLLECT_TASK.prompt}\n`);
  });

  it("doesn't call a task that ran before tracking began \"never ran\" after an upgrade", async () => {
    const old = new Date(2026, 9, 1, 9, 0); // written a month ago, by an older pmx that kept no run record
    await utimes(taskFile(COLLECT_TASK.id), old, old);
    expect(await taskRunHealth(COLLECT_TASK, new Date(2026, 10, 6, 10, 0))).toMatchObject({ ok: true });
    expect(await taskRunHealth(COLLECT_TASK, new Date(2026, 10, 6, 11, 0))).toMatchObject({ ok: true, detail: expect.stringContaining("12:30") });
    expect(await taskRunHealth(COLLECT_TASK, new Date(2026, 10, 6, 13, 0))).toMatchObject({ ok: false });
  });

  it("finds a cron expression's next time in local time", () => {
    const fri = new Date(2026, 10, 6, 18, 0); // Friday 18:00 local
    expect(nextCronTime("30 12,17 * * 1-5", fri)).toEqual(new Date(2026, 10, 9, 12, 30));
    expect(nextCronTime("0 8-18 * * 1-5", new Date(2026, 10, 9, 8, 0))).toEqual(new Date(2026, 10, 9, 9, 0));
    expect(nextCronTime("not a cron", fri)).toBeNull();
  });

  it("warns once a scheduled time passed with no run, and shows the last run otherwise", async () => {
    const written = new Date(2026, 10, 6, 9, 0); // Friday 09:00; first run due 12:30
    await utimes(taskFile(COLLECT_TASK.id), written, written);
    expect(await taskRunHealth(COLLECT_TASK, new Date(2026, 10, 6, 8, 0))).toMatchObject({ ok: true, detail: expect.stringContaining("next run") });
    expect(await taskRunHealth(COLLECT_TASK, new Date(2026, 10, 6, 11, 0))).toMatchObject({ ok: true, detail: expect.stringContaining("next run Fri Nov 06 12:30") });
    expect(await taskRunHealth(COLLECT_TASK, new Date(2026, 10, 6, 14, 0))).toMatchObject({ ok: false, detail: expect.stringContaining("hasn't run since Fri Nov 06 12:30") });

    await markTaskRun(COLLECT_TASK.id, "start", new Date(2026, 10, 6, 12, 31));
    expect(await taskRunHealth(COLLECT_TASK, new Date(2026, 10, 6, 12, 40))).toMatchObject({ ok: true, detail: expect.stringContaining("running now") });
    expect(await taskRunHealth(COLLECT_TASK, new Date(2026, 10, 6, 14, 0))).toMatchObject({ ok: false, detail: expect.stringContaining("Always allow") });
    await markTaskRun(COLLECT_TASK.id, "finish", new Date(2026, 10, 6, 12, 35));
    expect(await taskRunHealth(COLLECT_TASK, new Date(2026, 10, 6, 14, 35))).toEqual({ ok: true, detail: "last ran 2h ago" });
    // A manual `pmx todo --refresh` later doesn't rewrite the task's finish time.
    await markTaskRun(COLLECT_TASK.id, "finish", new Date(2026, 10, 6, 16, 0));
    expect((await loadState()).taskRuns[COLLECT_TASK.id]!.finishedAt).toBe(new Date(2026, 10, 6, 12, 35).toISOString());
    expect(paths.state()).toContain(process.env.PMX_HOME!);
  });
});

describe("0.10.1: an unsupported Node stops the install, not a later command", () => {
  const run = async (version: string) => {
    const src = await readFile(join(root, "check-node.cjs"), "utf8");
    const out: string[] = [];
    let code: number | null = null;
    runInNewContext(src, { process: { versions: { node: version }, execPath: "/n/node", exit: (c: number) => { code = c; } }, console: { error: (s: string) => out.push(s) } });
    return { code, text: out.join("\n") };
  };

  it("runs before install, agrees with engines, and prints the steps in order", async () => {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(pkg.scripts.preinstall).toBe("node check-node.cjs");
    expect(pkg.files).toContain("check-node.cjs");
    expect((await run("22.12.0")).code).toBeNull();
    expect((await run("24.1.0")).code).toBeNull();
    const old = await run("22.2.0");
    expect(old.code).toBe(1);
    expect(old.text).toMatch(/brew install node[\s\S]*nvm install 24 && nvm alias default 24[\s\S]*new Terminal[\s\S]*Install pmx again[\s\S]*pmx init/);
  });
});

describe("0.11.0: every command name is unique", () => {
  it("never lets a new command hide an older one (0.10.1's `pmx login` hid the hosted-app sign-in)", async () => {
    const { commands } = await import("../src/commands/index.js");
    const { registerEe } = await import("../ee/src/index.js");
    const names = [...commands, ...registerEe()].map((c) => c.name);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    expect(commands.find((c) => c.name === "login")!.summary).toMatch(/hosted app/);
    expect(commands.find((c) => c.name === "claude")!.usage).toMatch(/pmx claude login/);
  });
});
