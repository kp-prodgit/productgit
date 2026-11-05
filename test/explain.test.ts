import { readFileSync } from "node:fs";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { scriptedAsker } from "../src/core/ask.js";
import { filterItems } from "../src/core/filter.js";
import { paths } from "../src/core/paths.js";
import { listReceipts, readReceipt } from "../src/core/receipt.js";
import { makeRedactor } from "../src/core/redact.js";
import { parseRubric } from "../src/core/skillcheck.js";
import { bundledSkillsDir, skillInventory } from "../src/core/skills.js";
import type { CandidateTask, SignalItem } from "../src/core/types.js";
import { runDigest } from "../src/commands/digest.js";
import { formatReceipt, formatSkills } from "../src/explain/format.js";
import { resolveLive } from "../src/explain/resolve.js";
import { startExplainServer } from "../src/explain/server.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { checkSizing, describe as describeTask, parseCandidates } from "../src/synth/synthesize.js";
import { DEFAULT_TEAM } from "../src/core/config.js";
import { freshHome, pmxRepo, testCtx, tmp, writeTranscript } from "./helpers.js";

const item = (over: Partial<SignalItem>): SignalItem => ({ id: "T1", kind: "transcript", ref: "/x/a.md", title: "Call", at: "2026-11-03", participants: [], text: "", ...over });
const rules = { internalDomains: ["us.com"], requireExternalParticipant: true, neverIngest: { people: [], channels: [], meetingTitles: [] } };

describe("filter decisions (PRIV-4)", () => {
  it("explains every source by rule, names only domains, and keeps passage hashes, not text", () => {
    const r = filterItems(
      [
        item({ id: "T1", participants: ["jane@acme.com", "kp@us.com"], text: "Jane: SSO is slow.\n\nKP: my sick leave starts Monday." }),
        item({ id: "T2", participants: ["ana@us.com", "raj@us.com"], text: "Roadmap moved." }),
        item({ id: "T3", participants: ["bo@beta.io"], text: "Bo: my bonus is late." }),
      ],
      rules,
    );
    const [used, internal, allCut] = r.decisions;
    expect(used).toMatchObject({ decision: "kept", detail: "has someone from outside the company (acme.com)", passagesKept: 1 });
    expect(used!.passages).toEqual([{ rule: "health", hash: expect.stringMatching(/^[0-9a-f]{16}$/) }]);
    expect(internal).toMatchObject({ decision: "held", rule: "no-external-participant", detail: "everyone is on your company's domains (us.com)" });
    expect(allCut).toMatchObject({ decision: "held", rule: "all-passages-held" });
    expect(JSON.stringify(r.decisions.map(({ item: _i, ...d }) => d))).not.toMatch(/sick leave|bonus|jane@|ana@/);
  });

  it("counts masked values by type without changing the output", () => {
    const r = makeRedactor(["Dana Reyes"]);
    expect(r.redact("Call 415-555-0142 or dana@x.com. Dana Reyes said hi.")).toBe("Call [PHONE] or [EMAIL]. [PERSON-1] said hi.");
    expect(r.counts).toEqual({ email: 1, phone: 1, card: 0, id: 0, person: 1 });
  });
});

