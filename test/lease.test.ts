import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execOk } from "../src/core/exec.js";
import { Git } from "../src/core/git.js";
import { gitRefLease } from "../src/lease/git-ref.js";
import { git, initRepo, tmp } from "./helpers.js";

/** Two clones of one bare origin stand in for two PMs' machines. */
async function twoMachines() {
  const root = await tmp("pmx-race-");
  const origin = join(root, "origin.git");
  await execOk("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = join(root, "seed");
  await initRepo(seed);
  await git(seed, "commit", "-q", "--allow-empty", "-m", "init");
  await git(seed, "remote", "add", "origin", origin);
  await git(seed, "push", "-q", "origin", "main");
  const clone = async (name: string) => {
    const d = join(root, name);
    await execOk("git", ["clone", "-q", origin, d]);
    return new Git(d);
  };
  return { a: await clone("a"), b: await clone("b"), origin };
}

describe("git-ref lease (PULL-6, MET-8)", () => {
  it("two machines racing for the same tasks: exactly one winner each time", async () => {
    const { a, b } = await twoMachines();
    const la = gitRefLease(a);
    const lb = gitRefLease(b);
    for (let i = 0; i < 6; i++) {
      const id = `task-${i}`;
      const [ra, rb] = await Promise.all([la.acquire(id, "ana@m1", 600), lb.acquire(id, "raj@m2", 600)]);
      expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);
      const loser = ra.ok ? rb : ra;
      expect(loser.ok).toBe(false);
      if (!loser.ok) expect(loser.holder).toBe(ra.ok ? "ana@m1" : "raj@m2");
    }
    expect(await la.list()).toHaveLength(6);
  });

  it("re-acquiring your own lease is idempotent; others can't release it", async () => {
    const { a, b } = await twoMachines();
    const la = gitRefLease(a);
    const lb = gitRefLease(b);
    const first = await la.acquire("t1", "ana@m1", 600);
    const again = await la.acquire("t1", "ana@m1", 600);
    expect(first.ok && again.ok && first.lease.token === again.lease.token).toBe(true);
    expect(await lb.release("t1", "raj@m2")).toBe(false);
    expect(await la.release("t1", "ana@m1")).toBe(true);
    expect((await lb.acquire("t1", "raj@m2", 600)).ok).toBe(true);
  });

  it("force release needs the current token, so a stale releaser can't drop a fresh claim", async () => {
    const { a, b } = await twoMachines();
    const la = gitRefLease(a, () => new Date("2026-11-03T10:00:00Z"));
    const lb = gitRefLease(b, () => new Date("2026-11-03T12:00:00Z"));
    const old = await la.acquire("t2", "ana@m1", 60);
    if (!old.ok) throw new Error("expected win");
    expect(await lb.forceRelease("t2", old.lease.token)).toBe(true);
    const fresh = await lb.acquire("t2", "raj@m2", 600);
    expect(fresh.ok).toBe(true);
    expect(await la.forceRelease("t2", old.lease.token)).toBe(false);
    expect((await la.list()).map((l) => l.holder)).toEqual(["raj@m2"]);
  });

  it("works on a single machine without a remote", async () => {
    const d = await tmp();
    await initRepo(d);
    await git(d, "commit", "-q", "--allow-empty", "-m", "init");
    const l = gitRefLease(new Git(d));
    expect((await l.acquire("x", "ana@m1", 60)).ok).toBe(true);
    expect((await l.acquire("x", "raj@m2", 60)).ok).toBe(false);
    expect(await l.release("x", "ana@m1")).toBe(true);
  });
});
