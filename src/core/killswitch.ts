import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Git } from "./git.js";
import { KILL_SWITCH_FILE } from "./paths.js";

/**
 * The team kill switch (SEC-6): a `pmx.stop` file on the PMX repo's default branch.
 * Every puller checks the remote copy, so one commit stops every machine.
 * A local `pmx.stop` in the PM's checkout also stops their own agent, without a commit.
 */
export async function killSwitchOn(repo: Git): Promise<{ on: boolean; reason: string | null }> {
  const base = await repo.defaultBranch();
  let ref = base;
  if (await repo.hasRemote()) {
    await repo.raw(["fetch", "--quiet", "origin", base]);
    ref = `origin/${base}`;
  }
  const r = await repo.raw(["show", `${ref}:${KILL_SWITCH_FILE}`]);
  if (r.code === 0) return { on: true, reason: r.stdout.trim() || "no reason given" };
  const local = await stat(join(repo.cwd, KILL_SWITCH_FILE)).then(() => true, () => false);
  return local ? { on: true, reason: "local pmx.stop file" } : { on: false, reason: null };
}
