import { rm } from "node:fs/promises";
import type { Asker } from "../core/ask.js";
import type { Out } from "../core/context.js";
import type { Exec } from "../core/exec.js";
import type { Keychain, SecretName } from "../core/keychain.js";
import type { Launchd } from "../core/launchd.js";
import { readJson } from "../core/fsutil.js";
import { paths, pmxHome } from "../core/paths.js";

/**
 * `pmx uninstall` (CLI-4): removes the launchd job, the clean profile, staged drafts, worktrees,
 * personal config and keychain items. The PMX repo and its shared skills are team assets and stay.
 */
export async function runUninstall(d: { ask: Asker; keychain: Keychain; launchd: Launchd; exec: Exec; out: Out; yes?: boolean }): Promise<void> {
  if (!d.yes && !(await d.ask.confirm(`Remove Product Git from this Mac (${pmxHome()}, the background job and keychain items)?`, false))) {
    d.out.info("Nothing removed.");
    return;
  }
  await d.launchd.uninstall();
  const names: SecretName[] = ["slack-token", "linear-token", "github-token", "machine-token", "anthropic-api-key"];
  for (const n of names) await d.keychain.delete(n);
  const cfg = await readJson<{ repoPath?: string }>(paths.config());
  await rm(pmxHome(), { recursive: true, force: true });
  if (cfg?.repoPath) await d.exec("git", ["worktree", "prune"], { cwd: cfg.repoPath });
  d.out.info("Removed the background job, keychain items and ~/.pmx. Your PMX repo checkout was left as is.");
}
