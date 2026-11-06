import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { scriptedAsker } from "../src/core/ask.js";
import { exec, type Exec } from "../src/core/exec.js";
import { memoryKeychain } from "../src/core/keychain.js";
import { fakeLaunchd, plist } from "../src/core/launchd.js";
import { paths } from "../src/core/paths.js";
import { runDoctor } from "../src/commands/doctor.js";
import { runInit } from "../src/commands/init.js";
import { loadTeamConfig } from "../src/core/config.js";
import { VENDORED_CLI } from "../src/core/vendor.js";
import { freshHome, quietOut, tmp } from "./helpers.js";

/** Pretends Claude Code is installed; everything else runs for real. */
const withClaude: Exec = async (cmd, args, o) => (cmd === "claude" ? { stdout: "2.1.300 (Claude Code)", stderr: "", code: 0 } : exec(cmd, args, o));

describe("pmx init and doctor (CLI-2, CLI-3)", () => {
  beforeEach(freshHome);

  it("sets up a new PMX repo, the clean profile, keychain and launchd, and doctor passes", async () => {
    const root = await tmp();
    const repo = join(root, "pmx");
    const keychain = memoryKeychain();
    const launchd = fakeLaunchd();
    const out = quietOut();
    const p = await runInit({
      ask: scriptedAsker({ "PMX repo checkout": repo, "Team name": "acme", handle: "ana", "Linear team key": "", transcripts: join(root, "t") }),
      keychain, launchd, exec: withClaude, out, now: () => new Date("2026-11-03T00:00:00Z"), cliPath: "/x/cli.js",
    });
    expect(p.repoPath).toBe(repo);
    // Teammates and CI install the CLI from the repo; the workflow's fallback is the pinned release package.
    const listing = await exec("tar", ["-tzf", join(repo, VENDORED_CLI)]);
    expect(listing.stdout).toContain("package/package.json");
    expect(listing.stdout).toContain("package/skills/pmx-spec/SKILL.md");
    const workflow = await readFile(join(repo, ".github/workflows/pmx-run-record.yml"), "utf8");
    expect(workflow).not.toContain("{{PMX_VERSION}}");
    expect(workflow).toMatch(/npm install -g "https:\/\/github\.com\/kp-prodgit\/productgit\/releases\/download\/v(\d+\.\d+\.\d+)\/productgit-\1\.tgz"/);
    expect(workflow).toContain('git show "origin/$BASE:.pmx/cli/productgit.tgz"');
    expect(launchd.plist).toContain("<string>tick</string>");
    expect(launchd.plist).toContain("<integer>1800</integer>");
    const cfg = JSON.parse(await readFile(paths.config(), "utf8"));
    expect(cfg.machineId).toMatch(/^m[0-9a-f]{8}$/);
    expect(JSON.stringify(cfg)).not.toMatch(/token/i);

    const team = await loadTeamConfig(repo);
    const checks = await runDoctor({ personal: p, team, keychain, launchd, exec: withClaude });
    const failed = checks.filter((c) => !c.ok && c.level === "fail");
    expect(failed).toEqual([]);
    expect(checks.some((c) => c.id === "profile.sandbox" && c.ok)).toBe(true);
  });

  it("doctor fails on a token in plain-text config and warns on consumer plans", async () => {
    const root = await tmp();
    const repo = join(root, "pmx");
    const keychain = memoryKeychain();
    const launchd = fakeLaunchd();
    const p = await runInit({
      ask: scriptedAsker({ "PMX repo checkout": repo, "Model plan": "max", transcripts: join(root, "t") }),
      keychain, launchd, exec: withClaude, out: quietOut(), now: () => new Date(), cliPath: "/x",
    });
    const cfg = JSON.parse(await readFile(paths.config(), "utf8"));
    cfg.crmNamesFile = "xoxb-123456789012-abcdefghijkl";
    await writeFile(paths.config(), JSON.stringify(cfg));
    const checks = await runDoctor({ personal: p, team: await loadTeamConfig(repo), keychain, launchd, exec: withClaude });
    expect(checks.find((c) => c.id === "secrets.not-in-config")!.ok).toBe(false);
    expect(checks.find((c) => c.id === "model.plan")).toMatchObject({ ok: true }); // runs on the PM's subscription
  });

  it("doctor fails every clean-profile check when the profile is missing", async () => {
    const root = await tmp();
    const repo = join(root, "pmx");
    const keychain = memoryKeychain();
    const p = await runInit({
      ask: scriptedAsker({ "PMX repo checkout": repo, transcripts: join(root, "t") }),
      keychain, launchd: fakeLaunchd(), exec: withClaude, out: quietOut(), now: () => new Date(), cliPath: "/x",
    });
    const { rm } = await import("node:fs/promises");
    await rm(paths.claudeProfile(), { recursive: true });
    const checks = await runDoctor({ personal: p, team: await loadTeamConfig(repo), keychain, launchd: fakeLaunchd(), exec: withClaude });
    const failedProfile = checks.filter((c) => c.id.startsWith("profile.") && !c.ok);
    expect(failedProfile.length).toBeGreaterThanOrEqual(9);
  });

  it("gives the launchd job a PATH that finds the Claude Code installer's ~/.local/bin", () => {
    const p = plist({ node: "/usr/local/bin/node", cli: "/x/cli.js", pmxHome: "/Users/ana/.pmx", home: "/Users/ana" });
    expect(p).toContain("<key>PATH</key>\n    <string>/Users/ana/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>");
  });
});
