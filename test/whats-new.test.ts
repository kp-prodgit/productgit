import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Exec } from "../src/core/exec.js";
import { paths } from "../src/core/paths.js";
import { loadState } from "../src/core/state.js";
import { installTeamVersion } from "../src/core/update.js";
import { currentVersion } from "../src/core/version.js";
import { announceOnce, formatNotes, markSeen, markUpdatingFrom, newVersionNotes, notesBetween, pendingNotes, QUIET_COMMANDS, RELEASE_NOTES } from "../src/core/whats-new.js";
import { freshHome, tmp } from "./helpers.js";

const root = new URL("..", import.meta.url).pathname;
const configExists = async () => {
  await mkdir(dirname(paths.config()), { recursive: true });
  await writeFile(paths.config(), "{}");
};

describe("0.12.0: every release says what's new (NEW-1)", () => {
  it("has notes for this version, newest first, each with a headline, items and a CHANGELOG section", async () => {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(RELEASE_NOTES[0]!.version).toBe(pkg.version);
    const versions = RELEASE_NOTES.map((n) => n.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))).toEqual(versions);
    const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
    for (const n of RELEASE_NOTES) {
      expect(n.headline.length).toBeGreaterThan(5);
      expect(n.items.length).toBeGreaterThan(0);
      expect(n.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(changelog).toContain(`## ${n.version}:`);
    }
  });

  it("picks the notes between two versions, or just this one's", () => {
    expect(notesBetween("0.10.0", "0.12.0").map((n) => n.version)).toEqual(["0.12.0", "0.11.0", "0.10.1"]);
    expect(notesBetween(null, "0.11.0").map((n) => n.version)).toEqual(["0.11.0"]);
    expect(notesBetween("0.12.0", "0.12.0")).toEqual([]);
    expect(formatNotes(notesBetween(null, "0.11.0"))).toMatch(/What's new in pmx 0\.11\.0: See where your data went[\s\S]*Try: pmx flow --web/);
  });
});

describe("0.12.0: telling each Mac once (NEW-1)", () => {
  beforeEach(freshHome);

  it("after an update, the first command shows what changed since the old version, once", async () => {
    await configExists();
    await markUpdatingFrom("0.10.1");
    await markUpdatingFrom("0.11.0"); // a second update before any command keeps the older starting point
    expect((await pendingNotes()).map((n) => n.version)).toEqual(notesBetween("0.10.1").map((n) => n.version));
    const out: string[] = [];
    await announceOnce((s) => out.push(s));
    expect(out.join("")).toContain(`What's new in pmx ${currentVersion()}`);
    expect(out.join("")).toContain("pmx whats-new");
    await announceOnce((s) => out.push(s));
    expect(out).toHaveLength(1);
    expect((await loadState()).whatsNew).toEqual({ seen: currentVersion(), since: null });
  });

  it("says nothing before setup or on a fresh install, and covers recent releases after a manual install over an old pmx", async () => {
    const out: string[] = [];
    await announceOnce((s) => out.push(s));
    expect(out).toEqual([]);
    expect((await loadState()).whatsNew).toBeNull();

    await configExists();
    const recent = await pendingNotes({ installedAt: "2026-11-06T00:00:00Z" });
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.length).toBeLessThanOrEqual(3);
    expect(recent.every((n) => n.date >= "2026-11-06")).toBe(true);

    await markSeen();
    expect(await pendingNotes()).toEqual([]);
  });

  it("an install through PMX records the version it replaced, and the new pmx is asked for its notes", async () => {
    process.env.PMX_INSTALL_ROOT_FOR_TESTS = await tmp("installed-");
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "tar") return { code: 0, stdout: JSON.stringify({ version: "9.0.0" }), stderr: "" };
      if (cmd === "npm" && args[0] === "prefix") return { code: 0, stdout: "/opt/homebrew\n", stderr: "" };
      if (cmd === "/opt/homebrew/bin/pmx") return { code: 0, stdout: "What's new in pmx 9.0.0: Big\n  • Thing\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    expect(await installTeamVersion("/repo", exec)).toEqual({ result: "updated", version: "9.0.0" });
    expect((await loadState()).whatsNew).toEqual({ seen: null, since: currentVersion() });
    expect(await newVersionNotes(exec, currentVersion())).toMatch(/^What's new in pmx 9\.0\.0: Big/);
    expect(calls.at(-1)).toEqual(["/opt/homebrew/bin/pmx", "whats-new", "--since", currentVersion()]);
    delete process.env.PMX_INSTALL_ROOT_FOR_TESTS;
  });

  it("never interrupts the background job, the MCP protocol or uninstall", () => {
    expect([...QUIET_COMMANDS].sort()).toEqual(["mcp", "tick", "uninstall", "whats-new"]);
  });
});
