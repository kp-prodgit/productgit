import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { BOARD_TOOLS, boardCapabilities, boardEligibility, boardFile, boardJson, boardTemplate, boardUrl, fillBoard, formatBoard, setBoardUrl } from "../src/claude/board.js";
import { appSkillSource, appSkillTarget, BOARD_SKILL, installAppSkill, refreshAppSkills } from "../src/claude/skill.js";
import { DEFAULT_TEAM, loadPersonalConfig, savePersonalConfig, validateTeamConfig, type TeamConfig } from "../src/core/config.js";
import { currentVersion } from "../src/core/version.js";
import { freshHome, personal, tmp } from "./helpers.js";

const team = { ...DEFAULT_TEAM, team: "Acme PM", tracker: { kind: "linear", teamKey: "PMX", projectId: "proj-1" } } as TeamConfig;
const URL1 = "https://claude.ai/artifact/TMz4Rh1wgCx89p3qG3huvN";

describe("the Claude board (BOARD-1)", () => {
  beforeEach(async () => {
    await freshHome();
    process.env.PMX_CLAUDE_HOME = await tmp("claude-home-");
  });

  it("fills the team's Linear project into the page and nothing else", async () => {
    const template = await readFile(boardTemplate(), "utf8");
    const page = fillBoard(template, { ...team, team: "</script><b>x" });
    const cfg = JSON.parse(/id="pmx-config">([\s\S]*?)<\/script>/.exec(page)![1]!);
    expect(cfg).toEqual({ team: "</script><b>x", teamKey: "PMX", projectId: "proj-1", version: currentVersion() });
    expect(page).not.toContain("</script><b>");
    expect(page.length - template.length).toBeLessThan(200);
    expect(() => fillBoard(template, { ...team, tracker: { kind: "none" } })).toThrow(/Linear project/);
  });

  it("calls only the Linear tools it declares", async () => {
    const page = await readFile(boardTemplate(), "utf8");
    const used = new Set([...page.matchAll(/(?:callTool|watchTool)\(LINEAR, "([a-z_]+)"/g)].map((m) => m[1]));
    expect([...used].sort()).toEqual([...BOARD_TOOLS].sort());
    expect(boardCapabilities()).toEqual({ mcp: { servers: [{ server: "Linear", tools: [...BOARD_TOOLS] }] } });
    expect(page).not.toMatch(/<!doctype|<html|<body/i); // the Artifact tool adds the skeleton
  });

  it("is offered only where Claude and Linear are both in use", () => {
    expect(boardEligibility(team, true)).toEqual({ ok: true });
    expect(boardEligibility(team, false)).toMatchObject({ ok: false, reason: expect.stringMatching(/only inside Claude/) });
    expect(boardEligibility({ ...team, tracker: { kind: "none" } }, true)).toMatchObject({ ok: false, reason: expect.stringMatching(/no Linear project/) });
  });

  it("gives /pmx-board the page and exactly how to publish it, and remembers the link", async () => {
    const me = personal("/repo");
    await savePersonalConfig(me);
    const j: any = await boardJson(team, me);
    expect(j).toMatchObject({ ready: true, html: boardFile(), icon: "board", url: null, capabilities: boardCapabilities() });
    expect(await readFile(boardFile(), "utf8")).toContain('"projectId":"proj-1"');

    await expect(setBoardUrl(me, "https://evil.example/artifact/x", new Date())).rejects.toThrow(/isn't a Claude artifact link/);
    await setBoardUrl(me, `${URL1}/`, new Date("2026-11-05T10:00:00Z"));
    expect((await loadPersonalConfig()).board).toEqual({ url: URL1, version: currentVersion(), publishedAt: "2026-11-05T10:00:00.000Z" });
    expect(await boardJson(team, me)).toMatchObject({ url: URL1, source: "personal", publishedVersion: currentVersion() });

    // A board shared in pmx.config.json wins, so a teammate never publishes a second one.
    const shared = { ...team, board: { url: "https://claude.ai/artifact/TeamBoard1" } };
    expect(boardUrl(shared, me)).toEqual({ url: "https://claude.ai/artifact/TeamBoard1", source: "team" });

    process.env.PMX_CLAUDE_HOME = join(await tmp(), "no-claude-here");
    expect(await boardJson(team, me)).toMatchObject({ ready: false, reason: expect.stringMatching(/Claude isn't set up/) });
  });

  it("says what to do next, including when the board is out of date", () => {
    const me = personal("/repo");
    expect(formatBoard(team, me, { ok: true }, false)).toMatch(/pmx board --install-skill/);
    expect(formatBoard(team, me, { ok: true }, true)).toMatch(/type \/pmx-board/);
    me.board = { url: URL1, version: "0.0.1", publishedAt: "2026-11-01T00:00:00Z" };
    const out = formatBoard(team, me, { ok: true }, true);
    expect(out).toContain(`Team board: ${URL1}`);
    expect(out).toMatch(/published with pmx 0\.0\.1.*\/pmx-board/);
    expect(out).toContain(`"board": { "url": "${URL1}" }`);
    expect(formatBoard(team, me, { ok: false, reason: "nope" }, true)).toBe("No Claude board for this team: nope");
  });

  it("accepts only a Claude artifact link in pmx.config.json", () => {
    expect(() => validateTeamConfig({ ...team, board: { url: URL1 } })).not.toThrow();
    expect(() => validateTeamConfig({ ...team, board: { url: "https://example.com/board" } })).toThrow(/board.url must be a Claude artifact link/);
  });

  it("installs /pmx-board beside /pmx-schedule and keeps PMX's own copies current", async () => {
    expect(appSkillTarget(BOARD_SKILL)).toBe(join(process.env.PMX_CLAUDE_HOME!, "skills", "pmx-board", "SKILL.md"));
    expect(await refreshAppSkills()).toEqual([]); // never adds a command the PM didn't install
    expect(await installAppSkill(BOARD_SKILL)).toBe("installed");
    const skill = await readFile(appSkillSource(BOARD_SKILL), "utf8");
    expect(skill).toContain("pmx board --json");
    expect(skill).toMatch(/Never create a second board/);

    await writeFile(appSkillTarget(BOARD_SKILL), "<!-- Installed by Product Git -->\nname: pmx-board\nold");
    await mkdir(join(appSkillTarget(), ".."), { recursive: true });
    await writeFile(appSkillTarget(), "---\nname: pmx-schedule\n---\nmy own version");
    expect(await refreshAppSkills()).toEqual(["pmx-board"]);
    expect(await readFile(appSkillTarget(), "utf8")).toContain("my own version");
  });
});
