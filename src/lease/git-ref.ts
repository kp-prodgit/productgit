import type { Git } from "../core/git.js";
import type { Acquire, LeaseInfo, LeaseProvider } from "./types.js";

const PREFIX = "refs/pmx/claims";
const MIRROR = "refs/pmx/remote-claims";
const ZERO = "0000000000000000000000000000000000000000";

const safeId = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_");

/**
 * Git-ref lease. A claim is a parentless commit pushed to `refs/pmx/claims/<task id>`.
 * Pushing without force only succeeds if the ref doesn't exist yet, and two parentless commits
 * are never fast-forwards of each other, so exactly one push wins.
 *
 * Without a remote (one machine), `git update-ref <ref> <new> <zero>` gives the same guarantee.
 */
export function gitRefLease(git: Git, now: () => Date = () => new Date()): LeaseProvider {
  async function emptyTree(): Promise<string> {
    return git.ok(["mktree"], { input: "" });
  }

  async function makeClaim(info: Omit<LeaseInfo, "token">): Promise<string> {
    const tree = await emptyTree();
    return git.ok(
      ["-c", "user.name=pmx", "-c", "user.email=pmx@localhost", "commit-tree", tree, "-m", JSON.stringify(info)],
    );
  }

  async function readClaim(ref: string): Promise<LeaseInfo | null> {
    const r = await git.raw(["log", "-1", "--format=%H%n%B", ref]);
    if (r.code !== 0) return null;
    const [sha, ...msg] = r.stdout.trim().split("\n");
    try {
      return { ...(JSON.parse(msg.join("\n")) as Omit<LeaseInfo, "token">), token: sha! };
    } catch {
      return null;
    }
  }

  async function remote(): Promise<boolean> {
    return git.hasRemote();
  }

  async function current(taskId: string): Promise<LeaseInfo | null> {
    const ref = `${PREFIX}/${safeId(taskId)}`;
    if (await remote()) {
      const r = await git.raw(["fetch", "--quiet", "origin", `+${ref}:${MIRROR}/${safeId(taskId)}`]);
      if (r.code !== 0) {
        await git.raw(["update-ref", "-d", `${MIRROR}/${safeId(taskId)}`]);
        return null;
      }
      return readClaim(`${MIRROR}/${safeId(taskId)}`);
    }
    return readClaim(ref);
  }

  return {
    kind: "git",

    async acquire(taskId, holder, ttlSeconds): Promise<Acquire> {
      const at = now();
      const info = { taskId, holder, acquiredAt: at.toISOString(), expiresAt: new Date(at.getTime() + ttlSeconds * 1000).toISOString() };
      const sha = await makeClaim(info);
      const ref = `${PREFIX}/${safeId(taskId)}`;
      const won = (await remote())
        ? (await git.raw(["push", "--quiet", "--porcelain", "origin", `${sha}:${ref}`])).code === 0
        : (await git.raw(["update-ref", ref, sha, ZERO])).code === 0;
      if (won) return { ok: true, lease: { ...info, token: sha } };
      const cur = await current(taskId);
      if (cur?.holder === holder) return { ok: true, lease: cur };
      return { ok: false, holder: cur?.holder ?? "unknown", expiresAt: cur?.expiresAt ?? info.expiresAt };
    },

    async release(taskId, holder) {
      const cur = await current(taskId);
      if (!cur) return true;
      if (cur.holder !== holder) return false;
      return this.forceRelease(taskId, cur.token);
    },

    async forceRelease(taskId, expectedToken) {
      const ref = `${PREFIX}/${safeId(taskId)}`;
      if (await remote()) {
        const r = await git.raw(["push", "--quiet", `--force-with-lease=${ref}:${expectedToken}`, "origin", `:${ref}`]);
        await git.raw(["update-ref", "-d", `${MIRROR}/${safeId(taskId)}`]);
        return r.code === 0;
      }
      return (await git.raw(["update-ref", "-d", ref, expectedToken])).code === 0;
    },

    async list() {
      let base = PREFIX;
      if (await remote()) {
        await git.raw(["fetch", "--quiet", "--prune", "origin", `+${PREFIX}/*:${MIRROR}/*`]);
        base = MIRROR;
      }
      const refs = (await git.ok(["for-each-ref", "--format=%(refname)", base])).split("\n").filter(Boolean);
      const out: LeaseInfo[] = [];
      for (const r of refs) {
        const c = await readClaim(r);
        if (c) out.push(c);
      }
      return out;
    },
  };
}
