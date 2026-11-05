import type { AgentRuntime } from "../runtime/types.js";
import type { Fetch } from "../sources/slack.js";
import { agentHandle, type PersonalConfig, type TeamConfig } from "./config.js";
import type { Exec } from "./exec.js";
import { Git } from "./git.js";
import type { Keychain } from "./keychain.js";
import type { Launchd } from "./launchd.js";

/** Everything a command needs, injected so tests can swap the keychain, launchd, network and model. */
export interface Ctx {
  team: TeamConfig;
  personal: PersonalConfig;
  runtime: AgentRuntime;
  keychain: Keychain;
  launchd: Launchd;
  fetch: Fetch;
  exec: Exec;
  now: () => Date;
  out: Out;
  repo: Git;
  agent: string;
}

export interface Out {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const consoleOut: Out = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

export function makeCtx(p: Omit<Ctx, "repo" | "agent">): Ctx {
  return { ...p, repo: new Git(p.personal.repoPath, p.exec), agent: agentHandle(p.personal) };
}

/** ISO week, e.g. `2026-W45`, used to name digests. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}
