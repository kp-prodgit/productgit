import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { addAllowRules, ALLOW_RULES, claudeSettingsFile, missingAllowRules } from "../src/claude/permissions.js";
import { runDoctor } from "../src/commands/doctor.js";
import { runInit } from "../src/commands/init.js";
import { scriptedAsker } from "../src/core/ask.js";
import { loadTeamConfig, type TeamConfig } from "../src/core/config.js";
import { exec, type Exec } from "../src/core/exec.js";
import { memoryKeychain } from "../src/core/keychain.js";
import { capTickLogs, fakeLaunchd, tickLogs } from "../src/core/launchd.js";
import { paths } from "../src/core/paths.js";
import { currentVersion } from "../src/core/version.js";
import { linearAccess } from "../src/linear/access.js";
import { relayDir } from "../src/tracker/relay.js";
import { freshHome, quietOut, tmp } from "./helpers.js";

const withClaude: Exec = async (cmd, args, o) => (cmd === "claude" ? { stdout: "2.1.300 (Claude Code)", stderr: "", code: 0 } : exec(cmd, args, o));
const linear = { kind: "linear", teamKey: "PMX", projectId: "proj-1" } as const;

async function setUp(asks: Record<string, string | boolean> = {}) {
  const root = await tmp();
  const repo = join(root, "pmx");
  const keychain = memoryKeychain();
  const launchd = fakeLaunchd();
  const personal = await runInit({
    ask: scriptedAsker({ "PMX repo checkout": repo, "Team name": "acme", handle: "ana", "Linear team key": "", transcripts: join(root, "t"), ...asks }),
    keychain, launchd, exec: withClaude, out: quietOut(), now: () => new Date(), cliPath: "/x/cli.js",
  });
  const team: TeamConfig = { ...(await loadTeamConfig(repo)), tracker: linear };
  return { personal, team, keychain, launchd };
}

describe("0.9.1: no false alarms on a supported setup", () => {
  beforeEach(async () => {
    await freshHome();
    process.env.PMX_CLAUDE_HOME = await tmp("claude-home-");
  });

  it("checks Linear the way this Mac reaches it, and the Claude relay never fails doctor", async () => {
    const { personal, team, keychain, launchd } = await setUp();
    expect(await linearAccess(team, keychain)).toBe("relay");
    let checks = await runDoctor({ personal, team, keychain, launchd, exec: withClaude });
    expect(checks.find((c) => c.id === "secrets.linear")).toBeUndefined();
    expect(checks.find((c) => c.id === "linear.relay")).toMatchObject({ ok: false, level: "warn", detail: expect.stringMatching(/not synced yet/) });
    expect(checks.filter((c) => !c.ok && c.level === "fail")).toEqual([]);

    await mkdir(relayDir(), { recursive: true });
    await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: new Date().toISOString(), projectId: "proj-1", issues: [] }));
    checks = await runDoctor({ personal, team, keychain, launchd, exec: withClaude });
    expect(checks.find((c) => c.id === "linear.relay")).toMatchObject({ ok: true, detail: expect.stringMatching(/synced under an hour ago, 0 change/) });

    await keychain.set("linear-token", "lin_api_x");
    checks = await runDoctor({ personal, team, keychain, launchd, exec: withClaude });
    expect(checks.find((c) => c.id === "secrets.linear")).toMatchObject({ ok: true });
    expect(checks.find((c) => c.id === "linear.relay")).toBeUndefined();
  });

  it("warns when the team package is older than this Mac, with what the lead should do", async () => {
    const { personal, team, keychain, launchd } = await setUp();
    const oldPackage: Exec = async (cmd, args, o) => (cmd === "tar" && args[0] === "-xOzf" ? { stdout: '{"version":"0.4.0"}', stderr: "", code: 0 } : withClaude(cmd, args, o));
    const c = (await runDoctor({ personal, team, keychain, launchd, exec: oldPackage })).find((x) => x.id === "cli.team-package");
    expect(c).toMatchObject({ ok: false, level: "warn" });
    expect(c!.detail).toContain(`pmx 0.4.0, older than this Mac's ${currentVersion()}`);
    expect(c!.detail).toContain("pmx vendor --require");
  });

  it("adds always-allow rules for PMX's own command and folder, keeping the PM's settings", async () => {
    expect(await missingAllowRules()).toEqual([...ALLOW_RULES]);
    await mkdir(join(claudeSettingsFile(), ".."), { recursive: true });
    await writeFile(claudeSettingsFile(), JSON.stringify({ theme: "dark", permissions: { allow: ["Bash(git status)"], deny: ["Bash(rm *)"] } }));
    expect((await addAllowRules()).added).toEqual([...ALLOW_RULES]);
    const s = JSON.parse(await readFile(claudeSettingsFile(), "utf8"));
    expect(s).toEqual({ theme: "dark", permissions: { allow: ["Bash(git status)", ...ALLOW_RULES], deny: ["Bash(rm *)"] } });
    expect((await addAllowRules()).added).toEqual([]);

    await writeFile(claudeSettingsFile(), "{ not json");
    expect((await addAllowRules()).error).toMatch(/isn't valid JSON, so PMX left it alone/);
    expect(await readFile(claudeSettingsFile(), "utf8")).toBe("{ not json");
  });

  it("init asks before adding the rules, and doctor warns while they're missing", async () => {
    const declined = await setUp({ "without asking each time": false });
    expect(await missingAllowRules()).toEqual([...ALLOW_RULES]);
    const c = (await runDoctor({ ...declined, exec: withClaude })).find((x) => x.id === "claude.allow");
    expect(c).toMatchObject({ ok: false, level: "warn", detail: expect.stringMatching(/pmx schedule --allow/) });

    await setUp();
    expect(await missingAllowRules()).toEqual([]);
  });

  it("init no longer asks for a Linear key or points at Linear sign-in", async () => {
    const asked: string[] = [];
    const root = await tmp();
    const answers = scriptedAsker({ "PMX repo checkout": join(root, "pmx"), "Linear team key": "PMX", "PMX project ID": "proj-1", transcripts: join(root, "t") });
    const ask = { ...answers, text: (q: string, d?: string) => (asked.push(q), answers.text(q, d)), secret: (q: string) => (asked.push(q), answers.secret(q)) };
    await runInit({ ask, keychain: memoryKeychain(), launchd: fakeLaunchd(), exec: withClaude, out: quietOut(), now: () => new Date(), cliPath: "/x" });
    expect(asked.some((q) => /Linear team key/.test(q))).toBe(true);
    expect(asked.join("\n")).not.toMatch(/Linear API key|linear login/);
  });

  it("keeps the background job's logs under the cap", async () => {
    const [log, err] = tickLogs();
    await mkdir(paths.logs(), { recursive: true });
    await writeFile(log!, "x".repeat(2048));
    await writeFile(err!, "small");
    await capTickLogs(1024);
    expect((await stat(`${log}.1`)).size).toBe(2048);
    expect(await stat(log!).catch(() => null)).toBeNull();
    expect(await readFile(err!, "utf8")).toBe("small");
  });
});
