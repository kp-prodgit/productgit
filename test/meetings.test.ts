import { stat } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { checkCollected, collectPrompt } from "../src/collect/collect.js";
import { rollup } from "../src/company/rollup.js";
import { filterItems } from "../src/core/filter.js";
import { paths } from "../src/core/paths.js";
import { readReceipt } from "../src/core/receipt.js";
import { registerServices, services } from "../src/core/services.js";
import type { SignalItem, Task } from "../src/core/types.js";
import { meetingKeys, planMeetings, startOfDay } from "../src/meetings/ledger.js";
import type { LeaseProvider } from "../src/lease/types.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { synthesize } from "../src/synth/synthesize.js";
import { completeTodo, loadTodos, refreshTodos } from "../src/todo/todo.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, pmxRepo, testCtx, tmp, writeTranscript } from "./helpers.js";

const NOW = new Date("2026-11-06T15:00:00Z");
const today = "2026-11-06";

const item = (over: Partial<SignalItem> = {}): SignalItem => ({
  id: "T1", kind: "transcript", ref: "/x/a.md", title: "Acme renewal", at: today, participants: ["jane@acme.com", "ana@us.com"], text: "Jane: hi", ...over,
});

describe("meeting identity and the ledger plan (MEET-1, MEET-3)", () => {
  it("gives the same meeting the same key across PMs and connectors", () => {
    const a = meetingKeys(item({ origin: { source: "fireflies", sourceId: "ff-1" } }));
    const b = meetingKeys(item({ participants: ["ana@us.com", "JANE@acme.com"], origin: { source: "granola", sourceId: "gr-9" }, title: "Acme Renewal!" }));
    const c = meetingKeys(item({ origin: { source: "fireflies", sourceId: "ff-1" }, participants: [] }));
    expect(a.filter((k) => b.includes(k))).toHaveLength(1); // the calendar identity
    expect(a.filter((k) => c.includes(k))).toHaveLength(1); // the connector ID
    expect(meetingKeys(item({ participants: ["Jane"], at: "unknown" }))).toHaveLength(1); // falls back to the text
  });

  it("sorts items into fresh, already processed, before the window and not-a-meeting", () => {
    const fresh = item({ id: "T1", keys: ["m1"] });
    const done = item({ id: "T2", keys: ["m2", "m3"] });
    const retry = item({ id: "T3", keys: ["m4"] });
    const old = item({ id: "T4", keys: ["m5"], at: "2026-11-05" });
    const slack: SignalItem = { ...item({ id: "S1" }), kind: "slack" };
    const entries = [
      { id: "e1", identifier: "PMX-1", url: "", title: "", keys: ["m3"], status: "done" as const, tasks: [], agent: null },
      { id: "e2", identifier: "PMX-2", url: "", title: "", keys: ["m4"], status: "blocked" as const, tasks: [], agent: null },
    ];
    const p = planMeetings([fresh, done, retry, old, slack], entries, startOfDay(NOW));
    expect(p.fresh.map((f) => [f.item.id, f.entry?.identifier ?? null])).toEqual([["T1", null], ["T3", "PMX-2"]]);
    expect(p.already.map((a) => [a.item.id, a.entry.identifier])).toEqual([["T2", "PMX-1"]]);
    expect(p.before.map((b) => b.id)).toEqual(["T4"]);
    expect(p.other.map((o) => o.id)).toEqual(["S1"]);
  });
});

describe("individual scope (TODO-2)", () => {
  const oneOnOne = item({ title: "Ana / Sam 1:1", participants: ["ana@us.com", "sam@us.com"], text: "Sam: I'll send the roadmap draft.\n\nSam: My doctor says I need surgery next month." });
  const rules = { internalDomains: ["us.com"], neverIngest: { people: [], channels: [], meetingTitles: [] } };

  it("reads my 1:1s for my own to-dos, but still cuts health, pay and performance", () => {
    const team = filterItems([oneOnOne], { ...rules, requireExternalParticipant: true });
    expect(team.kept).toHaveLength(0);
    const mine = filterItems([oneOnOne], { ...rules, requireExternalParticipant: false, allowOneOnOne: true });
    expect(mine.kept[0]!.text).toContain("roadmap draft");
    expect(mine.kept[0]!.text).not.toContain("surgery");
  });
});

