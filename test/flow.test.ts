import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { flowArtifact, flowCapabilities, flowJson } from "../src/claude/flow.js";
import { runDoctor } from "../src/commands/doctor.js";
import { CANARY_MARKER, runCanaries } from "../src/core/canary.js";
import { DEFAULT_TEAM, type TeamConfig } from "../src/core/config.js";
import { exec } from "../src/core/exec.js";
import { filterItems } from "../src/core/filter.js";
import { memoryKeychain } from "../src/core/keychain.js";
import { fakeLaunchd } from "../src/core/launchd.js";
import { sourceReceipts, writeReceipt, type RunReceipt } from "../src/core/receipt.js";
import type { RunLogEntry } from "../src/core/runlog.js";
import { loadState } from "../src/core/state.js";
import type { SignalItem } from "../src/core/types.js";
import { reportFile, takeCollectReport } from "../src/collect/collect.js";
import { addNeverIngest, checkNeverIngest, whatIf } from "../src/flow/edit.js";
import { buildFlowGraph, trustClaims, type FlowInputs } from "../src/flow/graph.js";
import { FLOW_JS } from "../src/flow/render.js";
import { startExplainServer } from "../src/explain/server.js";
import { handleMcp, installMcp, mcpInstalled, MCP_TOOLS } from "../src/mcp/server.js";
import { checkRelay, readResolved, relayDir, relayTracker } from "../src/tracker/relay.js";
import { freshHome, personal, pmxRepo, testCtx, tmp } from "./helpers.js";

const NOW = new Date("2026-11-06T18:00:00Z");
const team = { ...DEFAULT_TEAM, team: "t", tracker: { kind: "linear", teamKey: "PMX", projectId: "proj-1" } } as TeamConfig;

const issue = (identifier: string, title: string, labels: [string, string][], description = "") => ({
  id: `uuid-${identifier}`, identifier, title, description, url: `https://linear.app/x/${identifier}`, priority: 3, createdAt: "2026-11-06T12:00:00Z",
  labels: { nodes: labels.map(([g, n]) => ({ name: n, parent: { name: g } })) }, comments: { nodes: [] },
});

function receipt(over: Partial<RunReceipt> = {}): RunReceipt {
  return {
    v: 1, id: "synthesize-20261106T120000Z", type: "synthesize", at: "2026-11-06T12:00:00.000Z", agent: "ana@m1", outcome: "posted",
    window: { days: 1, since: "2026-11-05T12:00:00Z", scope: "team" },
    rules: { internalDomains: ["us.com"], requireExternalParticipant: true, topicRulesHash: "x", neverIngest: { people: 1, channels: 0, meetingTitles: 2 }, folders: ["/Users/ana/.pmx/transcripts"] },
    skippedSources: [],
    sources: [
      { kind: "transcript", refHash: "aaaa1111bbbb2222", decision: "used", id: "T1", file: "2026-11-06-granola-acme.md", title: "Acme discovery", at: "2026-11-06",
        origin: "granola", detail: "has someone from outside the company (acme.com)", passagesCut: [{ rule: "compensation", hash: "h1" }], passagesUsed: 7, ledger: { state: "processed-now", entry: "PMX-2" } },
      { kind: "transcript", refHash: "cccc3333dddd4444", decision: "left-out", rule: "one-on-one", origin: "granola", detail: "the title looks like a 1:1 or career talk",
        keys: ["mheldkey"], passagesCut: [], passagesUsed: 0 },
      { kind: "slack", refHash: "eeee5555ffff6666", decision: "used", id: "S1", file: "https://slack.com/archives/C123/p1", title: "#product", at: "2026-11-06", origin: "slack", channel: "C123",
        detail: "a message in an approved channel", passagesCut: [], passagesUsed: 1 },
    ],
    masked: { email: 1, phone: 0, card: 0, id: 0, person: 0 },
    skills: [{ name: "pmx-synthesize", version: "abc1234def", source: "team" }],
    model: { name: "claude-sonnet-5-5", runtime: "claude-code", tools: "none", costUsd: 0.5, tokens: 1000, durationMs: 9000, promptSha256: "p" },
    synth: { tasks: [
      { title: "Write the Acme spec", category: "spec", size: "M", sources: ["T1", "S1"], sizing: null, posted: { identifier: "PENDING-ABC123" } },
      { title: "Old style task", category: "spec", size: "S", sources: ["T1"], sizing: null },
    ], skipped: [] },
    canaries: { total: 5, held: 5, failed: [] },
    ...over,
  };
}