describe("run receipts (PRIV-4)", () => {
  beforeEach(freshHome);

  async function digest(model = "## Top themes\n- Admins spend two hours [T1]\n") {
    const { repo } = await pmxRepo({ internalDomains: ["us.com"] });
    const dir = await tmp("transcripts-");
    await writeTranscript(dir, "acme.md", "---\ntitle: Acme onboarding\nparticipants: jane@acme.com, kp@us.com\n---\nJane: Admins spend two hours on SSO. Mail me at jane@acme.com.\n\nKP: Unrelated, my bonus is late.");
    await writeTranscript(dir, "one-on-one.md", "---\ntitle: Ana / Raj 1:1\nparticipants: ana@us.com, raj@us.com\n---\nRaj: about my performance review");
    const ctx = await testCtx({ repo, runtime: mockRuntime(() => model), team: { internalDomains: ["us.com"] }, personal: { sources: { transcriptDirs: [dir], slackChannel: null } } });
    return { ctx, dir, repo };
  }

  it("writes a private receipt that never holds what was left out", async () => {
    const { ctx, dir } = await digest();
    await runDigest(ctx, scriptedAsker({ approve: "reject" }), {});
    const [id] = await listReceipts();
    expect(id).toMatch(/^digest-\d{8}T\d{6}Z$/);
    expect((await stat(paths.receipts())).mode & 0o777).toBe(0o700);
    expect((await stat(join(paths.receipts(), `${id}.json`))).mode & 0o777).toBe(0o600);
    expect((await stat(paths.staging())).mode & 0o777).toBe(0o700);

    const text = await readFile(join(paths.receipts(), `${id}.json`), "utf8");
    expect(text).not.toMatch(/bonus|performance review|Raj|Ana \/ Raj|one-on-one\.md|jane@/);
    const r = (await readReceipt(id!))!;
    expect(r.sources.map((s) => [s.decision, s.file ?? null, s.rule ?? null])).toEqual([["used", "acme.md", null], ["left-out", null, "one-on-one"]]);
    expect(r.masked.email).toBe(1);
    expect(r.skills).toEqual([{ name: "pmx-digest", version: expect.any(String), source: "team" }]);
    expect(r.model).toMatchObject({ tools: expect.stringMatching(/^none/), promptSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(r.digest).toMatchObject({ cited: ["T1"], removedClaims: 0 });

    // On screen only: the left-out file and the cut passage are found again in the PM's folder.
    const live = await resolveLive(r, [dir]);
    expect(live[1]).toMatchObject({ file: "one-on-one.md", title: "Ana / Raj 1:1" });
    expect(live[0]!.cuts).toEqual([{ rule: "compensation", line: 7, matched: "bonus" }]);
    const shown = formatReceipt(r, live);
    expect(shown).toContain("✘ left out  one-on-one.md: 1:1s and career talks, because the title looks like a 1:1 or career talk");
    expect(shown).toContain('cut line 7: Pay and compensation (matched "bonus")');
  });

  it("still writes a receipt when nothing is usable, so the PM can see why", async () => {
    const { ctx, dir } = await digest();
    await writeFile(join(dir, "acme.md"), "---\ntitle: x\nparticipants: kp@us.com\n---\nKP: hi");
    await runDigest(ctx, scriptedAsker({}), {});
    const r = (await readReceipt((await listReceipts())[0]!))!;
    expect(r.outcome).toBe("no-signal");
    expect(r.model).toBeNull();
    expect(r.sources.every((s) => s.decision === "left-out")).toBe(true);
  });
});

describe("explainable sizing", () => {
  const rubric = parseRubric(readFileSync(join(bundledSkillsDir(), "pmx-size", "SKILL.md"), "utf8"));

  it("reads the rubric's tables and ranges", () => {
    expect(rubric.cells["research-synthesis"]!.M).toBe("Themes across 3–8 sources");
    expect(rubric.cells.spec!.S).toBe("Problem statement only");
    expect(rubric.ranges["research-synthesis"]!.L).toEqual([9, 20]);
    expect(rubric.general.XL).toEqual({ run: "~120 min", rule: "Broad research across many sources. Split it if you can." });
  });

  it("flags sizes that disagree with the rubric without dropping the task", () => {
    const t = (size: "S" | "M", sources: string[]) => ({ category: "research-synthesis", size, sources });
    expect(checkSizing(t("M", ["T1", "T2", "T3"]), { cell: "Themes across 3-8 sources", why: "Three calls." }, rubric).flags).toEqual([]);
    expect(checkSizing(t("M", ["T1"]), { cell: "Summarize 1–2 calls", why: "x" }, rubric).flags).toEqual(["cell-mismatch", "count-below"]);
    expect(checkSizing(t("S", ["T1", "T2", "T3"]), undefined, rubric).flags).toEqual(["no-reason", "count-above"]);

    const ids = new Set(["T1"]);
    const out = parseCandidates(JSON.stringify({ tasks: [{ title: "Synthesize SSO pain", category: "research-synthesis", size: "L", rationale: "r", sources: ["T1"] }] }), ["research-synthesis"], ids, rubric);
    expect(out.tasks).toHaveLength(1);
    expect(out.tasks[0]!.sizing!.flags).toEqual(["no-reason", "count-below"]);
    const desc = describeTask(out.tasks[0] as CandidateTask, [item({ id: "T1", text: "Jane: slow" })]);
    expect(desc).toContain("**Why size L:** no rubric cell given");
    expect(desc).toContain("**Check the size:** it cites fewer sources than this size expects.");
  });
});

describe("skills inventory", () => {
  beforeEach(freshHome);

  it("lists every skill with when it runs, and spots team changes", async () => {
    const { repo } = await pmxRepo();
    await mkdir(join(repo, ".claude", "skills", "pmx-spec"), { recursive: true });
    const spec = await readFile(join(bundledSkillsDir(), "pmx-spec", "SKILL.md"), "utf8");
    await writeFile(join(repo, ".claude", "skills", "pmx-spec", "SKILL.md"), spec + "\nAlways add a risks section.\n");
    const skills = await skillInventory(repo, DEFAULT_TEAM.categories);
    expect(skills.map((s) => s.name)).toEqual(["pmx-brain", "pmx-competitive", "pmx-digest", "pmx-hygiene", "pmx-pull", "pmx-research", "pmx-size", "pmx-spec", "pmx-synthesize"]);
    const by = Object.fromEntries(skills.map((s) => [s.name, s]));
    expect(by["pmx-spec"]).toMatchObject({ status: "differs from built-in", runs: "team", category: "spec", usedBy: "`pmx pull`: drafts spec tasks" });
    expect(by["pmx-digest"]!.usedBy).toMatch(/pmx digest/);
    expect(by["pmx-pull"]!.usedBy).toMatch(/^Not used by PMX runs/);
    expect(formatSkills(skills)).toContain("never in your personal Claude Code");
  });
});

describe("pmx explain --web (PRIV-4, SEC)", () => {
  beforeEach(freshHome);

  const get = (port: number, path: string, headers: Record<string, string> = {}, method = "GET") =>
    new Promise<{ status: number; headers: Record<string, any>; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end();
    });

  it("serves a data-free page with a nonce CSP and answers the API only with the token", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    const s = await startExplainServer({ team: ctx.team, personal: ctx.personal });
    try {
      const token = new URL(s.url).hash.slice(3);
      const auth = { authorization: `Bearer ${token}` };
      const pageRes = await get(s.port, "/");
      expect(pageRes.status).toBe(200);
      const csp = String(pageRes.headers["content-security-policy"]);
      expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/);
      expect(csp).not.toContain("unsafe-inline");
      expect(pageRes.body).not.toContain(token);

      expect((await get(s.port, "/api/runs")).status).toBe(403);
      expect((await get(s.port, "/api/runs", { ...auth, host: "evil.test" })).status).toBe(403);
      expect((await get(s.port, "/api/runs", auth, "POST")).status).toBe(405);
      expect((await get(s.port, "/api/runs/..%2f..%2fconfig", auth)).status).toBe(404);
      expect(JSON.parse((await get(s.port, "/api/runs", auth)).body)).toEqual({ runs: [] });
      expect(JSON.parse((await get(s.port, "/api/skills", auth)).body).skills).toHaveLength(9);
      const sizing = JSON.parse((await get(s.port, "/api/sizing", auth)).body);
      expect(sizing.rubric.cells.spec.M).toBe("One-pager");
      expect(JSON.parse((await get(s.port, "/api/rules", auth)).body).topics.health.examples).toContain("medical");
    } finally {
      await s.close();
    }
  });
});
