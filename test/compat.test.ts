import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { analyticsOn, cloudTarget } from "../src/cloud/account.js";
import { Cloud, CloudError } from "../src/cloud/client.js";
import { pipelineEvents, toEvents } from "../src/cloud/events.js";
import { loadPersonalConfig, loadTeamConfig } from "../src/core/config.js";
import { memoryKeychain } from "../src/core/keychain.js";
import { paths } from "../src/core/paths.js";
import { readReceipt } from "../src/core/receipt.js";
import { append, readAll, verify } from "../src/core/runlog.js";
import { services } from "../src/core/services.js";
import { loadState } from "../src/core/state.js";
import { compareVersions, CompatError, currentVersion } from "../src/core/version.js";
import { formatReceipt } from "../src/explain/format.js";
import { acceptStats } from "../src/review/queue.js";
import { loadTodos, refreshTodos } from "../src/todo/todo.js";
import { linearTracker } from "../src/tracker/linear.js";
import { freshHome, pmxRepo, testCtx, tmp } from "./helpers.js";

const OLD = new URL("./compat/v0.4.0/", import.meta.url).pathname;
const old = (f: string) => join(OLD, f);

describe("versions (COMPAT-1)", () => {
  it("this release is 0.5.0 and versions compare by number", () => {
    expect(currentVersion()).toBe("0.5.0");
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("dev", "1.0.0")).toBeNull();
  });
});

describe("reading what 0.4.0 wrote (COMPAT-4)", () => {
  beforeEach(freshHome);

  it("loads a 0.4.0 team config, personal config and state, with safe defaults for new fields", async () => {
    const repo = await tmp("compat-repo-");
    await copyFile(old("pmx.config.json"), join(repo, "pmx.config.json"));
    const team = await loadTeamConfig(repo);
    expect(team.cli).toBeUndefined();
    expect(team.company).toBeUndefined();

    await copyFile(old("config.json"), paths.config());
    const p = await loadPersonalConfig();
    expect(analyticsOn(p)).toBe(false); // never sends anything until the PM signs in (PRIV-5)
    expect(cloudTarget(team, p)).toBeNull();
    expect(p.identity).toBeUndefined();

    await copyFile(old("state.json"), paths.state());
    const s = await loadState();
    expect(s.lastDigestWeek).toBe("2026-W45");
    expect(s).toMatchObject({ lastPipelineSyncAt: null, lastBrainAt: null, lastCollectAt: null, cloudVersions: null });
  });

  it("explains a 0.4.0 receipt and counts it in analytics", async () => {
    await mkdir(paths.receipts(), { recursive: true });
    await copyFile(old("digest-20261105T022219Z.json"), join(paths.receipts(), "digest-20261105T022219Z.json"));
    const r = (await readReceipt("digest-20261105T022219Z"))!;
    const text = formatReceipt(r, []);
    expect(text).toContain("✔ used      [T1] northfield.md");
    expect(text).not.toContain("Processed in this run"); // no ledger state in old receipts
    expect(pipelineEvents([r], null)[0]).toMatchObject({ kind: "digest", found: 2, used: 1, cut: 1 });
  });

  it("verifies and reads a 0.4.0 run log, and ignores entry types it doesn't know", async () => {
    const dir = await tmp("runlog-");
    for (const line of (await readFile(old("runlog.jsonl"), "utf8")).trim().split("\n")) {
      const { prev: _p, hash: _h, ...e } = JSON.parse(line);
      await append(dir, e);
    }
    // An entry type from a future version: hashed and chained like any other, ignored by readers.
    await append(dir, { type: "future-thing", agent: "ana@m1", machine: "m1", ts: "2026-11-03T14:00:00.000Z", whatever: 1 } as any);
    const entries = await readAll(dir);
    expect(verify(entries).ok).toBe(true);
    // (The fixture's unpause resets the window, so stats are checked without it.)
    expect(acceptStats(entries.filter((e) => e.type !== "unpause"), new Date("2026-11-04T00:00:00Z"), 30).spec).toMatchObject({ accepted: 1, total: 1 });
    expect(toEvents(entries, null).map((e) => e.type)).toEqual(["run", "verdict"]);
  });

  it("treats Linear issues without a pmx-kind label as tasks, never as lodged meetings", async () => {
    const body = await readFile(old("linear-issues.json"), "utf8");
    const f = (async () => new Response(body, { status: 200 })) as any;
    const t = linearTracker({ token: "lin_api_x", teamKey: "PMX", projectId: "p1", fetch: f });
    expect((await t.list()).map((x) => [x.identifier, x.status])).toEqual([["PMX-1", "ready"]]);
    expect(await t.listMeetings()).toEqual([]);
  });
});