const runlog: RunLogEntry[] = [
  { type: "run", taskId: "PMX-7", category: "spec", size: "M", skill: "pmx-spec", skillVersion: "s1", outcome: "ok", durationMs: 600000, tokens: 5000, costUsd: 1.5, runtime: "claude-code", ts: "2026-11-06T14:00:00Z", agent: "ana@m1", machine: "m1" },
  { type: "verdict", taskId: "PMX-7", category: "spec", size: "M", verdict: "accepted", reviewMinutes: 12, editSize: 3, ts: "2026-11-06T16:00:00Z", agent: "bo@m2", machine: "m2" },
  { type: "synthesize", posted: 1, held: 1, durationMs: 9000, tokens: 1000, costUsd: 0.5, receipt: "synthesize-20261106T120000Z", ts: "2026-11-06T12:00:01Z", agent: "ana@m1", machine: "m1" },
];

function inputs(over: Partial<FlowInputs> = {}): FlowInputs {
  return {
    level: "local", now: NOW, hours: 24, agent: "ana@m1", receipts: [receipt()], runlog, chain: { ok: true, entries: 3, agents: 2, problems: [] },
    issues: [
      issue("PMX-7", "Write the Acme spec", [["pmx-status", "review"], ["pmx-category", "spec"], ["pmx-size", "M"]]),
      issue("PMX-8", "Old style task", [["pmx-status", "inbox"]]),
      issue("PMX-2", "Meeting · Acme discovery · 2026-11-06", [["pmx-kind", "meeting"], ["pmx-status", "done"]], "pmx:meeting mkey1\npmx:task PMX-7"),
    ],
    linearSyncedAt: "2026-11-06T17:00:00Z", outbox: [], resolved: { "PENDING-ABC123": { identifier: "PMX-7" } },
    state: { ledger: { "2026-11-06": 2 }, caps: { "2026-11-06": 5 }, collectReports: [{ at: "2026-11-06T11:00:00Z", connector: "granola", saved: 2, skipped: { "never-ingest-title": 2, "never-ingest-person": 0, "no-transcript": 1, "already-collected": 3, "outside-window": 0 } }] },
    caps: { personalUsd: 10, teamUsd: 20, resetHour: 0 }, live: { "synthesize-20261106T120000Z": [{ file: null, title: null, cuts: [] }, { file: "2026-11-06-granola-1-1-bo.md", title: "1:1 Ana / Bo", cuts: [] }, { file: null, title: null, cuts: [] }] },
    ...over,
  };
}

const edge = (g: ReturnType<typeof buildFlowGraph>, from: string, to: string) => g.edges.find((e) => e.from === from && e.to === to);

