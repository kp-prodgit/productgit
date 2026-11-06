import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { doctorJson, runDoctor } from "../src/commands/doctor.js";
import { checkFolder, checkGitUrl, formatDays, parseDays, parseHours, runInit } from "../src/commands/init.js";
import type { Asker } from "../src/core/ask.js";
import { nodeSupported, resolveClaude } from "../src/core/claude-bin.js";
import { loadTeamConfig } from "../src/core/config.js";
import { exec, type Exec } from "../src/core/exec.js";
import { memoryKeychain } from "../src/core/keychain.js";
import { fakeLaunchd } from "../src/core/launchd.js";
import { paths } from "../src/core/paths.js";
import { installLatestRelease, releaseAsset } from "../src/core/update.js";
import { currentVersion } from "../src/core/version.js";
import { freshHome, pmxRepo, quietOut, tmp } from "./helpers.js";

const withClaude: Exec = async (cmd, args, o) => (cmd === "claude" ? { stdout: "2.1.300 (Claude Code)", stderr: "", code: 0 } : exec(cmd, args, o));
const root = new URL("..", import.meta.url).pathname;

/** Answers in order per question, so a test can give a wrong answer first and see it re-asked. */
function sequenceAsker(answers: Record<string, (string | boolean)[]>, asked: string[] = []): Asker {
  const next = (q: string) => {
    asked.push(q);
    const key = Object.keys(answers).find((k) => q.toLowerCase().includes(k.toLowerCase()));
    return key ? (answers[key]!.length > 1 ? answers[key]!.shift() : answers[key]![0]) : undefined;
  };
  return {
    async text(q, def = "") { const a = next(q); return typeof a === "string" ? a : def; },
    async secret(q) { const a = next(q); return typeof a === "string" ? a : ""; },
    async confirm(q, def = true) { const a = next(q); return typeof a === "boolean" ? a : def; },
    async choose(q, options, def) { const a = next(q); return (options.find((o) => o === a) ?? def) as any; },
  };
}

