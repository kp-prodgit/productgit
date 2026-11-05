import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "./exec.js";
import { packageRoot } from "./skills.js";

/**
 * The newest schema of each file PMX writes (COMPAT-3). A reader refuses a file with a higher number,
 * so an old CLI never misreads or overwrites what a newer one wrote. Raise a number only for a change
 * old readers would get wrong; adding an optional field never needs it.
 */
export const SCHEMA = { teamConfig: 1, personalConfig: 1, receipt: 1, todos: 1 } as const;

/** Thrown when this CLI is too old for the team or for a file. Commands print it as-is. */
export class CompatError extends Error {
  readonly name = "CompatError";
}

let cached: string | null = null;
/** This CLI's version (synchronous, read once). */
export function currentVersion(): string {
  cached ??= JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")).version as string;
  return cached;
}

const parse = (v: string) => {
  const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

export const isVersion = (v: unknown): v is string => typeof v === "string" && parse(v) !== null;

/** -1, 0 or 1 by major, minor, patch; null if either isn't a version. */
export function compareVersions(a: string, b: string): number | null {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

export const atLeast = (v: string, min: string) => (compareVersions(v, min) ?? 0) >= 0;

export const UPDATE_HINT = "Run `pmx update` to install your team's version.";

/** COMPAT-3: refuses a file written with a newer schema than this CLI knows. */
export function assertSchema(kind: keyof typeof SCHEMA, v: unknown, where: string): void {
  if (typeof v === "number" && v > SCHEMA[kind])
    throw new CompatError(`${where} was written by a newer pmx (format ${v}; pmx ${currentVersion()} reads up to ${SCHEMA[kind]}). ${UPDATE_HINT}`);
}

/**
 * COMPAT-2: work that writes shared team state (tracker, leases, the meeting ledger, the brain, the
 * company roll-up) needs at least the team's minimum CLI version. Personal work never checks this.
 */
export function assertTeamVersion(team: { cli?: { min: string } | null }, version = currentVersion()): void {
  const min = team.cli?.min;
  if (min && !atLeast(version, min))
    throw new CompatError(`This machine runs pmx ${version}, and your team needs ${min} or newer for shared work. Your digest, to-dos and explain still work. ${UPDATE_HINT}`);
}

/** The version of the CLI package stored in the PMX repo, read from inside the .tgz. */
export async function vendoredVersion(tgz: string, exec: Exec): Promise<string | null> {
  const r = await exec("tar", ["-xOzf", tgz, "package/package.json"], { timeoutMs: 20000 });
  if (r.code !== 0) return null;
  try {
    const v = JSON.parse(r.stdout).version;
    return isVersion(v) ? v : null;
  } catch {
    return null;
  }
}
