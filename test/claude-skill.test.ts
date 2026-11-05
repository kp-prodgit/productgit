import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { appSkillInstalled, appSkillSource, appSkillTarget, installAppSkill } from "../src/claude/skill.js";
import { COLLECT_TASK, formatTasks, tasksJson, taskFile } from "../src/claude/tasks.js";
import { DEFAULT_TEAM, type TeamConfig } from "../src/core/config.js";
import { memoryKeychain } from "../src/core/keychain.js";
import { tmp } from "./helpers.js";

const team = { ...DEFAULT_TEAM, team: "t", tracker: { kind: "linear", teamKey: "PMX", projectId: "proj-1" } } as TeamConfig;

describe("/pmx-schedule skill (CLAUDE-2)", () => {
  beforeEach(async () => {
    process.env.PMX_CLAUDE_HOME = await tmp("claude-home-");
  });

  it("installs into the PM's own Claude skills, refreshes its own copy, and never overwrites theirs", async () => {
    expect(appSkillTarget()).toBe(join(process.env.PMX_CLAUDE_HOME!, "skills", "pmx-schedule", "SKILL.md"));
    expect(await appSkillInstalled()).toBe(false);
    expect(await installAppSkill()).toBe("installed");
    expect(await readFile(appSkillTarget(), "utf8")).toBe(await readFile(appSkillSource(), "utf8"));
    expect(await installAppSkill()).toBe("current");

    await writeFile(appSkillTarget(), "<!-- Installed by Product Git -->\nname: pmx-schedule\nold version");
    expect(await installAppSkill()).toBe("updated");

    await writeFile(appSkillTarget(), "---\nname: pmx-schedule\n---\nmy own version");
    expect(await installAppSkill()).toBe("kept-yours");
    expect(await readFile(appSkillTarget(), "utf8")).toContain("my own version");
  });

  it("tells Claude exactly what to create, and nothing else", async () => {
    const skill = await readFile(appSkillSource(), "utf8");
    expect(skill).toContain("pmx schedule --json");
    expect(skill).toMatch(/never change or delete any other scheduled task/);

    const j = await tasksJson(team, memoryKeychain());
    expect(j.present).toEqual([]);
    expect(j.missing.map((t) => [t.taskId, t.cronExpression])).toEqual([["pmx-collect-meetings", "30 12,17 * * 1-5"], ["pmx-sync-linear", "0 8-18 * * 1-5"]]);
    expect(j.missing[0]!.prompt).toContain("pmx collect --prompt");

    await mkdir(join(taskFile(COLLECT_TASK.id), ".."), { recursive: true });
    await writeFile(taskFile(COLLECT_TASK.id), "x");
    expect((await tasksJson(team, memoryKeychain())).present).toEqual(["pmx-collect-meetings"]);
  });

  it("points to /pmx-schedule once the skill is installed", async () => {
    expect(await formatTasks(team, memoryKeychain())).toMatch(/pmx schedule --install-skill/);
    await installAppSkill();
    const out = await formatTasks(team, memoryKeychain());
    expect(out).toMatch(/type \/pmx-schedule/);
    expect(out).toContain('Create a scheduled task titled "PMX: sync Linear through Claude"'); // the paste fallback stays
  });
});