describe("0.10.0: a solo install that works", () => {
  beforeEach(async () => {
    await freshHome();
    process.env.PMX_CLAUDE_HOME = await tmp("claude-home-");
  });

  it("finds Claude Code in ~/.local/bin when it isn't on PATH, for doctor and runs", async () => {
    const offPath: Exec = async (cmd, args, o) =>
      cmd === "claude" ? { stdout: "", stderr: "spawn claude ENOENT", code: 127 }
        : cmd.endsWith("/.local/bin/claude") ? { stdout: "2.1.318 (Claude Code)", stderr: "", code: 0 }
        : exec(cmd, args, o);
    expect(await resolveClaude(offPath)).toMatchObject({ version: "2.1.318 (Claude Code)", onPath: false, cmd: expect.stringMatching(/\/\.local\/bin\/claude$/) });
    expect(await resolveClaude(withClaude)).toMatchObject({ cmd: "claude", onPath: true });
    const none: Exec = async () => ({ stdout: "", stderr: "ENOENT", code: 127 });
    expect(await resolveClaude(none)).toBeNull();

    const checks = await runDoctor({ personal: null, team: null, keychain: memoryKeychain(), launchd: fakeLaunchd(), exec: offPath });
    expect(checks.find((c) => c.id === "claude.installed")).toMatchObject({ ok: true, detail: expect.stringContaining("not on your shell's PATH") });
  });

  it("supports Node 22.12+ and 24+, matching package.json engines, and warns about version managers", async () => {
    expect([nodeSupported("20.18.0"), nodeSupported("22.2.0"), nodeSupported("22.12.0"), nodeSupported("23.6.0"), nodeSupported("24.1.0"), nodeSupported("26.0.0")])
      .toEqual([false, false, true, false, true, true]);
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(pkg.engines.node).toBe("^22.12.0 || >=24");
    expect((await readFile(join(root, ".nvmrc"), "utf8")).trim()).toBe("24");

    const nvm = await runDoctor({ personal: null, team: null, keychain: memoryKeychain(), launchd: fakeLaunchd(), exec: withClaude, execPath: "/Users/ana/.nvm/versions/node/v24.1.0/bin/node" });
    expect(nvm.find((c) => c.id === "node.path")).toMatchObject({ ok: false, level: "warn", detail: expect.stringContaining("brew install node") });
    const brew = await runDoctor({ personal: null, team: null, keychain: memoryKeychain(), launchd: fakeLaunchd(), exec: withClaude, execPath: "/opt/homebrew/bin/node" });
    expect(brew.find((c) => c.id === "node.path")).toBeUndefined();
  });

  it("doctor --json gives Claude what it needs to check an install", async () => {
    const checks = await runDoctor({ personal: null, team: null, keychain: memoryKeychain(), launchd: fakeLaunchd(), exec: withClaude });
    const j = doctorJson(checks);
    expect(j).toMatchObject({ ok: false, version: currentVersion(), failed: expect.arrayContaining(["config.personal"]) });
    expect(j.checks.find((c) => c.id === "config.personal")).toMatchObject({ detail: expect.stringContaining("pmx init") });
    expect(JSON.parse(JSON.stringify(j)).checks.length).toBe(checks.length);
  });

  it("re-asks wrong answers instead of saving them, and reads working days and hours", async () => {
    const dir = await tmp();
    const repo = join(dir, "pmx");
    const out = quietOut();
    const personal = await runInit({
      ask: sequenceAsker({
        "PMX repo checkout": ["/pmx-schedule", "pmx schedule --install-skill", repo],
        "Git URL": ["/pmx-schedule", ""],
        "Team name": ["acme"],
        handle: ["ana smith", "ana"],
        "Categories": ["spec, nonsense", "spec"],
        "Working days": ["weekdays", "Mon-Thu"],
        "Working hours": ["24:00, Mon", "9:30-17:00"],
        "Daily spend": ["ten", "0"],
        transcripts: [join(dir, "t")],
      }),
      keychain: memoryKeychain(), launchd: fakeLaunchd(), exec: withClaude, out, now: () => new Date(), cliPath: "/x",
    });
    expect(personal).toMatchObject({ repoPath: repo, handle: "ana", categories: ["spec"], workingHours: { days: [1, 2, 3, 4], start: "09:30", end: "17:00" }, budget: { dailyUsd: 0 } });
    const warnings = out.lines.filter((l) => l.startsWith("WARN"));
    expect(warnings.some((w) => /"\/pmx-schedule" looks like a command, not a folder/.test(w))).toBe(true);
    expect(warnings.some((w) => /looks like a command, not a git URL/.test(w))).toBe(true);
    expect(warnings.some((w) => /Use HH:MM-HH:MM/.test(w))).toBe(true);
    expect(out.lines.join("\n")).toMatch(/PMX will save this setup:[\s\S]*Mon-Thu 09:30-17:00 local time, up to \$0 a day \(paused\)/);
    expect(out.lines.join("\n")).toContain('"PMX repo"');
  });

  it("gives up after three wrong answers and saves nothing", async () => {
    const dir = await tmp();
    await expect(runInit({
      ask: sequenceAsker({ "PMX repo checkout": [join(dir, "pmx")], "Working hours": ["24:00, Mon"], transcripts: [join(dir, "t")] }),
      keychain: memoryKeychain(), launchd: fakeLaunchd(), exec: withClaude, out: quietOut(), now: () => new Date(), cliPath: "/x",
    })).rejects.toThrow(/after three tries\. Nothing was saved/);
    expect(await stat(paths.config()).catch(() => null)).toBeNull();
  });

  it("shows a summary first: declining writes no config and creates no repo", async () => {
    const dir = await tmp();
    const repo = join(dir, "pmx");
    const launchd = fakeLaunchd();
    await expect(runInit({
      ask: sequenceAsker({ "PMX repo checkout": [repo], "Save this setup": [false], transcripts: [join(dir, "t")] }),
      keychain: memoryKeychain(), launchd, exec: withClaude, out: quietOut(), now: () => new Date(), cliPath: "/x",
    })).rejects.toThrow(/Nothing was saved/);
    expect(await stat(paths.config()).catch(() => null)).toBeNull();
    expect(await stat(repo).catch(() => null)).toBeNull();
    expect(launchd.plist).toBeFalsy();
  });

  it("clones with `--`, so a git URL can never be read as an option", async () => {
    expect(await checkGitUrl("--upload-pack=touch /tmp/pwned")).toMatch(/looks like a command/);
    expect(await checkGitUrl("https://github.com/acme/pmx.git")).toBeNull();
    expect(await checkGitUrl("git@github.com:acme/pmx.git")).toBeNull();
    expect(await checkGitUrl("acme/pmx")).toMatch(/Enter a git URL/);
    expect(await checkFolder("/")).toBeNull();
    expect(await checkFolder("/pmx-root-folder/nested")).toMatch(/can't create folders in \//);

    const { repo: team } = await pmxRepo();
    const clones: string[][] = [];
    const spy: Exec = async (cmd, args, o) => {
      if (cmd === "git" && args[0] === "clone") clones.push(args);
      return withClaude(cmd, args, o);
    };
    const dir = await tmp();
    const p = await runInit({
      ask: sequenceAsker({ "PMX repo checkout": [join(dir, "pmx")], "Git URL": [team], transcripts: [join(dir, "t")] }),
      keychain: memoryKeychain(), launchd: fakeLaunchd(), exec: spy, out: quietOut(), now: () => new Date(), cliPath: "/x",
    });
    expect(clones).toEqual([["clone", "--", team, join(dir, "pmx")]]);
    expect((await loadTeamConfig(p.repoPath)).team).toBe((await loadTeamConfig(team)).team);
  });

  it("parses working days and hours", () => {
    expect(parseDays("Mon-Fri")).toEqual([1, 2, 3, 4, 5]);
    expect(parseDays("mon, wed, fri")).toEqual([1, 3, 5]);
    expect(parseDays("Fri-Mon")).toEqual([0, 1, 5, 6]);
    expect(parseDays("weekdays")).toBeNull();
    expect(formatDays([1, 2, 3, 4, 5])).toBe("Mon-Fri");
    expect(formatDays([1, 3, 5])).toBe("Mon,Wed,Fri");
    expect(parseHours("9:00-18:00")).toEqual(["09:00", "18:00"]);
    expect(parseHours("22:00-24:00")).toEqual(["22:00", "24:00"]);
    expect([parseHours("24:00, Mon"), parseHours("18:00-09:00"), parseHours("09:00-24:30"), parseHours("25:00-26:00")]).toEqual([null, null, null, null]);
  });

  it("`pmx update --latest` installs the newest release only when it matches SHA256SUMS", async () => {
    process.env.PMX_INSTALL_ROOT_FOR_TESTS = await tmp("installed-");
    const v = "99.0.0";
    const pkg = Buffer.from("fake package");
    const sum = createHash("sha256").update(pkg).digest("hex");
    const fakeFetch = (sums: string) => (async (url: string) => {
      if (url.endsWith("/releases/latest")) return new Response(JSON.stringify({ tag_name: `v${v}` }));
      if (url === releaseAsset(v)) return new Response(pkg);
      if (url === releaseAsset(v, "SHA256SUMS")) return new Response(sums);
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const installs: string[][] = [];
    const npm: Exec = async (cmd, args) => (installs.push([cmd, ...args]), { stdout: "", stderr: "", code: 0 });

    expect(await installLatestRelease(npm, { fetch: fakeFetch(`${"0".repeat(64)}  productgit-${v}.tgz\n`) })).toMatchObject({ result: "failed", error: expect.stringContaining("doesn't match") });
    expect(installs).toEqual([]);
    expect(await installLatestRelease(npm, { fetch: fakeFetch(`${sum}  productgit-${v}.tgz\n`) })).toEqual({ result: "updated", version: v });
    expect(installs[0]!.slice(0, 3)).toEqual(["npm", "install", "-g"]);
    expect(installs[0]![3]).toMatch(new RegExp(`productgit-${v}\\.tgz$`));
    delete process.env.PMX_INSTALL_ROOT_FOR_TESTS;
  });

  it("INSTALL.md pins this release, starts with auto mode off, and the export publishes it", async () => {
    const guide = await readFile(join(root, "INSTALL.md"), "utf8");
    const v = currentVersion();
    expect(guide).toContain(`releases/download/v${v}/productgit-${v}.tgz`);
    expect(guide).toContain(`releases/download/v${v}/SHA256SUMS`);
    expect(guide.indexOf("auto mode off")).toBeLessThan(guide.indexOf("Step 1"));
    expect(guide).toContain("pmx doctor --json");
    // The export script stays in the private repo, so the public repo's tests skip this part.
    const exporter = await readFile(join(root, "scripts/export-public.sh"), "utf8").catch(() => null);
    if (exporter !== null) expect(exporter).toMatch(/PUBLIC=\(.*INSTALL\.md/);
    expect(await readFile(join(root, ".github/workflows/release.yml"), "utf8")).toContain("SHA256SUMS");
  });
});
