import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Exec } from "./exec.js";
import { cleanEnv } from "./profile.js";

export interface ClaudeBin {
  /** What to run: "claude" when it's on PATH, otherwise the absolute path where PMX found it. */
  cmd: string;
  version: string;
  onPath: boolean;
}

/**
 * Where Claude Code's installers put `claude`. The native installer uses ~/.local/bin, which many shells
 * (and the Claude app's own terminal) don't have on PATH, so PMX looks there itself instead of failing.
 */
export const claudeCandidates = (home = homedir()) => [
  join(home, ".local/bin/claude"),
  join(home, ".claude/local/claude"),
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
];

const cache = new WeakMap<Exec, Promise<ClaudeBin | null>>();

/** Finds Claude Code, on PATH or in an installer's usual folder. Null when it isn't installed. */
export function resolveClaude(exec: Exec): Promise<ClaudeBin | null> {
  let p = cache.get(exec);
  if (!p) {
    p = (async () => {
      // PMX_CLAUDE is where `pmx init` found Claude Code; the background job gets it because launchd has no shell PATH.
      const pinned = process.env.PMX_CLAUDE ? [process.env.PMX_CLAUDE] : [];
      for (const cmd of [...pinned, "claude", ...claudeCandidates()]) {
        const r = await exec(cmd, ["--version"], { timeoutMs: 15000 });
        if (r.code === 0) return { cmd, version: r.stdout.trim(), onPath: cmd === "claude" };
      }
      return null;
    })();
    cache.set(exec, p);
  }
  return p;
}

/**
 * Claude Code's absolute path, for the background job. An npm install under nvm lives in a folder only the
 * interactive shell has on PATH, so the job would fail with "spawn claude ENOENT" without it.
 */
export async function claudeAbsolutePath(exec: Exec, pathEnv = process.env.PATH ?? ""): Promise<string | null> {
  const c = await resolveClaude(exec);
  if (!c) return null;
  if (c.cmd.startsWith("/")) return c.cmd;
  for (const dir of pathEnv.split(":").filter(Boolean)) {
    const p = join(dir, "claude");
    if (await access(p, constants.X_OK).then(() => true, () => false)) return p;
  }
  return null;
}

/** The command that signs in PMX's own Claude profile. Each config folder has its own sign-in. */
export const LOGIN_HINT = "run `pmx claude login` (it signs in PMX's own Claude profile, separate from your usual one)";

/**
 * Whether PMX's clean profile is signed in, from `claude auth status`. Null when Claude Code is missing or too
 * old to say. A profile that isn't signed in makes every run fail with "Not logged in".
 */
export async function profileSignedIn(exec: Exec): Promise<{ ok: boolean; detail: string } | null> {
  const c = await resolveClaude(exec);
  if (!c) return null;
  const r = await exec(c.cmd, ["auth", "status", "--json"], { env: cleanEnv(), timeoutMs: 15000 });
  let j: any;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  if (typeof j?.loggedIn !== "boolean") return null;
  return j.loggedIn
    ? { ok: true, detail: `PMX's Claude profile is signed in${j.email ? ` as ${j.email}` : ""}` }
    : { ok: false, detail: `PMX's Claude profile isn't signed in, so every agent run fails: ${LOGIN_HINT}` };
}

/** `claude auth login` against PMX's profile, in this terminal. Resolves with its exit code. */
export async function loginProfile(exec: Exec): Promise<number> {
  const c = await resolveClaude(exec);
  if (!c) throw new Error("Claude Code is not installed (https://code.claude.com).");
  return new Promise((resolve) => {
    const child = spawn(c.cmd, ["auth", "login"], { env: cleanEnv(), stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

/** The Node versions PMX supports: 22.12 or later in the 22 line, or 24 and up. Matches `engines`. */
export function nodeSupported(version = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return (major === 22 && minor >= 12) || major >= 24;
}
