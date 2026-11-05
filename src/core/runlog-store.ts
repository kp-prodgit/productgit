import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { Ctx } from "./context.js";
import { Git } from "./git.js";
import { paths, RUNLOG_BRANCH } from "./paths.js";
import { append, readAll, verify, type NewEntry, type RunLogEntry, type VerifyResult } from "./runlog.js";

/**
 * The run log lives on its own branch, `pmx/runlog`, checked out in a private worktree.
 * It holds no customer content, so it doesn't wait for review the way outputs do, and
 * it never touches main (which is PR-only, SEC-5).
 */
export class RunLogStore {
  private wt: Git | null = null;
  constructor(private readonly ctx: Pick<Ctx, "repo" | "exec">) {}

  private async tree(): Promise<Git> {
    if (this.wt) return this.wt;
    const repo = this.ctx.repo;
    if (await repo.hasRemote()) await repo.raw(["fetch", "--quiet", "origin", `+refs/heads/${RUNLOG_BRANCH}:refs/remotes/origin/${RUNLOG_BRANCH}`]);
    const dir = join(paths.worktrees(), `runlog-${Buffer.from(repo.cwd).toString("base64url").slice(-16)}`);
    const wt = await repo.worktree(dir, RUNLOG_BRANCH, null);
    await writeFile(join(dir, ".gitattributes"), "runs/*.jsonl merge=union\n");
    this.wt = wt;
    return wt;
  }

  /** True once any machine has written to the run log. Has no side effects. */
  async exists(): Promise<boolean> {
    const repo = this.ctx.repo;
    for (const ref of [`refs/heads/${RUNLOG_BRANCH}`, `refs/remotes/origin/${RUNLOG_BRANCH}`])
      if ((await repo.raw(["rev-parse", "--verify", "--quiet", ref])).code === 0) return true;
    return false;
  }

  async dir(): Promise<string> {
    return (await this.tree()).cwd;
  }

  private async sync(wt: Git): Promise<void> {
    if (!(await this.ctx.repo.hasRemote())) return;
    const remote = await wt.raw(["ls-remote", "--exit-code", "origin", `refs/heads/${RUNLOG_BRANCH}`]);
    if (remote.code === 0) {
      await wt.ok(["fetch", "--quiet", "origin", RUNLOG_BRANCH]);
      await wt.ok(["-c", "user.name=pmx", "-c", "user.email=pmx@localhost", "rebase", "--quiet", "FETCH_HEAD"]);
    }
  }

  async record(e: NewEntry): Promise<RunLogEntry> {
    const wt = await this.tree();
    for (let attempt = 0; ; attempt++) {
      await this.sync(wt);
      const entry = await append(wt.cwd, e);
      await wt.ok(["add", "-A"]);
      await wt.ok(["-c", "user.name=pmx", "-c", `user.email=${e.agent.replace(/[^\w.@-]/g, "")}`, "commit", "-q", "-m", `runlog: ${e.type} ${e.agent}`]);
      if (!(await this.ctx.repo.hasRemote())) return entry;
      const push = await wt.raw(["push", "--quiet", "origin", `HEAD:refs/heads/${RUNLOG_BRANCH}`]);
      if (push.code === 0) return entry;
      // Someone else pushed first: drop our commit, sync, and append again so our chain stays valid.
      await wt.ok(["fetch", "--quiet", "origin", RUNLOG_BRANCH]);
      await wt.ok(["reset", "--hard", "--quiet", "FETCH_HEAD"]);
      if (attempt >= 4) throw new Error(`Could not push the run log: ${push.stderr.trim()}`);
    }
  }

  async entries(): Promise<RunLogEntry[]> {
    const wt = await this.tree();
    await this.sync(wt).catch(() => {});
    return readAll(wt.cwd);
  }

  async verify(): Promise<VerifyResult> {
    return verify(await this.entries());
  }
}