describe("team meeting ledger in the tracker (MEET-2)", () => {
  beforeEach(freshHome);

  async function setup(lease?: LeaseProvider) {
    const { repo } = await pmxRepo();
    const dir = await tmp("calls-");
    await writeTranscript(dir, "acme.md", `---\ntitle: Acme renewal\ndate: ${today}T14:00:00Z\nparticipants: jane@acme.com, ana@us.com\nsource: fireflies\nsource_id: ff-1\n---\nJane: We export a CSV every Friday; SCIM would fix it.`);
    await writeTranscript(dir, "old.md", `---\ntitle: Beta call\ndate: 2026-11-04\nparticipants: bo@beta.com\n---\nBo: Pricing is confusing.`);
    let reply = JSON.stringify({ tasks: [{ title: "Draft a one-pager for SCIM sync", category: "spec", size: "M", rationale: "Manual CSV.", sources: ["T1"] }] });
    const runtime = mockRuntime(() => reply);
    const tracker = memoryTracker();
    const ctx = await testCtx({ repo, runtime, now: NOW, team: { internalDomains: ["us.com"] }, personal: { sources: { transcriptDirs: [dir], slackChannel: null } } });
    const svc = await services(ctx, { tracker, ...(lease ? { lease } : {}) });
    return { ctx, svc, tracker, runtime, setReply: (r: string) => (reply = r) };
  }
  const opts = { days: 3, since: startOfDay(NOW) };

  it("lodges each new meeting, marks it done with its tasks, and never processes it twice", async () => {
    const { ctx, svc, tracker, runtime } = await setup();
    const r = await synthesize(ctx, svc, opts);
    expect(r.posted.map((p) => p.title)).toEqual(["Draft a one-pager for SCIM sync"]);
    const [entry] = [...tracker.meetings.values()];
    expect(entry).toMatchObject({ title: "Acme renewal", status: "done", tasks: [r.posted[0]!.identifier], agent: "ana@m1" });
    expect(tracker.comments.get(entry!.id)![0]).toMatch(/processed this meeting: 1 suggested task/);
    expect(r.meetings).toMatchObject({ already: 0, before: 1 });
    expect((await tracker.list()).some((t) => t.title.startsWith("Meeting"))).toBe(false); // ledger entries are not tasks

    // The next poll: nothing new, so no model call and no second entry.
    const again = await synthesize(ctx, svc, { ...opts, skipIfNothingNew: true });
    expect(again.meetings.already).toBe(1);
    expect(runtime.calls).toHaveLength(1);
    expect(tracker.meetings.size).toBe(1);
  });

  it("skips a meeting another machine has claimed", async () => {
    const busy: LeaseProvider = {
      kind: "git", acquire: async () => ({ ok: false, holder: "bo@m2", expiresAt: "" }) as any,
      release: async () => true, forceRelease: async () => true, list: async () => [],
    };
    const { ctx, svc, tracker, runtime } = await setup(busy);
    const r = await synthesize(ctx, svc, { ...opts, skipIfNothingNew: true });
    expect(r.meetings.busy).toBe(1);
    expect(tracker.meetings.size).toBe(0);
    expect(runtime.calls).toHaveLength(0);
  });

  it("marks a meeting blocked when the run fails, then retries it on the same entry", async () => {
    const { ctx, tracker, svc, runtime } = await setup();
    const failing = { ...ctx, runtime: mockRuntime(() => ({ ok: false, error: "rate limited" })) };
    await expect(synthesize(failing, svc, opts)).rejects.toThrow(/rate limited/);
    const [entry] = [...tracker.meetings.values()];
    expect(entry!.status).toBe("blocked");
    await synthesize(ctx, svc, opts);
    expect(tracker.meetings.size).toBe(1);
    expect([...tracker.meetings.values()][0]!.status).toBe("done");
    expect(runtime.calls).toHaveLength(1);
  });

  it("records each meeting's ledger state in the receipt", async () => {
    const { ctx, svc, tracker } = await setup();
    await synthesize(ctx, svc, opts);
    const entry = [...tracker.meetings.values()][0]!.identifier;
    const second = await synthesize(ctx, svc, { ...opts, dryRun: true });
    expect(second.meetings.already).toBe(1);
    const ids = (await import("../src/core/receipt.js")).listReceipts;
    const r = await readReceipt((await ids())[0]!);
    expect(r!.sources.find((s) => s.title === "Acme renewal")!.ledger).toEqual({ state: "already-processed", entry });
  });
});

describe("individual to-dos (TODO-1, TODO-3)", () => {
  beforeEach(freshHome);

  it("adds cited to-dos from today's meetings once, and drops uncited ones", async () => {
    const { repo } = await pmxRepo();
    const dir = await tmp("mine-");
    await writeTranscript(dir, "sync.md", `---\ntitle: Ana / Sam 1:1\ndate: ${today}T09:00:00Z\nparticipants: ana@us.com, sam@us.com\n---\nSam: Can you send me the pricing sheet by Friday?\n\nAna: Yes, I'll send it.`);
    const runtime = mockRuntime(() => JSON.stringify({ todos: [
      { text: "Send Sam the pricing sheet", due: "2026-11-07", source: "T1", why: "Sam asked and you agreed." },
      { text: "Invented to-do", due: null, source: "T9", why: "x" },
    ] }));
    const ctx = await testCtx({ repo, runtime, now: NOW, team: { internalDomains: ["us.com"] }, personal: { identity: { names: ["Ana"], emails: ["ana@us.com"] }, sources: { transcriptDirs: [dir], slackChannel: null } } });

    const r = await refreshTodos(ctx, { since: startOfDay(NOW) });
    expect(r.added.map((t) => [t.text, t.due, t.source.title])).toEqual([["Send Sam the pricing sheet", "2026-11-07", "Ana / Sam 1:1"]]);
    expect(runtime.calls[0]!.prompt).toContain("The PM is Ana / ana@us.com.");
    expect(runtime.calls[0]!.tools).toEqual([]);
    const receipt = await readReceipt(r.receiptId!);
    expect(receipt!.rules.allowOneOnOne).toBe(true);
    expect(receipt!.todo!.dropped[0]).toMatch(/Invented to-do: cites no meeting/);

    const again = await refreshTodos(ctx, { since: startOfDay(NOW), skipIfNothingNew: true });
    expect(again.meetings).toMatchObject({ read: 0, alreadyRead: 1 });
    expect(runtime.calls).toHaveLength(1);

    expect((await stat(paths.todos())).mode & 0o777).toBe(0o600);
    await completeTodo(r.added[0]!.id, NOW);
    expect((await loadTodos()).items[0]!.status).toBe("done");
  });
});

