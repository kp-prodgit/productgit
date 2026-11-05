import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Git } from "../src/core/git.js";
import { RunLogStore } from "../src/core/runlog-store.js";
import { services } from "../src/core/services.js";
import type { Task } from "../src/core/types.js";
import { gitRefLease } from "../src/lease/git-ref.js";
import { pull, releaseStale } from "../src/pull/pull.js";
import { verifyPr } from "../src/run/verify.js";
import { compareReports, neutralityRun } from "../src/run/neutrality.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { parseCandidates, synthesize } from "../src/synth/synthesize.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, git, pmxRepo, testCtx, tmp, writeTranscript } from "./helpers.js";

const GOOD = `# Draft a one-pager for SCIM sync

## Problem

Admins sync users by hand [T1].

## Evidence

- Weekly CSV export [T1]
- Recurring requests [S1]

## Proposal

SCIM 2.0 provisioning.

## Success metrics

- Minutes, not hours.

## Open questions

- Which IdPs first?
`;

/** A runtime that behaves like a skill run: writes the requested output file in its working dir. */
const drafting = (content = GOOD) =>
  mockRuntime(async (o) => {
    const out = o.prompt.match(/Write the output to (\S+?\.md)/)?.[1];
    if (out && content) {
      await mkdir(dirname(join(o.cwd, out)), { recursive: true });
      await writeFile(join(o.cwd, out), content);
    }
    return { text: "Drafted a SCIM one-pager from two sources.", costUsd: 0.42 };
  });

const readyTask = (over: Partial<Task> = {}): Task => ({
  id: "lin-1", identifier: "PMX-14", title: "Draft a one-pager for SCIM sync",
  description: "Admins sync users by hand.\n\n**Sources**\n\n- [T1] Acme call: we export a CSV every Friday\n- [S1] #feedback: third SCIM ask\n\npmx:source T1\npmx:source S1",
  url: "https://linear.app/acme/issue/PMX-14", category: "spec", size: "M", status: "ready", priority: 2, agent: null,
  sources: ["T1", "S1"], prUrl: null, createdAt: "2026-11-01T00:00:00Z", ...over,
});