describe("0.11.0: the flow graph (FLOW-1)", () => {
  it("links each meeting to its run, the tasks that cite it, the Linear issue, the agent run and the verdict", () => {
    const g = buildFlowGraph(inputs());
    expect(g.summary).toMatchObject({ read: 2, held: 1, skippedUpstream: 6, tasks: 2, registered: 2, executions: 1 });
    expect(edge(g, "src:aaaa1111bbbb2222", "run:synthesize-20261106T120000Z")?.kind).toBe("read");
    expect(edge(g, "src:aaaa1111bbbb2222", "task:synthesize-20261106T120000Z:0")?.kind).toBe("cited");
    expect(edge(g, "task:synthesize-20261106T120000Z:0", "lin:PMX-7")).toMatchObject({ kind: "registered" });
    expect(edge(g, "task:synthesize-20261106T120000Z:1", "lin:PMX-8")).toMatchObject({ kind: "registered", inferred: true });
    expect(edge(g, "lin:PMX-7", "exec:PMX-7:2026-11-06T14:00:00Z")?.kind).toBe("executed");
    expect(edge(g, "exec:PMX-7:2026-11-06T14:00:00Z", "verdict:PMX-7:2026-11-06T16:00:00Z")?.kind).toBe("judged");
    expect(edge(g, "lin:PMX-2", "lin:PMX-7")?.kind).toBe("produced");
    expect(edge(g, "skill:pmx-synthesize@abc1234def", "run:synthesize-20261106T120000Z")?.kind).toBe("used-skill");
    expect(edge(g, "skill:pmx-spec@s1", "exec:PMX-7:2026-11-06T14:00:00Z")?.kind).toBe("used-skill");
    expect(edge(g, "held:cccc3333dddd4444", "vault")).toMatchObject({ kind: "held", rule: "one-on-one" });
    expect(edge(g, "skipped", "vault")).toMatchObject({ kind: "skipped" });
    expect(g.budget).toContainEqual({ day: "2026-11-06", spentUsd: 2, capUsd: 5 });
    expect(g.nodes.find((n) => n.id === "src:eeee5555ffff6666")?.meta).toMatchObject({ origin: "slack", channel: "C123" });
    expect(g.checks.map((c) => [c.id, c.status])).toEqual([["held-never-in-linear", "ok"], ["canaries", "ok"], ["outbox-clean", "ok"], ["runlog-chain", "ok"], ["links", "unknown"]]);
    expect(trustClaims(g).join("\n")).toMatch(/2 source\(s\) read, 1 held, 6 skipped before saving/);
  });

  it("shows held titles only on this Mac's page; shared views get a rule and a number, team views the run log", () => {
    const local = buildFlowGraph(inputs());
    expect(local.nodes.find((n) => n.id === "held:cccc3333dddd4444")?.label).toBe("1:1 Ana / Bo");
    const shared = JSON.stringify(buildFlowGraph(inputs({ level: "shared", live: undefined })));
    for (const secret of ["1:1 Ana / Bo", "cccc3333", "aaaa1111", "acme.com", "/Users/ana", "mheldkey", "2026-11-06-granola"]) expect(shared).not.toContain(secret);
    expect(shared).toContain("Held · 1:1s and career talks");
    const team = buildFlowGraph(inputs({ level: "team", receipts: [], issues: null }));
    expect(team.nodes.some((n) => n.kind === "source")).toBe(false);
    expect(team.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(["lin:PMX-7", "exec:PMX-7:2026-11-06T14:00:00Z", "run:ana@m1:2026-11-06T12:00:01Z"]));
    expect(JSON.stringify(team)).not.toContain("Write the Acme spec");
  });

  it("fails the seal when a held meeting is in Linear's ledger, a canary got through, or one waits in the outbox", () => {
    const leaked = buildFlowGraph(inputs({ issues: [...inputs().issues!, issue("PMX-9", "Meeting · x", [["pmx-kind", "meeting"]], "pmx:meeting mheldkey")] }));
    expect(leaked.checks.find((c) => c.id === "held-never-in-linear")).toMatchObject({ status: "violated", detail: expect.stringContaining("PMX-9") });
    const canary = buildFlowGraph(inputs({ receipts: [receipt({ canaries: { total: 5, held: 4, failed: ["pay passage"] } })] }));
    expect(canary.checks.find((c) => c.id === "canaries")?.status).toBe("violated");
    const outbox = buildFlowGraph(inputs({ outbox: [{ kind: "create-task", text: `{"title":"x ${CANARY_MARKER}"}` }] }));
    expect(outbox.checks.find((c) => c.id === "outbox-clean")?.status).toBe("violated");
    const unsynced = buildFlowGraph(inputs({ issues: null }));
    expect(unsynced.checks[0]!.status).toBe("unknown");
  });
});

