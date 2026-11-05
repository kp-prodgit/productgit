import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exec as defaultExec, type Exec } from "./exec.js";

export class Git {
  constructor(readonly cwd: string, private readonly run: Exec = defaultExec) {}

  async raw(args: string[], opts: { input?: string; cwd?: string } = {}) {
    return this.run("git", args, { cwd: opts.cwd ?? this.cwd, input: opts.input });
  }

  async ok(args: string[], opts: { input?: string; cwd?: string } = {}): Promise<string> {
    const r = await this.raw(args, opts);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim() || r.stdout.trim()}`);
    return r.stdout.trim();
  }

  async hasRemote(name = "origin"): Promise<boolean> {
    return (await this.raw(["remote", "get-url", name])).code === 0;
  }

  async head(): Promise<string> {
    return this.ok(["rev-parse", "HEAD"]);
  }

  async remoteUrl(): Promise<string | null> {
    const r = await this.raw(["remote", "get-url", "origin"]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async isClean(): Promise<boolean> {
    return (await this.ok(["status", "--porcelain"])) === "";
  }

  /** Last commit that touched `path`, for recording skill and memory versions (B5). */
  async lastCommit(path: string): Promise<string | null> {
    const r = await this.raw(["log", "-1", "--format=%H", "--", path]);
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  }

  async defaultBranch(): Promise<string> {
    const r = await this.raw(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (r.code === 0) return r.stdout.trim().replace(/^origin\//, "");
    const cur = await this.raw(["branch", "--show-current"]);
    return cur.stdout.trim() || "main";
  }

  /**
   * A worktree on `branch`, so a run or the run log never touches the PM's own checkout.
   * Creates the branch from `base` if it doesn't exist (or as an orphan when base is null).
   */
  async worktree(path: string, branch: string, base: string | null): Promise<Git> {
    await this.raw(["worktree", "prune"]);
    const existsLocal = (await this.raw(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
    const existsRemote = (await this.raw(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`])).code === 0;
    const wt = new Git(path, this.run);
    if ((await this.raw(["-C", path, "rev-parse", "--git-dir"], { cwd: this.cwd })).code === 0) return wt;
    await mkdir(join(path, ".."), { recursive: true });
    if (existsLocal) await this.ok(["worktree", "add", path, branch]);
    else if (existsRemote) await this.ok(["worktree", "add", "-b", branch, path, `origin/${branch}`]);
    else if (base) await this.ok(["worktree", "add", "-b", branch, path, base]);
    else {
      await this.ok(["worktree", "add", "--detach", path]);
      await wt.ok(["checkout", "--orphan", branch]);
      await wt.raw(["rm", "-rf", "--quiet", "."]);
    }
    return wt;
  }

  async removeWorktree(path: string): Promise<void> {
    await this.raw(["worktree", "remove", "--force", path]);
  }

  async commitAll(message: string): Promise<string | null> {
    await this.ok(["add", "-A"]);
    if ((await this.raw(["diff", "--cached", "--quiet"])).code === 0) return null;
    await this.ok(["commit", "-q", "-m", message]);
    return this.head();
  }
}

export async function writeFileIn(dir: string, rel: string, text: string): Promise<void> {
  const p = join(dir, rel);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, text);
}