describe("files from a newer pmx (COMPAT-3)", () => {
  beforeEach(freshHome);

  it("refuses team and personal configs with a newer format, pointing at pmx update", async () => {
    const repo = await tmp("future-repo-");
    const team = JSON.parse(await readFile(old("pmx.config.json"), "utf8"));
    await writeFile(join(repo, "pmx.config.json"), JSON.stringify({ ...team, version: 2 }));
    await expect(loadTeamConfig(repo)).rejects.toThrow(CompatError);
    await expect(loadTeamConfig(repo)).rejects.toThrow(/written by a newer pmx.*pmx update/);

    const personal = JSON.parse(await readFile(old("config.json"), "utf8"));
    await writeFile(paths.config(), JSON.stringify({ ...personal, version: 2 }));
    await expect(loadPersonalConfig()).rejects.toThrow(/newer pmx/);
  });

  it("never rewrites a newer to-do file, and skips a newer receipt", async () => {
    const future = JSON.stringify({ v: 2, processed: {}, items: [{ id: "x", text: "kept", newField: true }] });
    await writeFile(paths.todos(), future);
    await expect(loadTodos()).rejects.toThrow(/newer pmx/);
    expect(await readFile(paths.todos(), "utf8")).toBe(future);

    await mkdir(paths.receipts(), { recursive: true });
    const r = JSON.parse(await readFile(old("digest-20261105T022219Z.json"), "utf8"));
    await writeFile(join(paths.receipts(), "digest-20261105T022219Z.json"), JSON.stringify({ ...r, v: 2 }));
    expect(await readReceipt("digest-20261105T022219Z")).toBeNull();
  });
});

describe("team minimum version (COMPAT-2)", () => {
  beforeEach(freshHome);

  it("stops shared team work on an older machine but keeps personal work going", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, team: { cli: { min: "9.0.0" } } });
    await expect(services(ctx)).rejects.toThrow(/runs pmx 0\.5\.0, and your team needs 9\.0\.0.*pmx update/);
    await expect(refreshTodos(ctx)).resolves.toMatchObject({ added: [] });

    const ok = await testCtx({ repo, team: { cli: { min: "0.5.0" } } });
    await expect(services(ok)).resolves.toBeTruthy();
  });

  it("rejects a minimum that isn't a version", async () => {
    const repo = await tmp("bad-min-");
    const team = JSON.parse(await readFile(old("pmx.config.json"), "utf8"));
    await writeFile(join(repo, "pmx.config.json"), JSON.stringify({ ...team, cli: { min: "latest" } }));
    await expect(loadTeamConfig(repo)).rejects.toThrow(/cli\.min must be a version/);
  });
});

describe("version handshake with the hosted app (COMPAT-5)", () => {
  beforeEach(freshHome);

  it("sends its version, remembers what the server reports, and explains a 426", async () => {
    const seen: Record<string, string>[] = [];
    let status = 200;
    const f = (async (_url: string, init: any) => {
      seen.push(init.headers);
      const body = status === 426 ? { error: "cli_too_old", message: "old", min: "0.6.0", latest: "0.7.0" } : { ok: true };
      return new Response(JSON.stringify(body), { status, headers: { "x-pmx-latest-version": "0.7.0", "x-pmx-min-version": "0.4.0" } });
    }) as any;
    const cloud = new Cloud("https://api.test/v1", memoryKeychain({ "machine-token": "pmxm_x" }), f);
    await cloud.call("GET", "/me");
    expect(seen[0]!["x-pmx-version"]).toBe("0.5.0");
    expect((await loadState()).cloudVersions).toMatchObject({ latest: "0.7.0", min: "0.4.0" });

    status = 426;
    const err = await cloud.call("GET", "/me").catch((e) => e);
    expect(err).toBeInstanceOf(CloudError);
    expect(err.message).toMatch(/needs pmx 0\.6\.0 or newer; this is 0\.5\.0.*pmx update/);
  });
});
