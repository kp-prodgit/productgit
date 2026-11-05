import { beforeEach, describe, expect, it } from "vitest";
import { cloudTarget, connect, pendingEvents, syncAnalytics } from "../src/cloud/account.js";
import { Cloud } from "../src/cloud/client.js";
import { pipelineEvents } from "../src/cloud/events.js";
import { scriptedAsker } from "../src/core/ask.js";
import { DEFAULT_TEAM, loadPersonalConfig, type TeamConfig } from "../src/core/config.js";
import { memoryKeychain } from "../src/core/keychain.js";
import { writeReceipt, type RunReceipt } from "../src/core/receipt.js";
import { freshHome, personal, testCtx } from "./helpers.js";

const team = (over: Partial<TeamConfig> = {}) => ({ ...DEFAULT_TEAM, team: "acme", ...over }) as TeamConfig;

/** A fake hosted API that records every call. */
function fakeApi(orgs: { orgId: string; name: string; role: string; plan: string }[] = []) {
  const calls: { method: string; path: string; body: any }[] = [];
  const f = (async (url: string, init: any) => {
    const path = url.replace("https://api.test/v1", "");
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path, body });
    const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    if (path === "/me") return reply(200, { userId: "u1", orgs });
    if (path === "/orgs" && init.method === "POST") return reply(201, { orgId: "org_new" });
    if (path.endsWith("/events")) return reply(202, { accepted: body.events.length });
    return reply(404, { error: "not_found" });
  }) as any;
  return { calls, f };
}

const receipt = (over: Partial<RunReceipt> = {}): RunReceipt => ({
  v: 1, id: "digest-20261105T020000Z", type: "digest", at: "2026-11-05T02:00:00.000Z", agent: "ana@m1", outcome: "staged",
  window: { days: 7, since: "2026-10-29T00:00:00.000Z", scope: "personal" },
  rules: { internalDomains: ["acme.com"], requireExternalParticipant: true, topicRulesHash: "x", neverIngest: { people: 1, channels: 0, meetingTitles: 0 }, folders: ["/Users/ana/calls"] },
  skippedSources: [],
  sources: [
    { kind: "transcript", refHash: "a", decision: "used", id: "T1", file: "northfield-call.md", title: "Northfield discovery", detail: "has someone from outside", passagesCut: [{ rule: "health", hash: "h" }], passagesUsed: 3 },
    { kind: "transcript", refHash: "b", decision: "left-out", rule: "internal", detail: "everyone is internal", passagesCut: [], passagesUsed: 0 },
  ],
  masked: { email: 1, phone: 0, card: 0, id: 0, person: 0 },
  skills: [{ name: "pmx-digest", version: "abc", source: "bundled" }],
  model: { name: "m", runtime: "mock", tools: "none", costUsd: 0.02, tokens: 100, durationMs: 5, promptSha256: "p" },
  ...over,
});

describe("free sign-in (PLAN-1, PRIV-5)", () => {
  beforeEach(freshHome);

  it("creates a free org when the PM has none, and records the analytics choice", async () => {
    const api = fakeApi();
    const kc = memoryKeychain({ "machine-token": "pmxm_x" });
    const p = personal("/tmp/repo");
    const r = await connect({ cloud: new Cloud("https://api.test/v1", kc, api.f), team: team(), personal: p, ask: scriptedAsker({ "content-free events": true }), now: new Date("2026-11-05T00:00:00Z") });
    expect(r).toEqual({ target: { url: "https://api.test/v1", orgId: "org_new" }, plan: "free", created: true });
    expect(api.calls.find((c) => c.path === "/orgs")?.body).toEqual({ name: "acme" });
    const saved = await loadPersonalConfig();
    expect(saved.cloud?.orgId).toBe("org_new");
    expect(saved.analytics).toEqual({ enabled: true, decidedAt: "2026-11-05T00:00:00.000Z" });
  });

  it("joins the team's org from pmx.config.json and never creates one", async () => {
    const api = fakeApi([{ orgId: "org_team", name: "Acme", role: "member", plan: "team" }]);
    const kc = memoryKeychain({ "machine-token": "pmxm_x" });
    const t = team({ controlPlane: { url: "https://api.test/v1", orgId: "org_team" } });
    const r = await connect({ cloud: new Cloud("https://api.test/v1", kc, api.f), team: t, personal: personal("/tmp/repo"), ask: scriptedAsker({ "content-free events": false }), now: new Date() });
    expect(r.plan).toBe("team");
    expect(r.created).toBe(false);
    expect(api.calls.some((c) => c.path === "/orgs")).toBe(false);
    expect((await loadPersonalConfig()).analytics?.enabled).toBe(false);
  });

  it("prefers the team's org over the PM's own", () => {
    const p = personal("/r", { cloud: { url: "https://api.test/v1", orgId: "org_mine" } });
    expect(cloudTarget(team(), p)?.orgId).toBe("org_mine");
    expect(cloudTarget(team({ controlPlane: { url: "", orgId: "org_team" } }), p)).toEqual({ url: "https://api.productgit.com/v1", orgId: "org_team" });
  });
});

describe("built-in analytics (PRIV-5, SCOPE-8)", () => {
  beforeEach(freshHome);

  it("turns a receipt into counts only: no titles, file names, rules or folders", () => {
    const [e] = pipelineEvents([receipt()], null);
    expect(e).toEqual({ type: "pipeline", id: expect.stringMatching(/^[0-9a-f]{32}$/), at: "2026-11-05T02:00:00.000Z", kind: "digest", outcome: "staged", found: 2, used: 1, cut: 1, costUsd: 0.02, agent: "ana@m1" });
    expect(JSON.stringify(e)).not.toMatch(/northfield|Northfield|calls|internal|acme/i);
    expect(pipelineEvents([receipt()], "2026-11-05T02:00:00.000Z")).toEqual([]);
    expect(pipelineEvents([receipt({ type: "todo", id: "todo-20261105T020000Z" })], null)).toEqual([]);
  });

  it("sends nothing until the PM signed in and left analytics on, then sends each event once", async () => {
    await writeReceipt(receipt(), new Date("2026-11-05T03:00:00Z"));
    const api = fakeApi();
    const base = { repo: "/tmp/no-repo", fetch: api.f, keychain: memoryKeychain({ "machine-token": "pmxm_x" }), now: new Date("2026-11-05T03:00:00Z") };
    const cloud = { url: "https://api.test/v1", orgId: "org_1" };

    expect(await syncAnalytics(await testCtx({ ...base, personal: { cloud } }))).toBeNull();
    expect(await syncAnalytics(await testCtx({ ...base, personal: { cloud, analytics: { enabled: false, decidedAt: "x" } } }))).toBeNull();
    expect(await syncAnalytics(await testCtx({ ...base, keychain: memoryKeychain(), personal: { cloud, analytics: { enabled: true, decidedAt: "x" } } }))).toBeNull();
    expect(api.calls).toEqual([]);

    const on = await testCtx({ ...base, personal: { cloud, analytics: { enabled: true, decidedAt: "x" } } });
    expect((await pendingEvents(on)).events).toHaveLength(1);
    expect(await syncAnalytics(on)).toBe("sent 1 content-free event(s)");
    expect(api.calls.map((c) => c.path)).toEqual(["/orgs/org_1/events"]);
    expect(await syncAnalytics(on)).toBeNull();
  });
});