describe("0.11.0: recording the links (FLOW-1)", () => {
  beforeEach(freshHome);

  it("keeps each source's connector, Slack channel and held meeting keys in the receipt", () => {
    const items: SignalItem[] = [
      { id: "T1", kind: "transcript", ref: "/x/a.md", title: "Acme call", at: "2026-11-06", participants: ["a@acme.com"], text: "Hi", keys: ["k1"], origin: { source: "fireflies", sourceId: "f1" } },
      { id: "T2", kind: "transcript", ref: "/x/b.md", title: "1:1 Ana / Bo", at: "2026-11-06", participants: ["a@acme.com"], text: "Hi", keys: ["k2"] },
      { id: "S1", kind: "slack", ref: "https://slack.com/archives/C9/p123", title: "#x", at: "2026-11-06", participants: [], text: "Hi" },
    ];
    const r = sourceReceipts(filterItems(items, { internalDomains: ["us.com"], requireExternalParticipant: true, neverIngest: { people: [], channels: [], meetingTitles: [] } }).decisions, (t) => t);
    expect(r[0]).toMatchObject({ decision: "used", origin: "fireflies" });
    expect(r[0]).not.toHaveProperty("keys");
    expect(r[1]).toMatchObject({ decision: "left-out", origin: "file", keys: ["k2"] });
    expect(r[2]).toMatchObject({ origin: "slack", channel: "C9" });
  });

  it("maps PENDING identifiers to the real ones after a Linear sync", async () => {
    await mkdir(relayDir(), { recursive: true });
    await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: NOW.toISOString(), projectId: "proj-1", issues: [] }));
    const t = relayTracker(team, () => {}, () => NOW);
    const made = await t.createInbox({ title: "New", description: "d", category: "spec", size: "S", sources: [] });
    expect(made.identifier).toMatch(/^PENDING-/);
    const op = JSON.parse(await readFile(join(relayDir(), "outbox.json"), "utf8")).ops[0];
    await writeFile(join(relayDir(), "results.json"), JSON.stringify([{ id: op.id, ok: true, identifier: "PMX-31" }]));
    await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: NOW.toISOString(), projectId: "proj-1", issues: [issue("PMX-31", "New", [["pmx-status", "inbox"]])] }));
    await checkRelay(team, NOW);
    expect((await readResolved())[made.identifier]).toMatchObject({ identifier: "PMX-31" });
  });

  it("refuses to send a canary to Linear, and tells the sync task to write files with its file tool", async () => {
    await mkdir(relayDir(), { recursive: true });
    await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: NOW.toISOString(), projectId: "proj-1", issues: [] }));
    const t = relayTracker(team, () => {}, () => NOW);
    await expect(t.createInbox({ title: `Leak ${CANARY_MARKER}`, description: "d", category: "spec", size: "S", sources: [] })).rejects.toThrow(/canary/);
    const { relayPrompt } = await import("../src/tracker/relay.js");
    expect(await relayPrompt(team)).toMatch(/with your file-writing tool \(not a shell command/);
  });

  it("keeps only counts from the collection task's skip report", async () => {
    await mkdir(join(reportFile(), ".."), { recursive: true });
    await writeFile(reportFile(), JSON.stringify({ connector: "Granola", skipped: { "never-ingest-title": 2, "no-transcript": "x", sneaky: 5, "already-collected": 1.5 }, titles: ["Secret"] }));
    const r = await takeCollectReport();
    expect(r).toEqual({ connector: "granola", skipped: { "never-ingest-title": 2, "never-ingest-person": 0, "no-transcript": 0, "already-collected": 0, "outside-window": 0 } });
    expect(JSON.stringify(r)).not.toContain("Secret");
    expect(await takeCollectReport()).toBeNull();
  });
});

describe("0.11.0: canaries (FLOW-3)", () => {
  it("holds every fake confidential meeting, including the PM's own do-not-read entries", () => {
    const base = { internalDomains: ["us.com"], requireExternalParticipant: true, neverIngest: { people: [], channels: [], meetingTitles: [] } };
    expect(runCanaries(base)).toEqual({ total: 5, held: 5, failed: [] });
    expect(runCanaries({ ...base, neverIngest: { people: ["Dana Board"], channels: [], meetingTitles: ["Board prep"] } })).toEqual({ total: 7, held: 7, failed: [] });
    // Private to-dos allow 1:1s and internal meetings, so those canaries don't apply there.
    expect(runCanaries({ ...base, requireExternalParticipant: false, allowOneOnOne: true }).total).toBe(3);
  });
});

