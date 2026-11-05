import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { append, monthFile, readAll, verify } from "../src/core/runlog.js";
import { tmp } from "./helpers.js";

const run = (agent: string, ts: string, taskId = "PMX-1") => ({
  type: "run" as const, agent, machine: "m", ts, taskId, category: "spec", size: "M", skill: "pmx-spec", skillVersion: "abc",
  outcome: "ok" as const, durationMs: 1, tokens: 10, costUsd: 0.1, runtime: "mock",
});

describe("run log (OUT-3)", () => {
  it("chains per agent and verifies across months", async () => {
    const d = await tmp();
    await append(d, run("a@1", "2026-10-31T23:00:00Z"));
    await append(d, run("b@2", "2026-11-01T00:00:00Z"));
    await append(d, run("a@1", "2026-11-01T01:00:00Z"));
    const all = await readAll(d);
    expect(all).toHaveLength(3);
    expect(all[2]!.prev).toBe(all[0]!.hash);
    expect(verify(all)).toMatchObject({ ok: true, entries: 3, agents: 2 });
  });

  it("survives a union-merge reordering of different agents' lines", async () => {
    const d = await tmp();
    await append(d, run("a@1", "2026-11-01T00:00:00Z"));
    await append(d, run("b@2", "2026-11-01T00:01:00Z"));
    await append(d, run("a@1", "2026-11-01T00:02:00Z"));
    const f = monthFile(d, "2026-11-01");
    const [l1, l2, l3] = (await readFile(f, "utf8")).trim().split("\n");
    await writeFile(f, [l2, l1, l3].join("\n") + "\n");
    expect(verify(await readAll(d)).ok).toBe(true);
  });

  it("detects an edited or deleted entry", async () => {
    const d = await tmp();
    for (let i = 0; i < 3; i++) await append(d, run("a@1", `2026-11-01T00:0${i}:00Z`, `PMX-${i}`));
    const f = monthFile(d, "2026-11-01");
    const lines = (await readFile(f, "utf8")).trim().split("\n");
    await writeFile(f, [lines[0], lines[2]].join("\n") + "\n");
    expect(verify(await readAll(d)).problems[0]).toMatch(/chain broken/);
    await writeFile(f, [lines[0], lines[1]!.replace('"PMX-1"', '"PMX-9"'), lines[2]].join("\n") + "\n");
    expect(verify(await readAll(d)).problems[0]).toMatch(/hash does not match/);
  });
});
