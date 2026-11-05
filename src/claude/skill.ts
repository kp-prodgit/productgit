import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "../core/skills.js";

/**
 * PMX's commands for the PM's Claude app: `/pmx-schedule` (CLAUDE-2) and `/pmx-board` (BOARD-1). PMX can't
 * reach the app's scheduling or artifact tools, but Claude can from inside an app session, so PMX installs
 * skills that do it on request. They go to the PM's personal skills, never the team repo, so PMX's own runs
 * never load them.
 */
export const APP_SKILL = "pmx-schedule";
export const BOARD_SKILL = "pmx-board";
export type AppSkill = typeof APP_SKILL | typeof BOARD_SKILL;
const MARKER = "Installed by Product Git";

export const appSkillSource = (name: AppSkill = APP_SKILL) => join(packageRoot(), "app-skills", name, "SKILL.md");
/** The PM's Claude app folder. Tests point PMX_CLAUDE_HOME elsewhere so they never touch the real one. */
export const claudeAppHome = () => process.env.PMX_CLAUDE_HOME ?? join(homedir(), ".claude");
export const appSkillTarget = (name: AppSkill = APP_SKILL) => join(claudeAppHome(), "skills", name, "SKILL.md");

export type SkillInstall = "installed" | "updated" | "current" | "kept-yours";

/** Writes the skill, or refreshes a copy PMX installed. Never overwrites a file the PM wrote themselves. */
export async function installAppSkill(name: AppSkill = APP_SKILL): Promise<SkillInstall> {
  const want = await readFile(appSkillSource(name), "utf8");
  const have = await readFile(appSkillTarget(name), "utf8").catch(() => null);
  if (have === want) return "current";
  if (have !== null && !have.includes(MARKER)) return "kept-yours";
  await mkdir(join(appSkillTarget(name), ".."), { recursive: true });
  await writeFile(appSkillTarget(name), want, { mode: 0o644 });
  return have === null ? "installed" : "updated";
}

export async function appSkillInstalled(name: AppSkill = APP_SKILL): Promise<boolean> {
  return readFile(appSkillTarget(name), "utf8").then((t) => t.includes(`name: ${name}`), () => false);
}

/** Whether this Mac has a Claude app or Claude Code home, which is where these commands live. */
export async function claudePresent(): Promise<boolean> {
  return stat(claudeAppHome()).then((s) => s.isDirectory(), () => false);
}

/** After an update, refreshes the commands PMX installed earlier. Never adds one the PM didn't install. */
export async function refreshAppSkills(): Promise<AppSkill[]> {
  const out: AppSkill[] = [];
  for (const name of [APP_SKILL, BOARD_SKILL] as const) {
    const have = await readFile(appSkillTarget(name), "utf8").catch(() => null);
    if (have?.includes(MARKER) && (await installAppSkill(name)) === "updated") out.push(name);
  }
  return out;
}