describe("0.11.0: edits only tighten (FLOW-6)", () => {
  beforeEach(freshHome);

  it("adds to the do-not-read list, previews what it would have held, and never removes", async () => {
    expect(() => checkNeverIngest("everything", "x y z")).toThrow(/title, person or channel/);
    expect(() => checkNeverIngest("title", "ab")).toThrow(/3 to 120/);
    await writeReceipt(receipt(), NOW);
    expect(await whatIf("title", "acme")).toMatchObject({ meetings: 1, tasks: 2 });
    const p = personal("/r");
    expect(await addNeverIngest(p, "title", "Acme", "cli")).toEqual({ added: true });
    expect(await addNeverIngest(p, "title", "acme", "flow")).toEqual({ added: false });
    expect(p.neverIngest.meetingTitles).toEqual(["Acme"]);
    const log = await readFile(join(process.env.PMX_HOME!, "logs", "edits.jsonl"), "utf8");
    expect(log).not.toContain("Acme");
  });
});

describe("0.11.0: the local server for the artifact (FLOW-4)", () => {
  beforeEach(freshHome);

  it("speaks MCP, serves only the shared level, and its one write only adds", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    await writeReceipt(receipt({ at: "2026-11-06T09:00:00.000Z" }), ctx.now());
    const call = (method: string, params?: object) => handleMcp({ jsonrpc: "2.0", id: 1, method, params }, async () => ctx);
    expect(await call("initialize", { protocolVersion: "2025-06-18" })).toMatchObject({ result: { protocolVersion: "2025-06-18", serverInfo: { name: "pmx" }, capabilities: { tools: {} } } });
    expect(await handleMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, async () => ctx)).toBeNull();
    const tools = ((await call("tools/list")) as any).result.tools;
    expect(tools.map((t: any) => [t.name, t.annotations.readOnlyHint])).toEqual([["flow_graph", true], ["flow_what_if", true], ["never_ingest_add", false]]);
    const g = ((await call("tools/call", { name: "flow_graph", arguments: { hours: 48 } })) as any).result;
    expect(g.structuredContent).toMatchObject({ level: "shared", summary: { read: 2, held: 1 } });
    expect(JSON.stringify(g)).not.toMatch(/cccc3333|acme\.com|\/Users\/ana/);
    expect(((await call("tools/call", { name: "flow_graph", arguments: { hours: 9999 } })) as any).result.isError).toBe(true);
    const added = ((await call("tools/call", { name: "never_ingest_add", arguments: { kind: "person", value: "dana@us.com" } })) as any).result.structuredContent;
    expect(added.added).toBe(true);
    expect(ctx.personal.neverIngest.people).toEqual(["dana@us.com"]);
    expect(await call("tools/call", { name: "rm_rules", arguments: {} })).toMatchObject({ error: { code: -32602 } });
    expect(await call("resources/list")).toMatchObject({ error: { code: -32601 } });
  });

  it("registers with the Claude desktop app, keeping other servers, and never rewrites a file it can't parse", async () => {
    const dir = await tmp("desktop-");
    process.env.PMX_CLAUDE_DESKTOP_CONFIG = join(dir, "claude_desktop_config.json");
    await writeFile(process.env.PMX_CLAUDE_DESKTOP_CONFIG, JSON.stringify({ preferences: { a: 1 }, mcpServers: { other: { command: "x" } } }));
    expect(await mcpInstalled()).toBe(false);
    expect(await installMcp("/opt/homebrew/bin/node", "/x/cli.js")).toEqual({ changed: true });
    const cfg = JSON.parse(await readFile(process.env.PMX_CLAUDE_DESKTOP_CONFIG, "utf8"));
    expect(cfg).toEqual({ preferences: { a: 1 }, mcpServers: { other: { command: "x" }, pmx: { command: "/opt/homebrew/bin/node", args: ["/x/cli.js", "mcp"] } } });
    expect(await installMcp("/opt/homebrew/bin/node", "/x/cli.js")).toEqual({ changed: false });
    await writeFile(process.env.PMX_CLAUDE_DESKTOP_CONFIG, "{ not json");
    expect((await installMcp("n", "c")).error).toMatch(/isn't valid JSON/);
    delete process.env.PMX_CLAUDE_DESKTOP_CONFIG;
  });
});

