import { neededTasks, taskState } from "../claude/tasks.js";
import { nodeSupported, resolveClaude } from "../core/claude-bin.js";
import { missingAllowRules } from "../claude/permissions.js";
import { linearAccess } from "../linear/access.js";
import { relayHealth } from "../tracker/relay.js";
import { boardUrl, checkBoard } from "../claude/board.js";
import { appSkillInstalled, BOARD_SKILL, claudePresent } from "../claude/skill.js";
import { loadState } from "../core/state.js";
import { VENDORED_CLI } from "../core/vendor.js";
import { atLeast, compareVersions, currentVersion, vendoredVersion } from "../core/version.js";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PersonalConfig, TeamConfig } from "../core/config.js";
import type { Exec } from "../core/exec.js";
import { Git } from "../core/git.js";
import type { Keychain } from "../core/keychain.js";
import { killSwitchOn } from "../core/killswitch.js";
import type { Launchd } from "../core/launchd.js";
import { paths, TEAM_CONFIG_FILE } from "../core/paths.js";
import { profileChecks, type Check } from "../core/profile.js";
import { RunLogStore } from "../core/runlog-store.js";
import { teamSkillPath } from "../core/skills.js";
import type { RunLogEntry } from "../core/runlog.js";
import { SIZES, type Size } from "../core/types.js";

export interface DoctorDeps {
  team: TeamConfig | null;
  teamError?: string;
  personal: PersonalConfig | null;
  keychain: Keychain;
  launchd: Launchd;
  exec: Exec;
  /** The Node binary the background job uses; tests pass their own. */
  execPath?: string;
  /** Extra checks from ee/ (license, policy). */
  extra?: () => Promise<DoctorCheck[]>;
}

export interface DoctorCheck extends Check {
  level: "fail" | "warn";
}

