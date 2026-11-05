import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "../core/skills.js";

/**
 * The `/pmx-schedule` skill for the PM's Claude app (CLAUDE-2). PMX can't reach the app's scheduling
 * tool, but Claude can from inside an app session, so PMX installs a skill that does it on request.
 * It goes to the PM's personal skills, never the team repo, so PMX's own runs never load it.
 */
export const APP_SKILL = "pmx-schedule";
const MARKER = "Installed by Product Git";

export const appSkillSource = () => join(packageRoot(), "app-skills", APP_SKILL, "SKILL.md");
/** The PM's Claude app folder. Tests point PMX_CLAUDE_HOME elsewhere so they never touch the real one. */
export const claudeAppHome = () => process.env.PMX_CLAUDE_HOME ?? join(homedir(), ".claude");
export const appSkillTarget = () => join(claudeAppHome(), "skills", APP_SKILL, "SKILL.md");

export type SkillInstall = "installed" | "updated" | "current" | "kept-yours";

/** Writes the skill, or refreshes a copy PMX installed. Never overwrites a file the PM wrote themselves. */
export async function installAppSkill(): Promise<SkillInstall> {
  const want = await readFile(appSkillSource(), "utf8");
  const have = await readFile(appSkillTarget(), "utf8").catch(() => null);
  if (have === want) return "current";
  if (have !== null && !have.includes(MARKER)) return "kept-yours";
  await mkdir(join(appSkillTarget(), ".."), { recursive: true });
  await writeFile(appSkillTarget(), want, { mode: 0o644 });
  return have === null ? "installed" : "updated";
}

export async function appSkillInstalled(): Promise<boolean> {
  return readFile(appSkillTarget(), "utf8").then((t) => t.includes(`name: ${APP_SKILL}`), () => false);
}
