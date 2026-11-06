import { cp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_TEAM, type TeamConfig } from "./config.js";
import { writeJson } from "./fsutil.js";
import { TEAM_CONFIG_FILE } from "./paths.js";
import { bundledSkillsDir, packageRoot } from "./skills.js";
import { cliVersion } from "./vendor.js";

const present = (p: string) => stat(p).then(() => true, () => false);

/**
 * Sets up a PMX repo from the template: CLAUDE.md, team memory, project settings, CODEOWNERS,
 * the shared skills and `pmx.config.json`. Never overwrites a file that exists.
 * Returns the paths it created.
 */
export async function scaffoldRepo(repoPath: string, team: Partial<TeamConfig> & { team: string }): Promise<string[]> {
  const created: string[] = [];
  const template = join(packageRoot(), "templates", "pmx-repo");

  async function copyTree(from: string, to: string, rel = ""): Promise<void> {
    for (const e of await readdir(from, { withFileTypes: true })) {
      const src = join(from, e.name);
      const dst = join(to, e.name);
      if (e.isDirectory()) await copyTree(src, dst, join(rel, e.name));
      else if (!(await present(dst))) {
        await cp(src, dst, { recursive: false });
        // Workflows pin the release-package fallback to this CLI's version.
        if (e.name.endsWith(".yml")) await writeFile(dst, (await readFile(dst, "utf8")).replaceAll("{{PMX_VERSION}}", await cliVersion()));
        created.push(join(rel, e.name));
      }
    }
  }

  await copyTree(template, repoPath);
  await copyTree(bundledSkillsDir(), join(repoPath, ".claude", "skills"), join(".claude", "skills"));

  const cfgPath = join(repoPath, TEAM_CONFIG_FILE);
  if (!(await present(cfgPath))) {
    await writeJson(cfgPath, { ...DEFAULT_TEAM, ...team }, 0o644);
    created.push(TEAM_CONFIG_FILE);
  }
  return created;
}