/** Token shapes that must never appear in a plain-text config (SEC-10). */
const TOKEN_SHAPES = /\b(xox[abpr]-[\w-]{10,}|lin_(api|oauth)_\w{20,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|sk-ant-[\w-]{20,}|pmxm_\w{20,})/;


export async function runDoctor(d: DoctorDeps): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  const add = (id: string, ok: boolean, detail: string, level: "fail" | "warn" = "fail") => out.push({ id, ok, detail, level });

  add("os.macos", process.platform === "darwin", "macOS (v1 supports macOS only, SCOPE-3)");
  add("node", nodeSupported(), `Node ${process.versions.node}${nodeSupported() ? "" : ": PMX needs 22.12 or later (24 recommended): brew install node"}`);
  // The background job keeps this Node's path, so a version manager switching or removing it stops the job.
  const execPath = d.execPath ?? process.execPath;
  if (/\/\.(nvm|fnm|volta|asdf)\/|\/n\/versions\//.test(execPath))
    add("node.path", false, `Node runs from a version manager (${execPath}); the background job breaks if that version is switched or removed. Recommended: brew install node, reinstall pmx, then \`pmx init\``, "warn");
  const cc = await resolveClaude(d.exec);
  add("claude.installed", !!cc, cc ? `Claude Code ${cc.version}${cc.onPath ? "" : ` at ${cc.cmd} (not on your shell's PATH; PMX finds it there)`}` : "Claude Code installed (https://code.claude.com)");

  add("config.personal", !!d.personal, d.personal ? `personal config at ${paths.config()}` : "personal config missing: run `pmx init`");
  add("config.team", !!d.team, d.team ? `${TEAM_CONFIG_FILE} valid (team ${d.team.team})` : `team config: ${d.teamError ?? "missing"}`);
  if (!d.personal || !d.team) return out;

  const repo = d.personal.repoPath;
  for (const f of ["CLAUDE.md", "memory", ".claude/settings.json", "CODEOWNERS"]) {
    const ok = await stat(join(repo, f)).then(() => true, () => false);
    add(`repo.${f}`, ok, `PMX repo has ${f}${f === "memory" ? " (shared team memory, B4)" : f === "CODEOWNERS" ? " (code owners on skills, memory, config)" : ""}`);
  }
  for (const [cat, { skill }] of Object.entries(d.team.categories)) {
    const ok = await stat(teamSkillPath(repo, skill)).then(() => true, () => false);
    add(`skill.${skill}`, ok, `shared skill ${skill} for ${cat} in .claude/skills (NEUT-2)`);
  }
  const digestSkill = await stat(teamSkillPath(repo, "pmx-digest")).then(() => true, () => false);
  add("skill.pmx-digest", digestSkill, "shared skill pmx-digest in .claude/skills", "warn");

  for (const c of await profileChecks(d.team)) add(c.id, c.ok, c.detail);

  // Versions (COMPAT-2, COMPAT-5): too old for the team fails; a newer team or release package warns.
  const current = currentVersion();
  const min = d.team.cli?.min;
  add("cli.team-minimum", !min || atLeast(current, min), min ? `pmx ${current}; team minimum ${min}${atLeast(current, min) ? "" : ": run `pmx update`"}` : `pmx ${current}; no team minimum set (\`pmx vendor --require\` sets one)`);
  // The team package is what teammates and the background job install, so one older than this Mac warns too.
  const vendored = await vendoredVersion(join(repo, VENDORED_CLI), d.exec);
  const drift = vendored ? compareVersions(vendored, current) ?? 0 : 0;
  add("cli.team-package", !vendored || drift === 0,
    !vendored ? `no CLI package in the PMX repo (\`pmx vendor\`)`
      : drift > 0 ? `team package is pmx ${vendored}, newer than this Mac's ${current}: run \`pmx update\``
      : drift < 0 ? `team package is pmx ${vendored}, older than this Mac's ${current}: teammates who install or update get ${vendored}. Team lead: run \`pmx vendor --require\` and merge it`
      : `team package is pmx ${vendored}`, "warn");
  // Claude tasks (CLAUDE-1): PMX can't create them, so doctor says which are missing.
  const fix = (await appSkillInstalled()) ? "type /pmx-schedule in the Claude app" : "run `pmx schedule`";
  const tasks = await neededTasks(d.team, d.keychain);
  for (const t of tasks) {
    const state = await taskState(t);
    add(`claude.task.${t.id}`, state === "current", `Claude scheduled task "${t.title}"${state === "current" ? "" : state === "outdated" ? ` has an older prompt: ${fix}` : ` is missing: ${fix}`}`, "warn");
  }
  // CLAUDE-3: without always-allow rules, a scheduled run waits on a prompt nobody answers and blocks later runs.
  if (await claudePresent()) {
    const rules = await missingAllowRules();
    add("claude.allow", !rules.length, rules.length ? `scheduled tasks will stop to ask permission (${rules.join(", ")} not allowed): run \`pmx schedule --allow\`` : "scheduled tasks may run pmx and use ~/.pmx without asking", "warn");
  }
  // The Claude board (BOARD-1), only where Claude and Linear are both in use.
  if ((await checkBoard(d.team)).ok) {
    const b = boardUrl(d.team, d.personal);
    const stale = b?.source === "personal" && d.personal.board?.version !== current;
    const how = (await appSkillInstalled(BOARD_SKILL)) ? "type /pmx-board in the Claude app" : "run `pmx board --install-skill`, then type /pmx-board in the Claude app";
    add("claude.board", !!b && !stale, b ? `team board ${b.url}${stale ? `: published with an older pmx; ${how} to update it` : ""}` : `no Claude board yet: ${how}`, "warn");
  }
  const st = await loadState();
  if (d.team.cli?.autoUpdate) {
    const au = st.autoUpdate;
    const stuck = au && (au.result === "needs-sudo" || au.result === "failed");
    add("cli.auto-update", !stuck, au
      ? `auto-update on; last check ${au.checkedAt.slice(0, 16).replace("T", " ")}: ${stuck ? `pmx ${au.version} is waiting, run \`pmx update\`` : au.result === "dev-install" ? "source checkout, not replaced" : au.result}`
      : "auto-update on; the background job hasn't checked yet", "warn");
  }
  const cloud = st.cloudVersions;
  if (cloud?.latest) add("cli.latest", (compareVersions(cloud.latest, current) ?? 0) <= 0, `latest release is pmx ${cloud.latest}`, "warn");

  const loose: string[] = [];
  for (const dir of [paths.home(), paths.staging(), paths.receipts(), paths.transcripts()]) {
    const st = await stat(dir).catch(() => null);
    if (st && st.mode & 0o077) loose.push(dir);
  }
  add("home.private", !loose.length, loose.length ? `readable by other users on this Mac: ${loose.join(", ")}. Fix: chmod 700 ${loose.join(" ")}` : `${paths.home()} is private to you (drafts, receipts, transcripts)`);

  let leaked = false;
  for (const f of [paths.config(), join(repo, TEAM_CONFIG_FILE)]) {
    const t = await readFile(f, "utf8").catch(() => "");
    if (TOKEN_SHAPES.test(t)) leaked = true;
  }
  add("secrets.not-in-config", !leaked, "no tokens in plain-text config (SEC-10)");
  const have = new Set(await d.keychain.list());
  const slackNeeded = d.team.allowedSources.includes("slack") && (!!d.personal.sources.slackChannel || d.team.synthesizer !== null);
  if (slackNeeded) add("secrets.slack", have.has("slack-token"), "Slack token in the keychain");
  // Linear is checked the way this Mac reaches it (LINEAR-1, LINEAR-2): the relay needs no token, so it can't fail here.
  const access = await linearAccess(d.team, d.keychain);
  if (access === "key") add("secrets.linear", true, "Linear API key in the keychain");
  if (access === "signed-in") add("secrets.linear", true, "signed in to Linear");
  if (access === "relay") {
    const h = await relayHealth(d.team);
    add("linear.relay", h.ok, h.detail, "warn");
  }

  // PMX runs on the PM's Claude subscription; only Free has no Claude Code.
  const plan = d.personal.plan;
  add("model.plan", plan !== "free", plan === "free" ? "Claude Free doesn't include Claude Code: PMX needs a Pro, Max, Team or Enterprise plan" : `model plan "${plan}"`, "warn");

  add("schedule.launchd", await d.launchd.isLoaded(), "one launchd job registered (runs `pmx tick` every 30 min)", "warn");

  const git = new Git(repo, d.exec);
  const ks = await killSwitchOn(git).catch(() => ({ on: false, reason: null }));
  add("killswitch", !ks.on, ks.on ? `kill switch is ON (${ks.reason}): no agent will pull` : "kill switch off", "warn");

  const store = new RunLogStore({ repo: git, exec: d.exec });
  const v = !(await store.exists())
    ? { ok: true, entries: 0, agents: 0, problems: [] }
    : await store.verify().catch((e) => ({ ok: false, entries: 0, agents: 0, problems: [String(e.message)] }));
  add("runlog.chain", v.ok, v.ok ? `run log chain intact (${v.entries} entries, ${v.agents} agents)` : `run log: ${v.problems.slice(0, 3).join("; ")}`);

  if (v.ok && v.entries) {
    for (const s of calibrate(await store.entries(), d.team)) add(`calibrate.${s.size}`, false, s.text, "warn");
  }

  if (d.extra) out.push(...(await d.extra()));
  return out;
}

/**
 * Size calibration (PULL-10): compares the median cost and duration of successful runs per size
 * with the team's estimates and suggests new ones when they're off by more than half.
 */
export function calibrate(entries: RunLogEntry[], team: TeamConfig, minRuns = 5): { size: Size; text: string }[] {
  const out: { size: Size; text: string }[] = [];
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
  };
  for (const size of SIZES) {
    const runs = entries.filter((e): e is Extract<RunLogEntry, { type: "run" }> => e.type === "run" && e.outcome === "ok" && e.size === size);
    if (runs.length < minRuns) continue;
    const est = team.sizes[size];
    const cost = median(runs.map((r) => r.costUsd ?? 0));
    const minutes = median(runs.map((r) => r.durationMs / 60000));
    const off = (a: number, b: number) => b > 0 && Math.abs(a - b) / b > 0.5;
    if (off(cost, est.costUsd) || off(minutes, est.minutes))
      out.push({ size, text: `size ${size}: ${runs.length} runs took a median ${minutes.toFixed(0)} min and $${cost.toFixed(2)}; pmx.config.json says ${est.minutes} min and $${est.costUsd.toFixed(2)}. Suggest "${size}": { "minutes": ${Math.ceil(minutes)}, "costUsd": ${cost.toFixed(2)} }` });
  }
  return out;
}

/** `pmx doctor --json`: what an install script (or Claude, following INSTALL.md) checks. */
export function doctorJson(checks: DoctorCheck[]) {
  const failed = checks.filter((c) => !c.ok && c.level === "fail").map((c) => c.id);
  const warnings = checks.filter((c) => !c.ok && c.level === "warn").map((c) => c.id);
  return { ok: !failed.length, version: currentVersion(), node: process.versions.node, failed, warnings, checks };
}

export function formatDoctor(checks: DoctorCheck[]): { text: string; ok: boolean } {
  const lines = checks.map((c) => `${c.ok ? "\u001b[32m✔\u001b[0m" : c.level === "warn" ? "\u001b[33m!\u001b[0m" : "\u001b[31m✘\u001b[0m"} ${c.detail}`);
  const fails = checks.filter((c) => !c.ok && c.level === "fail").length;
  const warns = checks.filter((c) => !c.ok && c.level === "warn").length;
  lines.push("", fails ? `${fails} check(s) failed, ${warns} warning(s).` : `All required checks passed${warns ? `, ${warns} warning(s)` : ""}.`);
  return { text: lines.join("\n"), ok: fails === 0 };
}
