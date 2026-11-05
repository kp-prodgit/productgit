import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TeamConfig } from "./config.js";
import { readJson, writeJson } from "./fsutil.js";
import { paths } from "./paths.js";

/**
 * The clean run profile (B1). Every Claude Code run Product Git starts goes through
 * `cleanInvocation`, so personal memory, instructions, skills, plugins, hooks, MCP servers
 * and claude.ai connectors never load (PRIV-1, NEUT-1).
 */

/** Settings passed with `--settings`. With `--setting-sources project`, user settings never load. */
export function runSettings(team: Pick<TeamConfig, "egress" | "model">): Record<string, unknown> {
  return {
    model: team.model,
    autoMemoryEnabled: false,
    disableClaudeAiConnectors: true,
    syncClaudeAiSkills: false,
    syncClaudeAiPlugins: false,
    enableAllProjectMcpServers: false,
    permissions: {
      defaultMode: "dontAsk",
      disableBypassPermissionsMode: "disable",
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
      deny: ["WebFetch", "WebSearch", "Bash(git push *)", "Bash(gh *)", "Bash(curl *)", "Bash(wget *)"],
    },
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [...team.egress].sort() },
    },
    env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
  };
}

/** No MCP servers by default: the agent in a run gets no tracker or source tools (P3, SEC-1). */
export const EMPTY_MCP = { mcpServers: {} };

export async function writeProfile(team: Pick<TeamConfig, "egress" | "model">): Promise<void> {
  await mkdir(paths.claudeProfile(), { recursive: true, mode: 0o700 });
  await writeJson(paths.runSettings(), runSettings(team), 0o600);
  await writeJson(paths.mcpConfig(), EMPTY_MCP, 0o600);
}

export interface InvocationOpts {
  team: Pick<TeamConfig, "egress" | "model" | "caps">;
  cwd: string;
  prompt: string;
  /** Built-in tools. `[]` means none at all (synthesis and digest, SEC-1). */
  tools: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  appendSystemPrompt?: string;
}

export interface Invocation {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/** Environment keys from the PM's shell that could pull personal setup into a run. */
const STRIP_ENV = [/^CLAUDE_/, /^ANTHROPIC_MODEL$/, /^ANTHROPIC_DEFAULT_/, /^MCP_/, /^ENABLE_CLAUDEAI/];

export function cleanEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!STRIP_ENV.some((r) => r.test(k))) env[k] = v;
  env.CLAUDE_CONFIG_DIR = paths.claudeProfile();
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = "1";
  return env;
}

export function cleanInvocation(o: InvocationOpts): Invocation {
  const args = [
    "-p",
    o.prompt,
    "--output-format",
    "json",
    "--setting-sources",
    "project",
    "--settings",
    paths.runSettings(),
    "--strict-mcp-config",
    "--mcp-config",
    paths.mcpConfig(),
    "--model",
    o.team.model,
    "--permission-mode",
    "dontAsk",
    "--tools",
    o.tools.join(","),
    "--no-session-persistence",
    "--max-budget-usd",
    String(Math.min(o.maxBudgetUsd ?? o.team.caps.perRunUsd, o.team.caps.perRunUsd)),
  ];
  if (o.tools.length) args.push("--allowedTools", o.tools.join(","));
  if (o.maxTurns) args.push("--max-turns", String(o.maxTurns));
  if (o.appendSystemPrompt) args.push("--append-system-prompt", o.appendSystemPrompt);
  return { cmd: "claude", args, env: cleanEnv(), cwd: o.cwd };
}

export interface Check {
  id: string;
  ok: boolean;
  detail: string;
}

/** Every clean-profile check. `pmx doctor` fails if any is false (CLI-3). */
export async function profileChecks(team: Pick<TeamConfig, "egress" | "model" | "caps">): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });

  let dirOk = false;
  try {
    const s = await stat(paths.claudeProfile());
    dirOk = s.isDirectory() && (s.mode & 0o077) === 0;
  } catch {}
  add("profile.dir", dirOk, `${paths.claudeProfile()} exists and is private (0700)`);

  const s = await readJson<any>(paths.runSettings());
  add("profile.settings", !!s, `${paths.runSettings()} present`);
  add("profile.model", s?.model === team.model, `model fixed to team model ${team.model}`);
  add("profile.memory-off", s?.autoMemoryEnabled === false && s?.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY === "1", "auto memory off");
  add("profile.connectors-off", s?.disableClaudeAiConnectors === true && s?.syncClaudeAiSkills === false && s?.syncClaudeAiPlugins === false, "claude.ai connectors, skills and plugin sync off");
  add("profile.no-bypass", s?.permissions?.defaultMode === "dontAsk" && s?.permissions?.disableBypassPermissionsMode === "disable", "permissions never skipped (dontAsk, bypass disabled)");
  add("profile.reads-limited", s?.permissions?.blockReadsOutsideWorkingDirectories === true && s?.permissions?.blockWritesOutsideWorkingDirectories === true, "reads and writes limited to the repo checkout");
  add("profile.sandbox", s?.sandbox?.enabled === true && s?.sandbox?.allowUnsandboxedCommands === false, "sandbox on, no unsandboxed retries");
  const egressOk = JSON.stringify(s?.sandbox?.network?.allowedDomains ?? null) === JSON.stringify([...team.egress].sort());
  add("profile.egress", egressOk, `egress limited to ${team.egress.join(", ")}`);

  const mcp = await readJson<any>(paths.mcpConfig());
  add("profile.strict-mcp", !!mcp && Object.keys(mcp.mcpServers ?? {}).length === 0, "strict MCP config with no servers");

  const inv = cleanInvocation({ team, cwd: ".", prompt: "", tools: [] });
  const a = inv.args.join(" ");
  add(
    "profile.invocation",
    a.includes("--setting-sources project") && a.includes("--strict-mcp-config") && !a.includes("dangerously") &&
      inv.env.CLAUDE_CONFIG_DIR === paths.claudeProfile() && inv.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === "1",
    "runs use project-only settings and the separate profile",
  );
  return checks;
}

/** Reads a repo file by relative path, or null if missing. */
export type RepoReader = (rel: string) => Promise<string | Buffer | null>;

export const fsReader = (repoPath: string): RepoReader => (rel) => readFile(join(repoPath, rel)).catch(() => null);

/**
 * A fingerprint of everything that shapes a run, for the run record (B5) and the neutrality test (B6):
 * the clean-profile settings, the MCP config, the project CLAUDE.md and the project settings.
 * CI recomputes it from the repo at the run's base commit.
 */
export async function envFingerprint(read: RepoReader | string, team: Pick<TeamConfig, "egress" | "model">): Promise<string> {
  const reader = typeof read === "string" ? fsReader(read) : read;
  const h = createHash("sha256");
  h.update(JSON.stringify(runSettings(team)));
  h.update(JSON.stringify(EMPTY_MCP));
  for (const f of ["CLAUDE.md", ".claude/settings.json"]) h.update((await reader(f)) ?? `missing:${f}`);
  return h.digest("hex");
}
