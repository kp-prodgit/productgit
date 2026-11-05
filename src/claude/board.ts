import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { savePersonalConfig, type PersonalConfig, type TeamConfig } from "../core/config.js";
import { pmxHome } from "../core/paths.js";
import { packageRoot } from "../core/skills.js";
import { currentVersion } from "../core/version.js";
import { BOARD_SKILL, claudePresent } from "./skill.js";

/**
 * The team board as a live Claude artifact (BOARD-1). The page reads the team's Linear project through
 * each viewer's own Linear connector, so it needs no hosted app, API key or sign-in, and it works only
 * inside Claude. PMX can't publish artifacts, so it fills in the page and `/pmx-board` publishes it.
 */
export const boardTemplate = () => join(packageRoot(), "app-skills", BOARD_SKILL, "board.html");
export const boardFile = () => join(pmxHome(), "board", "pmx-board.html");

/** The Linear connector tools the page calls. `save_issue` only moves cards between the pool and Ready. */
export const BOARD_TOOLS = ["list_issues", "list_issue_labels", "list_comments", "save_issue"] as const;
export const boardCapabilities = () => ({ mcp: { servers: [{ server: "Linear", tools: [...BOARD_TOOLS] }] } });
export const ARTIFACT_URL = /^https:\/\/claude\.ai\/(code\/)?artifact\/[A-Za-z0-9_-]+\/?$/;
const CONFIG_BLOCK = /(<script type="application\/json" id="pmx-config">)[\s\S]*?(<\/script>)/;

export type Eligibility = { ok: true } | { ok: false; reason: string };

/** The board is for teams that keep their work in Linear and use Claude on this Mac. */
export function boardEligibility(team: TeamConfig | null, claude: boolean): Eligibility {
  if (!claude) return { ok: false, reason: "Claude isn't set up on this Mac, and the board runs only inside Claude." };
  if (team?.tracker.kind !== "linear") return { ok: false, reason: "pmx.config.json has no Linear project, and the board shows a Linear project." };
  return { ok: true };
}

export async function checkBoard(team: TeamConfig | null): Promise<Eligibility> {
  return boardEligibility(team, await claudePresent());
}

/** The team's shared board (committed in pmx.config.json) wins over the one this PM published. */
export function boardUrl(team: TeamConfig | null, personal: PersonalConfig | null): { url: string; source: "team" | "personal" } | null {
  if (team?.board?.url) return { url: team.board.url, source: "team" };
  if (personal?.board?.url) return { url: personal.board.url, source: "personal" };
  return null;
}

/** Fills the team's Linear project into the page. `<` is escaped so no value can end the script tag. */
export function fillBoard(template: string, team: TeamConfig): string {
  if (team.tracker.kind !== "linear") throw new Error("The board needs a Linear project in pmx.config.json.");
  if (!CONFIG_BLOCK.test(template)) throw new Error("The board template has no config block. Reinstall PMX.");
  const cfg = JSON.stringify({ team: team.team, teamKey: team.tracker.teamKey, projectId: team.tracker.projectId, version: currentVersion() }).replace(/</g, "\\u003c");
  return template.replace(CONFIG_BLOCK, (_, open: string, close: string) => `${open}${cfg}${close}`);
}

export async function renderBoard(team: TeamConfig): Promise<string> {
  const html = fillBoard(await readFile(boardTemplate(), "utf8"), team);
  await mkdir(join(boardFile(), ".."), { recursive: true });
  await writeFile(boardFile(), html, { mode: 0o644 });
  return boardFile();
}

/** What `/pmx-board` reads (`pmx board --json`): the page to publish and exactly how. */
export async function boardJson(team: TeamConfig | null, personal: PersonalConfig | null) {
  const e = await checkBoard(team);
  const existing = boardUrl(team, personal);
  if (!e.ok || !team) return { ready: false, reason: e.ok ? "No PMX repo found." : e.reason, url: existing?.url ?? null, source: existing?.source ?? null };
  return {
    ready: true,
    html: await renderBoard(team),
    title: "PMX Board",
    description: `${team.team}'s PMX pipeline, live from Linear through each viewer's own Linear connector.`,
    icon: "board",
    capabilities: boardCapabilities(),
    url: existing?.url ?? null,
    source: existing?.source ?? null,
    publishedVersion: existing?.source === "personal" ? personal?.board?.version ?? null : null,
    version: currentVersion(),
  };
}

export async function setBoardUrl(personal: PersonalConfig, url: string, now: Date): Promise<void> {
  if (!ARTIFACT_URL.test(url)) throw new Error(`"${url}" isn't a Claude artifact link (https://claude.ai/artifact/…).`);
  personal.board = { url: url.replace(/\/$/, ""), version: currentVersion(), publishedAt: now.toISOString() };
  await savePersonalConfig(personal);
}

export function formatBoard(team: TeamConfig | null, personal: PersonalConfig | null, e: Eligibility, skill: boolean): string {
  const existing = boardUrl(team, personal);
  if (!e.ok) return `No Claude board for this team: ${e.reason}`;
  const lines: string[] = [];
  if (existing) {
    lines.push(`Team board: ${existing.url}`, existing.source === "team" ? "(shared in pmx.config.json)" : "(published from this Mac)");
    if (existing.source === "personal" && personal?.board?.version !== currentVersion())
      lines.push("", `It was published with pmx ${personal?.board?.version ?? "an older version"}. Type /pmx-board in the Claude app to update it to ${currentVersion()}.`);
    if (existing.source === "personal")
      lines.push("", "To give teammates the same board, share it from the artifact's Share menu, then add it to pmx.config.json in a PR:", `  "board": { "url": "${existing.url}" }`);
    return lines.join("\n");
  }
  lines.push("This team has no Claude board yet.");
  lines.push(skill
    ? "Open the Claude desktop app (Code tab), start a session and type /pmx-board. Claude publishes the board as a live artifact in your account."
    : "Run `pmx board --install-skill` once to add a /pmx-board command to your Claude app, then type /pmx-board there.");
  lines.push("Everyone who opens it sees the Linear project through their own Linear connector, so each person needs Linear connected in Claude.");
  return lines.join("\n");
}
