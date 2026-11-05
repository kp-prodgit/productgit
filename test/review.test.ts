import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { pausedFrom } from "../ee/src/autopause.js";
import { calibrate } from "../src/commands/doctor.js";
import { DEFAULT_TEAM, type TeamConfig } from "../src/core/config.js";
import { RunLogStore } from "../src/core/runlog-store.js";
import type { RunLogEntry } from "../src/core/runlog.js";
import { services } from "../src/core/services.js";
import type { Task } from "../src/core/types.js";
import { pull } from "../src/pull/pull.js";
import { renderMarkdown } from "../src/review/markdown.js";
import { acceptStats, decide, loadQueue } from "../src/review/queue.js";
import { startReviewServer } from "../src/review/server.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, git, pmxRepo, testCtx } from "./helpers.js";

const DRAFT = "# Draft\n\n## Problem\n\nManual sync [T1].\n\n## Evidence\n\n- CSV export [T1]\n- Requests [S1]\n\n## Proposal\n\nSCIM.\n\n## Success metrics\n\n- Fast.\n\n## Open questions\n\n- IdPs?\n";

const task = (over: Partial<Task> = {}): Task => ({
  id: "lin-1", identifier: "PMX-14", title: "Draft a one-pager for SCIM sync",
  description: "Why.\n\n**Sources**\n\n- [T1] Acme call: we export a CSV every Friday\n- [S1] #feedback: third SCIM ask\n\npmx:source T1\npmx:source S1",
  url: "https://linear.app/x/PMX-14", category: "spec", size: "M", status: "ready", priority: 2, agent: null,
  sources: ["T1", "S1"], prUrl: null, createdAt: "2026-11-01T00:00:00Z", ...over,
});

const drafting = () =>
  mockRuntime(async (o) => {
    const out = o.prompt.match(/Write the output to (\S+?\.md)/)![1]!;
    await mkdir(dirname(join(o.cwd, out)), { recursive: true });
    await writeFile(join(o.cwd, out), DRAFT);
    return { text: "Drafted.", costUsd: 0.3 };
  });

async function drafted() {
  const { repo } = await pmxRepo();
  const tracker = memoryTracker([task()]);
  const runtime = drafting();
  const ctx = await testCtx({ repo, runtime, now: new Date(2026, 10, 4, 10) });
  const svc = await services(ctx, { tracker });
  const r = await pull(ctx, svc, { dryRun: false });
  expect(r.ran?.outcome).toBe("ok");
  return { repo, tracker, ctx, svc, runtime };
}

describe("pmx review (REV-1, REV-2)", () => {
  beforeEach(freshHome);

  it("lists my drafts with files, run record and citation quotes, and accept merges", async () => {
    const { repo, tracker, ctx, svc } = await drafted();
    const { items, host } = await loadQueue(ctx, svc);
    expect(items).toHaveLength(1);
    expect(items[0]!.files.map((f) => f.path)).toEqual(["outputs/spec/PMX-14.md"]);
    expect(items[0]!.record?.checklist.ok).toBe(true);
    expect(items[0]!.citations.T1).toMatch(/Acme call/);

    await decide(ctx, svc, host, items[0]!, "accepted", { reviewMinutes: 4 });
    expect(tracker.tasks.get("lin-1")!.status).toBe("done");
    expect(await git(repo, "show", "main:outputs/spec/PMX-14.md")).toContain("SCIM");
    const verdicts = (await new RunLogStore(ctx).entries()).filter((e) => e.type === "verdict");
    expect(verdicts).toMatchObject([{ verdict: "accepted", category: "spec", reviewMinutes: 4 }]);
  });

  it("redo puts the task back with the note, and the next run sees it outside the data block", async () => {
    const { tracker, ctx, svc, runtime } = await drafted();
    const { items, host } = await loadQueue(ctx, svc);
    await expect(decide(ctx, svc, host, items[0]!, "redo", {})).rejects.toThrow(/needs a note/);
    await decide(ctx, svc, host, items[0]!, "redo", { note: "Add rollout risks for Okta" });
    expect(tracker.tasks.get("lin-1")).toMatchObject({ status: "ready", agent: null });

    await pull(ctx, svc, { dryRun: false });
    expect(runtime.calls).toHaveLength(2);
    // The snapshot file is deleted after the run, so rebuild it to check where the note lands.
    const { taskSnapshot } = await import("../src/run/run.js");
    const [inside, after] = taskSnapshot(tracker.tasks.get("lin-1")!, "outputs/spec/PMX-14.md").split("</task_data>");
    expect(inside).not.toContain("Okta");
    expect(after).toContain("- Add rollout risks for Okta");
  });

  it("reject blocks the task with the reason and closes the draft", async () => {
    const { repo, tracker, ctx, svc } = await drafted();
    const { items, host } = await loadQueue(ctx, svc);
    await decide(ctx, svc, host, items[0]!, "rejected", { note: "Wrong customer segment" });
    expect(tracker.tasks.get("lin-1")!.status).toBe("blocked");
    expect(tracker.comments.get("lin-1")!.at(-1)).toMatch(/Rejected by ana: Wrong customer segment/);
    expect(await git(repo, "branch", "--list", "pmx/task/*")).toBe("");
  });
});

