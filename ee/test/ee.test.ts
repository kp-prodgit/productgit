import { generateKeyPairSync, sign } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TEAM, type TeamConfig } from "../../src/core/config.js";
import { memoryKeychain } from "../../src/core/keychain.js";
import type { RunLogEntry } from "../../src/core/runlog.js";
import { freshHome, personal } from "../../test/helpers.js";
import { Cloud } from "../../src/cloud/client.js";
import { cloudLease } from "../src/cloud-lease.js";
import { toEvents } from "../../src/cloud/events.js";
import { verifyLicense } from "../src/license.js";
import { login } from "../../src/cloud/login.js";
import { applyPolicy, getPolicy, type Policy } from "../src/policy.js";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "ES256", use: "sig" };
  const jwt = (claims: object, header: object = { alg: "ES256", typ: "JWT", kid: "k1" }) => {
    const data = `${b64(header)}.${b64(claims)}`;
    return `${data}.${sign("sha256", Buffer.from(data), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  };
  return { jwks: { keys: [jwk] }, jwt };
}

const now = new Date("2026-11-04T00:00:00Z");
const claims = { iss: "https://api.productgit.com", sub: "org_abc", aud: "pmx-cli", plan: "team", seats: 5, features: ["lease"], iat: now.getTime() / 1000, exp: now.getTime() / 1000 + 30 * 86400 };

describe("license (ADMIN-4)", () => {
  it("verifies a KMS-style ES256 license offline", () => {
    const k = keys();
    expect(verifyLicense(k.jwt(claims), k.jwks, now, "org_abc")).toMatchObject({ plan: "team", seats: 5 });
  });

  it("rejects tampering, the wrong org, audience or issuer, expiry and alg confusion", () => {
    const k = keys();
    const good = k.jwt(claims);
    const [h, , s] = good.split(".");
    expect(() => verifyLicense(`${h}.${b64({ ...claims, seats: 500 })}.${s}`, k.jwks, now)).toThrow(/signature is invalid/);
    expect(() => verifyLicense(good, k.jwks, now, "org_other")).toThrow(/not org_other/);
    expect(() => verifyLicense(k.jwt({ ...claims, aud: "x" }), k.jwks, now)).toThrow(/audience/);
    expect(() => verifyLicense(k.jwt({ ...claims, iss: "https://evil" }), k.jwks, now)).toThrow(/issuer/);
    expect(() => verifyLicense(good, k.jwks, new Date(now.getTime() + 31 * 86400000))).toThrow(/expired/);
    expect(() => verifyLicense(`${b64({ alg: "none" })}.${b64(claims)}.`, k.jwks, now)).toThrow(/expected ES256/);
    expect(() => verifyLicense(good, keys().jwks, now)).toThrow(/signature is invalid/);
  });
});

const team = { ...DEFAULT_TEAM, team: "t", controlPlane: { url: "https://api.test/v1", orgId: "org_abc" } } as TeamConfig;
const policy: Policy = {
  version: 3, updatedAt: "", allowedCategories: ["spec", "research-synthesis", "roadmap"], allowedSources: ["transcripts"],
  allowedPlans: ["team", "api"], egressAllowlist: ["api.anthropic.com", "github.com"], model: "claude-opus-5-5", reviewQueueCap: 2,
};

function fakeApi(handler: (method: string, path: string, body: any) => [number, any]) {
  const calls: string[] = [];
  const f = (async (url: string, init: any) => {
    const path = url.replace("https://api.test/v1", "");
    calls.push(`${init.method} ${path}`);
    const [status, body] = handler(init.method, path, init.body ? JSON.parse(init.body) : undefined);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as any;
  return { f, calls };
}

describe("admin policy (ADMIN-2)", () => {
  beforeEach(freshHome);

  it("is an intersection with team config and can only narrow it", () => {
    const r = applyPolicy({ ...team, allowedSources: ["transcripts", "slack"] }, personal("/r"), policy);
    expect(Object.keys(r.team.categories).sort()).toEqual(["research-synthesis", "spec"]);
    expect(r.team.allowedSources).toEqual(["transcripts"]);
    expect(r.team.egress).toEqual(["api.anthropic.com", "github.com"]);
    expect(r.team.model).toBe("claude-opus-5-5");
    expect(r.team.reviewQueueCap).toBe(2);
    expect(r.blockRuns).toBeNull();
    expect(applyPolicy(team, personal("/r", { plan: "max" }), policy).blockRuns).toMatch(/"max" isn't allowed/);
  });

  it("caches for an hour, survives an outage for 7 days, then fails closed", async () => {
    let up = true;
    const api = fakeApi(() => (up ? [200, policy] : [503, { error: "down" }]));
    const cloud = new Cloud("https://api.test/v1", memoryKeychain({ "machine-token": "pmxm_x" }), api.f);
    await getPolicy(cloud, "org_abc", now);
    await getPolicy(cloud, "org_abc", new Date(now.getTime() + 30 * 60000));
    expect(api.calls).toHaveLength(1);
    up = false;
    expect((await getPolicy(cloud, "org_abc", new Date(now.getTime() + 3 * 86400000))).version).toBe(3);
    await expect(getPolicy(cloud, "org_abc", new Date(now.getTime() + 8 * 86400000))).rejects.toThrow(/fail closed/);
  });
});

describe("cloud lease client", () => {
  it("maps the contract: 201 wins, 409 loses, release needs the fencing token", async () => {
    const leases = new Map<string, { holder: string; fencingToken: number; expiresAt: string; acquiredAt: string; taskId: string }>();
    let counter = 0;
    const api = fakeApi((m, p, b) => {
      const id = decodeURIComponent(p.split("/leases/")[1] ?? "");
      if (m === "GET") return [200, { leases: [...leases.values()] }];
      if (m === "POST") {
        const cur = leases.get(id);
        if (cur && cur.holder !== b.holder) return [409, { error: "held", holder: cur.holder, expiresAt: cur.expiresAt }];
        const l = { taskId: id, holder: b.holder, fencingToken: ++counter, acquiredAt: "a", expiresAt: "e" };
        leases.set(id, l);
        return [201, l];
      }
      if (m === "DELETE") {
        const cur = leases.get(id);
        if (!cur || cur.holder !== b.holder || cur.fencingToken !== b.fencingToken) return [409, { error: "not_holder" }];
        leases.delete(id);
        return [204, undefined];
      }
      return [404, {}];
    });
    const l = cloudLease(new Cloud("https://api.test/v1", memoryKeychain({ "machine-token": "pmxm_x" }), api.f), "org_abc");
    const a = await l.acquire("lin-1", "ana@m1", 600);
    const b = await l.acquire("lin-1", "raj@m2", 600);
    expect(a).toMatchObject({ ok: true, lease: { token: "1" } });
    expect(b).toMatchObject({ ok: false, holder: "ana@m1" });
    expect(await l.release("lin-1", "raj@m2")).toBe(false);
    expect(await l.forceRelease("lin-1", "99")).toBe(false);
    expect(await l.release("lin-1", "ana@m1")).toBe(true);
    expect(await l.list()).toEqual([]);
  });
});

describe("content-free events (P7, SCOPE-8)", () => {
  it("sends only schema fields, drops nulls and refused runs, keys by hash", () => {
    const entries = [
      { type: "run", ts: "2026-11-04T10:00:00.000Z", agent: "ana@m1", machine: "m1", hash: "h1", taskId: "PMX-1", category: "spec", size: "M", skill: "pmx-spec", skillVersion: "abc123", outcome: "ok", durationMs: 1000.4, tokens: null, costUsd: 0.4, runtime: "claude-code" },
      { type: "run", ts: "2026-11-04T10:05:00.000Z", agent: "ana@m1", machine: "m1", hash: "h2", taskId: "PMX-2", category: "spec", size: "M", skill: "s", skillVersion: "-", outcome: "refused", durationMs: 0, tokens: null, costUsd: null, runtime: "claude-code" },
      { type: "verdict", ts: "2026-11-04T11:00:00.000Z", agent: "ana@m1", machine: "m1", hash: "h3", taskId: "PMX-1", category: "spec", size: "M", verdict: "accepted", reviewMinutes: 4, editSize: null },
      { type: "digest", ts: "2026-11-04T12:00:00.000Z", agent: "ana@m1", machine: "m1", hash: "h4", outcome: "approved", items: 3, held: 1, durationMs: 1, tokens: null, costUsd: null },
    ] as RunLogEntry[];
    const ev = toEvents(entries, null);
    expect(ev).toEqual([
      { type: "run", id: "h1", at: "2026-11-04T10:00:00.000Z", taskId: "PMX-1", category: "spec", size: "M", skillVersion: "abc123", runtime: "claude-code", outcome: "ok", durationMs: 1000, costUsd: 0.4, agent: "ana@m1" },
      { type: "verdict", id: "h3", at: "2026-11-04T11:00:00.000Z", taskId: "PMX-1", category: "spec", size: "M", verdict: "accepted", reviewMinutes: 4, agent: "ana@m1" },
    ]);
    expect(toEvents(entries, "2026-11-04T10:30:00.000Z").map((e) => e.id)).toEqual(["h3"]);
  });
});

describe("pmx login", () => {
  it("stores the machine token when the browser returns the right state", async () => {
    const kc = memoryKeychain();
    await login({
      keychain: kc, label: "m1", inviteCode: "inv_x", appUrl: "https://app.test",
      open: async (url) => {
        const u = new URL(url);
        expect(u.pathname).toBe("/cli-login");
        expect(u.searchParams.get("invite")).toBe("inv_x");
        const cb = `http://127.0.0.1:${u.searchParams.get("port")}/callback?state=${u.searchParams.get("state")}&token=pmxm_${"a".repeat(40)}`;
        expect((await fetch(cb)).status).toBe(200);
      },
    });
    expect(await kc.get("machine-token")).toBe(`pmxm_${"a".repeat(40)}`);
  });

  it("refuses a callback with the wrong state", async () => {
    const kc = memoryKeychain();
    await expect(login({
      keychain: kc, label: "m1", appUrl: "https://app.test",
      open: async (url) => {
        const port = new URL(url).searchParams.get("port");
        await fetch(`http://127.0.0.1:${port}/callback?state=forged-state-value-xx&token=pmxm_${"a".repeat(40)}`);
      },
    })).rejects.toThrow(/unexpected state/);
    expect(await kc.get("machine-token")).toBeNull();
  });
});