describe("0.11.0: the pages (FLOW-2, FLOW-5)", () => {
  beforeEach(freshHome);

  it("serves the flow page on this Mac behind the token and nonce, and the graph only with the token", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    const s = await startExplainServer({ team: ctx.team, personal: ctx.personal, flow: async (hours, scope) => buildFlowGraph(inputs({ hours, level: scope === "team" ? "team" : "local" })) });
    const get = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string; csp: string }>((resolve) => {
      request({ host: "127.0.0.1", port: s.port, path, headers: { host: `127.0.0.1:${s.port}`, ...headers } }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode!, body, csp: String(res.headers["content-security-policy"] ?? "") }));
      }).end();
    });
    try {
      const token = new URL(s.flowUrl).hash.slice(3);
      const page = await get("/flow");
      expect(page.status).toBe(200);
      expect(page.csp).toMatch(/script-src 'nonce-/);
      expect(page.body).not.toContain(token);
      expect(page.body).not.toMatch(/<script src=|https:\/\//);
      expect((await get("/api/flow?hours=24")).status).toBe(403);
      const ok = await get("/api/flow?hours=24&scope=mine", { authorization: `Bearer ${token}` });
      expect(JSON.parse(ok.body).graph.summary.read).toBe(2);
      expect((await get("/api/flow?hours=999", { authorization: `Bearer ${token}` })).status).toBe(400);
    } finally {
      await s.close();
    }
  });

  it("builds an artifact that asks only the local PMX server, with exactly its three tools", async () => {
    process.env.PMX_CLAUDE_HOME = await tmp("claude-home-");
    expect(flowCapabilities()).toEqual({ mcp: { servers: [{ server: "host:pmx", tools: MCP_TOOLS.map((t) => t.name) }] } });
    const html = flowArtifact({ team: "t</script><b>", version: "0.11.0", boardUrl: null });
    expect(html).toMatch(/^<title>PMX Flow<\/title>/);
    expect(html).not.toContain("t</script><b>");
    expect(html).toMatch(/:root:not\(\[data-theme="light"\]\)/);
    expect(html).not.toMatch(/<script src=/);
    expect(() => new Function(FLOW_JS)).not.toThrow();
    const j = await flowJson(null, null);
    expect(j).toMatchObject({ ready: true, title: "PMX Flow", capabilities: flowCapabilities(), mcpInstalled: false });
    expect(await readFile((j as any).html, "utf8")).toContain("host:pmx");
  });

  it("doctor fails when the privacy rules let a canary through, and warns when the published page can't reach PMX", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    process.env.PMX_CLAUDE_DESKTOP_CONFIG = join(await tmp("desktop-"), "none.json");
    ctx.personal.flow = { url: "https://claude.ai/artifact/abc", version: "0.11.0", publishedAt: NOW.toISOString() };
    const checks = await runDoctor({ personal: ctx.personal, team: ctx.team, keychain: memoryKeychain(), launchd: fakeLaunchd(), exec });
    expect(checks.find((c) => c.id === "privacy.canaries")).toMatchObject({ ok: true, level: "fail" });
    expect(checks.find((c) => c.id === "flow.mcp")).toMatchObject({ ok: false, level: "warn", detail: expect.stringContaining("pmx mcp --install") });
    delete process.env.PMX_CLAUDE_DESKTOP_CONFIG;
    expect((await loadState()).collectReports).toEqual([]);
  });
});