const verdict = (category: string, v: "accepted" | "rejected" | "redo", ts: string): RunLogEntry =>
  ({ type: "verdict", agent: "a", machine: "m", ts, taskId: "x", category, size: "M", verdict: v, reviewMinutes: 1, editSize: null }) as RunLogEntry;

describe("accept rate and auto-pause (REV-3)", () => {
  const team = { ...DEFAULT_TEAM, team: "t" } as TeamConfig;
  const now = new Date("2026-11-30T00:00:00Z");

  it("pauses a category below 30% with enough reviews, and unpause resets it", () => {
    const entries = [
      verdict("spec", "accepted", "2026-11-20T00:00:00Z"),
      ...["rejected", "redo", "rejected", "redo"].map((v, i) => verdict("spec", v as any, `2026-11-2${i + 1}T00:00:00Z`)),
      verdict("research-synthesis", "rejected", "2026-11-25T00:00:00Z"),
      verdict("competitive-analysis", "accepted", "2026-09-01T00:00:00Z"),
    ];
    const stats = acceptStats(entries, now, 30);
    expect(stats.spec).toMatchObject({ accepted: 1, total: 5, rate: 0.2 });
    expect(stats["competitive-analysis"]).toBeUndefined();
    const paused = pausedFrom(entries, team, now);
    expect([...paused.keys()]).toEqual(["spec"]);
    expect(paused.get("spec")).toMatch(/accept rate 20% over 5 reviews/);

    const after = [...entries, { type: "unpause", agent: "a", machine: "m", ts: "2026-11-26T00:00:00Z", category: "spec" } as RunLogEntry];
    expect(pausedFrom(after, team, now).size).toBe(0);
  });

  it("size calibration suggests new estimates when runs are far off (PULL-10)", () => {
    const runs = Array.from({ length: 5 }, (_, i) => ({ type: "run", agent: "a", machine: "m", ts: `2026-11-0${i + 1}T00:00:00Z`, taskId: "x", category: "spec", size: "M", skill: "s", skillVersion: "v", outcome: "ok", durationMs: 70 * 60000, tokens: 1, costUsd: 4, runtime: "r" }) as RunLogEntry);
    const s = calibrate(runs, team);
    expect(s).toHaveLength(1);
    expect(s[0]!.text).toMatch(/"M": \{ "minutes": 70, "costUsd": 4\.00 \}/);
  });
});

describe("review page", () => {
  beforeEach(freshHome);

  it("renders drafts safely with citation hovercards", () => {
    const html = renderMarkdown("# T <script>alert(1)</script>\n\n- **Bold** [T1] [X9]\n- [link](javascript:alert(1)) and [ok](https://example.com)\n\n| a | b |\n|---|---|\n| <img src=x onerror=1> | [T1] |", { T1: 'Acme said "hi"' });
    expect(html).not.toMatch(/<script>|<img/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('data-quote="Acme said &quot;hi&quot;"');
    expect(html).toContain('class="cite missing"');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain("<table>");
  });

  it("requires the token and a loopback Host, and decides through the API", async () => {
    const { tracker, ctx, svc } = await drafted();
    const s = await startReviewServer(ctx, svc);
    try {
      const token = new URL(s.url).searchParams.get("t")!;
      const base = `http://127.0.0.1:${s.port}`;
      expect((await fetch(`${base}/api/queue`)).status).toBe(403);
      expect((await fetch(`${base}/api/queue`, { headers: { "x-pmx-token": "nope" } })).status).toBe(403);
      const http = await import("node:http");
      const rebinding = await new Promise<number>((resolve) => {
        http.get({ host: "127.0.0.1", port: s.port, path: "/api/queue", headers: { host: "evil.example:80", "x-pmx-token": token } }, (r) => resolve(r.statusCode!));
      });
      expect(rebinding).toBe(403);

      const page = await fetch(s.url);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
      expect(await page.text()).toContain(`const TOKEN = "${token}"`);

      const q = await (await fetch(`${base}/api/queue`, { headers: { "x-pmx-token": token } })).json();
      expect(q.items[0].identifier).toBe("PMX-14");
      expect(q.items[0].files[0].html).toContain('class="cite"');

      const form = await fetch(`${base}/api/items/lin-1/accept`, { method: "POST", headers: { "x-pmx-token": token, "content-type": "text/plain" }, body: "{}" });
      expect(form.status).toBe(415);
      const ok = await fetch(`${base}/api/items/lin-1/accept`, { method: "POST", headers: { "x-pmx-token": token, "content-type": "application/json" }, body: "{}" });
      expect(await ok.json()).toMatchObject({ ok: true });
      expect(tracker.tasks.get("lin-1")!.status).toBe("done");
    } finally {
      await s.close();
    }
  });
});
