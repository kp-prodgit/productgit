import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Exec } from "./exec.js";
import { packageRoot } from "./skills.js";
import { VENDORED_CLI } from "./vendor.js";
import { compareVersions, currentVersion, vendoredVersion } from "./version.js";

export type UpdateOutcome =
  | { result: "updated"; version: string }
  | { result: "current"; version: string }
  | { result: "no-package" }
  | { result: "dev-install"; version: string }
  | { result: "needs-sudo"; version: string; command: string }
  | { result: "failed"; version: string; error: string };

/** A pmx run from a source checkout (`npm link` or a symlink to dist): never overwritten by an update. */
export async function isDevInstall(root = process.env.PMX_INSTALL_ROOT_FOR_TESTS ?? packageRoot()): Promise<boolean> {
  return stat(join(root, ".git")).then(() => true, () => false);
}

/**
 * Installs the CLI package from the PMX repo when it's newer than this one (COMPAT-2, COMPAT-6). Never
 * downgrades. The package is code-owner reviewed in the repo (`/.pmx/cli/` in CODEOWNERS), so this
 * installs only what the team approved. Shared by `pmx update` and the background job.
 */
export async function installTeamVersion(repoPath: string, exec: Exec, o: { force?: boolean; pull?: boolean } = {}): Promise<UpdateOutcome> {
  if (o.pull) await exec("git", ["-C", repoPath, "pull", "--ff-only", "--quiet"], { timeoutMs: 60000 });
  const tgz = join(repoPath, VENDORED_CLI);
  const version = await vendoredVersion(tgz, exec);
  if (!version) return { result: "no-package" };
  if ((compareVersions(version, currentVersion()) ?? 0) <= 0 && !o.force) return { result: "current", version };
  if (await isDevInstall()) return { result: "dev-install", version };
  const r = await exec("npm", ["install", "-g", tgz], { timeoutMs: 300000 });
  if (r.code === 0) return { result: "updated", version };
  if (/EACCES|permission denied/i.test(r.stderr)) return { result: "needs-sudo", version, command: `sudo npm install -g "${tgz}"` };
  return { result: "failed", version, error: r.stderr.trim().split("\n").slice(-3).join(" ") || `npm exited ${r.code}` };
}
