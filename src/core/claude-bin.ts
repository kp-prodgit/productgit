import { homedir } from "node:os";
import { join } from "node:path";
import type { Exec } from "./exec.js";

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
      for (const cmd of ["claude", ...claudeCandidates()]) {
        const r = await exec(cmd, ["--version"], { timeoutMs: 15000 });
        if (r.code === 0) return { cmd, version: r.stdout.trim(), onPath: cmd === "claude" };
      }
      return null;
    })();
    cache.set(exec, p);
  }
  return p;
}

/** The Node versions PMX supports: 22.12 or later in the 22 line, or 24 and up. Matches `engines`. */
export function nodeSupported(version = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return (major === 22 && minor >= 12) || major >= 24;
}