describe("collecting from Claude connectors (COLLECT-1, COLLECT-2)", () => {
  beforeEach(freshHome);

  it("prints current instructions and checks what the scheduled task saved", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, now: NOW, personal: { neverIngest: { people: [], channels: [], meetingTitles: ["Board prep"] } } });
    const dir = paths.transcripts();
    await writeTranscript(dir, `${today}-fireflies-acme.md`, `---\ntitle: Acme\ndate: ${today}T14:00:00Z\nparticipants: jane@acme.com\nsource: fireflies\nsource_id: ff-1\nowner: Ana Lee <Ana@us.com>\n---\n${"Jane: We export a CSV every Friday. ".repeat(10)}`);
    await writeTranscript(dir, "broken.md", "just notes");

    const prompt = await collectPrompt(ctx, { scope: "mine" });
    expect(prompt).toContain(join(dir, "<YYYY-MM-DD>-<source>-<short-slug>.md"));
    expect(prompt).toContain("fireflies:ff-1");
    expect(prompt).toContain('"Board prep"');
    expect(prompt).toMatch(/Never summarize/);
    expect(ctx.personal.sources.transcriptDirs).toContain(dir);

    const out = (await checkCollected(ctx)).join("\n");
    expect(out).toMatch(/Collected 2 new transcript/);
    expect(out).toMatch(/broken\.md: no front matter, no meeting date, no participants, no source/);
    expect(ctx.personal.identity).toEqual({ names: ["Ana Lee"], emails: ["ana@us.com"] });
    expect((await stat(join(dir, `${today}-fireflies-acme.md`))).mode & 0o777).toBe(0o600);
  });
});

describe("company roll-up (COMPANY-1, COMPANY-2)", () => {
  beforeEach(freshHome);

  const t = (identifier: string, title: string): Task => ({
    id: identifier, identifier, title, description: "", url: `https://linear.app/x/${identifier}`, category: "spec", size: "M",
    status: "inbox", priority: 0, agent: null, sources: ["T1"], prUrl: null, createdAt: "2026-11-01T00:00:00Z",
  });

  it("posts themes that span teams once, linking the team tasks, and never reads transcripts", async () => {
    const teams = { admin: memoryTracker([t("ADM-1", "SCIM one-pager"), t("ADM-2", "Audit log export")]), growth: memoryTracker([t("GRO-4", "SCIM for self-serve")]) };
    registerServices({ project: async (_ctx, p) => teams[p.projectId as keyof typeof teams] });
    const reply = JSON.stringify({ themes: [
      { title: "Decide on SCIM across admin and growth", category: "spec", size: "L", rationale: "Both teams hear SCIM asks.", tasks: ["admin/ADM-1", "growth/GRO-4"] },
      { title: "Only admin", category: "spec", size: "S", rationale: "x", tasks: ["admin/ADM-2"] },
    ] });
    const runtime = mockRuntime(() => reply);
    const { repo } = await pmxRepo();
    const company = memoryTracker();
    const ctx = await testCtx({ repo, runtime, now: NOW, team: { company: { machine: null, teams: [{ name: "admin", teamKey: "ADM", projectId: "admin" }, { name: "growth", teamKey: "GRO", projectId: "growth" }] } } });
    const svc = await services(ctx, { tracker: company });

    const r = await rollup(ctx, svc);
    expect(r.posted.map((p) => [p.title, p.tasks])).toEqual([["Decide on SCIM across admin and growth", ["admin/ADM-1", "growth/GRO-4"]]]);
    expect(r.skipped[0]).toMatch(/Only admin: doesn't span two teams/);
    const created = (await company.list())[0]!;
    expect(created.description).toContain("pmx:from admin/ADM-1");
    expect(created.description).toContain("https://linear.app/x/GRO-4");
    expect(runtime.calls[0]!.prompt).toContain('ref="growth/GRO-4"');

    const again = await rollup(ctx, svc);
    expect(again.posted).toEqual([]);
    expect(again.skipped.some((s) => /already rolled up/.test(s))).toBe(true);
  });
});
