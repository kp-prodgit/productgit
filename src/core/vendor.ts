import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Exec } from "./exec.js";
import { packageRoot } from "./skills.js";

/** Where a PMX repo keeps the CLI package its PMs and its CI install. */
export const VENDORED_CLI = ".pmx/cli/productgit.tgz";

export async function cliVersion(): Promise<string> {
  return JSON.parse(await readFile(join(packageRoot(), "package.json"), "utf8")).version;
}

/**
 * Packs the running CLI into the PMX repo. Teammates install that exact build with
 * `npm install -g .pmx/cli/productgit.tgz`, and the run-record CI check installs it from the
 * base branch, so every machine and CI compute fingerprints with the same version.
 * Works from an installed copy too: it packs the package's own files, without build scripts.
 */
export async function vendorCli(repoPath: string, exec: Exec): Promise<string> {
  const dir = join(repoPath, ".pmx", "cli");
  await mkdir(dir, { recursive: true });
  const r = await exec("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", dir, packageRoot()], { timeoutMs: 120000 });
  if (r.code !== 0) throw new Error(`npm pack failed: ${r.stderr.trim()}`);
  const [packed] = JSON.parse(r.stdout) as { filename: string; version: string }[];
  if (!packed) throw new Error("npm pack produced no package.");
  await rename(join(dir, packed.filename), join(repoPath, VENDORED_CLI));
  return packed.version;
}