describe("team pull, run and run record (M3)", () => {
  beforeEach(freshHome);

  it("pulls, runs in a clean worktree, opens a PR with a run record, and CI accepts it", async () => {
    const { repo } = await pmxRepo({}, { remote: true });
    const tracker = memoryTracker([readyTask()]);
    const runtime = drafting();
    const ctx = await testCtx({ repo, runtime, now: new Date(2026, 10, 4, 10) });
    const svc = await services(ctx, { tracker });

    const r = await pull(ctx, svc, { dryRun: false });
    expect(r.ran?.outcome).toBe("ok");
    const branch = "pmx/task/PMX-14-draft-a-one-pager-for-scim-sync";
    expect(r.ran?.prUrl).toBe(`branch:${branch}`);

    // The agent got file tools only, ran in the worktree, and saw the task as data.
    const call = runtime.calls[0]!;
    expect(call.tools).toEqual(["Read", "Write", "Edit", "Glob", "Grep"]);
    expect(call.cwd).toContain("worktrees/task-PMX-14");

    const t = tracker.tasks.get("lin-1")!;
    expect(t.status).toBe("review");
    expect(tracker.comments.get("lin-1")!.at(-1)).toMatch(new RegExp(`^pmx:pr branch:${branch}`));
    expect(await svc.lease.list()).toEqual([]);

    const files = (await git(repo, "show", "--name-only", "--format=", branch)).split("\n");
    expect(files.sort()).toEqual([".pmx/runs/PMX-14.json", "outputs/spec/PMX-14.md"]);
    const record = JSON.parse(await git(repo, "show", `${branch}:.pmx/runs/PMX-14.json`));
    expect(record).toMatchObject({ provenance: "pmx-run", model: ctx.team.model, outcome: "ok", checklist: { ok: true }, agent: "ana@m1" });
    expect(record.profile.checksFailed).toEqual([]);

    const v = new RunLogStore(ctx);
    expect((await v.verify()).ok).toBe(true);
    expect((await v.entries()).filter((e) => e.type === "run")).toHaveLength(1);

    // CI (B5) accepts the clean record...
    await git(repo, "checkout", "-q", branch);
    expect(await verifyPr(new Git(repo), "main")).toMatchObject({ ok: true });
    // ...and rejects a PR whose record was produced with a different CLAUDE.md or model.
    const tampered = { ...record, model: "some-other-model" };
    await writeFile(join(repo, ".pmx/runs/PMX-14.json"), JSON.stringify(tampered));
    await git(repo, "commit", "-qam", "tamper");
    const bad = await verifyPr(new Git(repo), "main");
    expect(bad.ok).toBe(false);
    expect(bad.lines[0]).toMatch(/model some-other-model is not the team model/);
    await writeFile(join(repo, "outputs/spec/PMX-99.md"), "# hand-written");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-qm", "sneak");
    expect((await verifyPr(new Git(repo), "main")).lines.join("\n")).toMatch(/PMX-99: no run record/);
  });

  it("a failed run puts the task back to ready with a comment and opens no PR", async () => {
    const { repo } = await pmxRepo({}, { remote: true });
    const tracker = memoryTracker([readyTask()]);
    const ctx = await testCtx({ repo, runtime: drafting(""), now: new Date(2026, 10, 4, 10) });
    const r = await pull(ctx, await services(ctx, { tracker }), { dryRun: false });
    expect(r.ran?.outcome).toBe("failed");
    expect(tracker.tasks.get("lin-1")).toMatchObject({ status: "ready", agent: null });
    expect(tracker.comments.get("lin-1")![0]).toMatch(/did not produce a draft/);
    expect(await git(repo, "branch", "--list", "pmx/task/*")).toBe("");
  });

  it("the kill switch stops every puller", async () => {
    const { repo } = await pmxRepo({}, { remote: true });
    await writeFile(join(repo, "pmx.stop"), "incident 42");
    await git(repo, "add", "pmx.stop");
    await git(repo, "commit", "-qm", "stop");
    await git(repo, "push", "-q", "origin", "main");
    const tracker = memoryTracker([readyTask()]);
    const ctx = await testCtx({ repo, runtime: drafting(), now: new Date(2026, 10, 4, 10) });
    const r = await pull(ctx, await services(ctx, { tracker }), { dryRun: false });
    expect(r.text).toMatch(/Kill switch is on \(incident 42\)/);
    expect(tracker.tasks.get("lin-1")!.status).toBe("ready");
  });

  it("two machines pulling one shared queue: exactly one runs the task", async () => {
    const { repo, origin } = await pmxRepo({}, { remote: true });
    const repoB = join(await tmp(), "pmx-b");
    await (await import("../src/core/exec.js")).execOk("git", ["clone", "-q", origin!, repoB]);
    await git(repoB, "config", "user.email", "b@example.com");
    await git(repoB, "config", "user.name", "B");
    const tracker = memoryTracker([readyTask()]);
    const a = await testCtx({ repo, runtime: drafting(), now: new Date(2026, 10, 4, 10) });
    const b = await testCtx({ repo: repoB, runtime: drafting(), now: new Date(2026, 10, 4, 10), personal: { handle: "raj", machineId: "m2" } });
    const [ra, rb] = await Promise.all([
      pull(a, await services(a, { tracker }), { dryRun: false }),
      pull(b, await services(b, { tracker }), { dryRun: false }),
    ]);
    expect([ra.ran, rb.ran].filter(Boolean)).toHaveLength(1);
    expect((a.runtime as any).calls.length + (b.runtime as any).calls.length).toBe(1);
  });

  it("releases stale claims on tasks that aren't running, but not on running ones", async () => {
    const { repo } = await pmxRepo({}, { remote: true });
    const tracker = memoryTracker([readyTask({ id: "a", identifier: "PMX-1", status: "claimed", agent: "raj@m2" }), readyTask({ id: "b", identifier: "PMX-2", status: "running", agent: "raj@m2" })]);
    const old = gitRefLease(new Git(repo), () => new Date("2026-11-04T08:00:00Z"));
    await old.acquire("a", "raj@m2", 60);
    await old.acquire("b", "raj@m2", 60);
    const ctx = await testCtx({ repo, now: new Date("2026-11-04T10:00:00Z") });
    const svc = await services(ctx, { tracker });
    const r = await releaseStale(ctx, svc);
    expect(r).toEqual([expect.stringMatching(/released stale claim on PMX-1 \(held by raj@m2/)]);
    expect(tracker.tasks.get("a")).toMatchObject({ status: "ready", agent: null });
    expect(tracker.tasks.get("b")!.status).toBe("running");
    expect((await svc.lease.list()).map((l) => l.taskId)).toEqual(["b"]);
  });
});

describe("synthesis (SIG-2, SIG-4, SEC-1)", () => {
  beforeEach(freshHome);

  it("validates candidates against team config and real source IDs", () => {
    const r = parseCandidates(
      'Here you go: {"tasks": [{"title": "A", "category": "spec", "size": "M", "rationale": "r", "sources": ["T1"]}, {"title": "B", "category": "roadmap", "size": "M", "sources": ["T1"]}, {"title": "C", "category": "spec", "size": "XXL", "sources": ["T1"]}, {"title": "D", "category": "spec", "size": "S", "sources": ["T9"]}]}',
      ["spec"], new Set(["T1"]),
    );
    expect(r.tasks.map((t) => t.title)).toEqual(["A"]);
    expect(r.skipped).toHaveLength(3);
  });

  it("posts only to the inbox, with no tools, skipping duplicates", async () => {
    const { repo } = await pmxRepo();
    const dir = await tmp("t-");
    await writeTranscript(dir, "acme.md", "---\ntitle: Acme\nparticipants: jane@acme.com\n---\nJane: We export a CSV every Friday; SCIM would fix it.");
    const runtime = mockRuntime(() => JSON.stringify({ tasks: [
      { title: "Draft a one-pager for SCIM sync", category: "spec", size: "M", rationale: "Manual sync.", sources: ["T1"] },
      { title: "Synthesize onboarding friction", category: "research-synthesis", size: "S", rationale: "x", sources: ["T1"] },
    ] }));
    const tracker = memoryTracker([readyTask({ id: "x", status: "ready" })]);
    const ctx = await testCtx({ repo, runtime, personal: { sources: { transcriptDirs: [dir], slackChannel: null } } });
    const r = await synthesize(ctx, await services(ctx, { tracker }), { days: 7 });
    expect(runtime.calls[0]!.tools).toEqual([]);
    expect(r.posted.map((p) => p.title)).toEqual(["Synthesize onboarding friction"]);
    expect(r.skipped[0]).toMatch(/already in the PMX project/);
    const created = [...tracker.tasks.values()].find((t) => t.title === "Synthesize onboarding friction")!;
    expect(created).toMatchObject({ status: "inbox", size: "S", sources: ["T1"] });
    expect(created.description).toContain("[T1] Acme");
    expect(created.description).toContain("pmx:source T1");
  });
});

describe("neutrality test (B6)", () => {
  beforeEach(freshHome);

  it("two machines with the same repo produce matching reports; a changed CLAUDE.md doesn't", async () => {
    const { repo, origin } = await pmxRepo({}, { remote: true });
    const canned: Record<string, string> = {};
    const { readFile } = await import("node:fs/promises");
    for (const s of ["pmx-research", "pmx-competitive", "pmx-hygiene", "pmx-spec"])
      canned[s] = await readFile(join(repo, ".claude/skills", s, "fixtures/expected.md"), "utf8");
    const rt = () => mockRuntime(async (o) => {
      const out = o.prompt.match(/Write the output to (\S+?)\.?$/m)![1]!;
      const skill = Object.keys(canned).find((k) => o.prompt.includes(`# ${k === "pmx-research" ? "Research synthesis" : k === "pmx-competitive" ? "Competitive analysis" : k === "pmx-hygiene" ? "Tracking hygiene" : "Spec draft"}`))!;
      await mkdir(dirname(join(o.cwd, out)), { recursive: true });
      await writeFile(join(o.cwd, out), canned[skill]!);
      return "ok";
    });

    const a = await neutralityRun(await testCtx({ repo, runtime: rt() }));
    process.env.PMX_HOME = await tmp("pmx-home-b-");
    const repoB = join(await tmp(), "b");
    await (await import("../src/core/exec.js")).execOk("git", ["clone", "-q", origin!, repoB]);
    const b = await neutralityRun(await testCtx({ repo: repoB, runtime: rt(), personal: { handle: "raj", machineId: "m2" } }));
    expect(a.entries.every((e) => e.checklistOk)).toBe(true);
    expect(compareReports(a, b)).toMatchObject({ ok: true });

    await writeFile(join(repoB, "CLAUDE.md"), "# Personal tweaks\nAlways be brief.");
    await git(repoB, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-qam", "drift");
    const c = await neutralityRun(await testCtx({ repo: repoB, runtime: rt(), personal: { handle: "raj", machineId: "m2" } }));
    const cmp = compareReports(a, c);
    expect(cmp.ok).toBe(false);
    expect(cmp.lines[0]).toMatch(/environment fingerprint differs/);
  });
});
