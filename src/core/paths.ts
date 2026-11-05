import { homedir } from "node:os";
import { join } from "node:path";

/** Root of everything personal to this machine. Never synced (PRIV-1). */
export function pmxHome(): string {
  return process.env.PMX_HOME ?? join(homedir(), ".pmx");
}

export const paths = {
  home: () => pmxHome(),
  config: () => join(pmxHome(), "config.json"),
  state: () => join(pmxHome(), "state.json"),
  policy: () => join(pmxHome(), "policy.json"),
  license: () => join(pmxHome(), "license.jwt"),
  /** The clean Claude Code profile (B1). */
  claudeProfile: () => join(pmxHome(), "claude"),
  runSettings: () => join(pmxHome(), "claude", "pmx-run-settings.json"),
  mcpConfig: () => join(pmxHome(), "claude", "pmx-mcp.json"),
  staging: () => join(pmxHome(), "staging"),
  /** Run receipts for `pmx explain` (PRIV-4): private, local, never synced. */
  receipts: () => join(pmxHome(), "receipts"),
  /** The brain's assessments and approval queue (BRAIN-4): private, local, never synced. */
  brain: () => join(pmxHome(), "brain"),
  transcripts: () => join(pmxHome(), "transcripts"),
  worktrees: () => join(pmxHome(), "worktrees"),
  logs: () => join(pmxHome(), "logs"),
  launchAgent: () => join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
};

export const LAUNCHD_LABEL = "com.productgit.pmx";
export const KEYCHAIN_SERVICE = "productgit";
export const TEAM_CONFIG_FILE = "pmx.config.json";
export const KILL_SWITCH_FILE = "pmx.stop";
export const RUNLOG_BRANCH = "pmx/runlog";
