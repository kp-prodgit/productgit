import { readFile, writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TEAM, type TeamConfig } from "../src/core/config.js";
import { paths } from "../src/core/paths.js";
import { cleanEnv, cleanInvocation, profileChecks, writeProfile } from "../src/core/profile.js";
import { freshHome } from "./helpers.js";

const team = { ...DEFAULT_TEAM, team: "t" } as TeamConfig;

describe("clean run profile (B1, PRIV-1, NEUT-1)", () => {
  beforeEach(freshHome);

  it("every check passes after writeProfile", async () => {
    await writeProfile(team);
    const checks = await profileChecks(team);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.length).toBeGreaterThanOrEqual(11);
  });

  it("fails when someone loosens the settings", async () => {
    await writeProfile(team);
    const s = JSON.parse(await readFile(paths.runSettings(), "utf8"));
    s.sandbox.enabled = false;
    s.autoMemoryEnabled = true;
    await writeFile(paths.runSettings(), JSON.stringify(s));
    const failed = (await profileChecks(team)).filter((c) => !c.ok).map((c) => c.id);
    expect(failed).toEqual(expect.arrayContaining(["profile.sandbox", "profile.memory-off"]));
  });

  it("fails when an MCP server is added or the model drifts", async () => {
    await writeProfile(team);
    await writeFile(paths.mcpConfig(), JSON.stringify({ mcpServers: { gmail: { command: "x" } } }));
    const failed = (await profileChecks({ ...team, model: "other-model" })).filter((c) => !c.ok).map((c) => c.id);
    expect(failed).toEqual(expect.arrayContaining(["profile.strict-mcp", "profile.model"]));
  });

  it("invocation uses project-only settings, strict MCP, no tools for synthesis, and never skips permissions", () => {
    const inv = cleanInvocation({ team, cwd: "/repo", prompt: "hi", tools: [] });
    const a = inv.args;
    expect(a).toEqual(expect.arrayContaining(["--setting-sources", "project", "--strict-mcp-config", "--no-session-persistence"]));
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    expect(a[a.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(a[a.indexOf("--model") + 1]).toBe(team.model);
    expect(a.join(" ")).not.toMatch(/dangerously|bypass/);
    expect(a).not.toContain("--allowedTools");
    expect(Number(a[a.indexOf("--max-budget-usd") + 1])).toBe(team.caps.perRunUsd);
  });

  it("per-run budget can go lower than the team cap but never higher", () => {
    const a = cleanInvocation({ team, cwd: "/r", prompt: "", tools: ["Read"], maxBudgetUsd: 99 }).args;
    expect(Number(a[a.indexOf("--max-budget-usd") + 1])).toBe(team.caps.perRunUsd);
    expect(a[a.indexOf("--allowedTools") + 1]).toBe("Read");
  });

  it("strips the PM's own Claude env and points at the separate profile", () => {
    const env = cleanEnv({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/Users/me/.claude", ANTHROPIC_MODEL: "x", MCP_TIMEOUT: "1", HOME: "/Users/me" });
    expect(env.CLAUDE_CONFIG_DIR).toBe(paths.claudeProfile());
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.MCP_TIMEOUT).toBeUndefined();
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    expect(env.PATH).toBe("/bin");
  });
});
