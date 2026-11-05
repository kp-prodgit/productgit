import { neededTasks, taskExists } from "../claude/tasks.js";
import { appSkillInstalled } from "../claude/skill.js";
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
  /** Extra checks from ee/ (license, policy). */
  extra?: () => Promise<DoctorCheck[]>;
}

export interface DoctorCheck extends Check {
  level: "fail" | "warn";
}

/** Token shapes that must never appear in a plain-text config (SEC-10). */
const TOKEN_SHAPES = /\b(xox[abpr]-[\w-]{10,}|lin_(api|oauth)_\w{20,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|sk-ant-[\w-]{20,}|pmxm_\w{20,})/;

const CONSUMER_PLANS = new Set(["pro", "max", "free"]);

export async function runDoctor(d: DoctorDeps): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  const add = (id: string, ok: boolean, detail: string, level: "fail" | "warn" = "fail") => out.push({ id, ok, detail, level });

  add("os.macos", process.platform === "darwin", "macOS (v1 supports macOS only, SCOPE-3)");
  add("node", Number(process.versions.node.split(".")[0]) >= 20, `Node ${process.versions.node} (need 20+)`);
  const cc = await d.exec("claude", ["--version"], { timeoutMs: 15000 });
  add("claude.installed", cc.code === 0, cc.code === 0 ? `Claude Code ${cc.stdout.trim()}` : "Claude Code installed (https://code.claude.com)");

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
  const vendored = await vendoredVersion(join(repo, VENDORED_CLI), d.exec);
  add("cli.team-package", !vendored || !((compareVersions(vendored, current) ?? 0) > 0),
    vendored ? `team package is pmx ${vendored}${(compareVersions(vendored, current) ?? 0) > 0 ? ": run `pmx update`" : ""}` : `no CLI package in the PMX repo (\`pmx vendor\`)`, "warn");
  // Claude tasks (CLAUDE-1): PMX can't create them, so doctor says which are missing.
  const fix = (await appSkillInstalled()) ? "type /pmx-schedule in the Claude app" : "run `pmx schedule`";
  for (const t of await neededTasks(d.team, d.keychain))
    add(`claude.task.${t.id}`, await taskExists(t.id), `Claude scheduled task "${t.title}"${(await taskExists(t.id)) ? "" : ` is missing: ${fix}`}`, "warn");
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
  if (d.team.tracker.kind === "linear" && !d.team.controlPlane)
    add("secrets.linear", have.has("linear-token"), "Linear token in the keychain");

  const plan = d.personal.plan;
  add(
    "model.plan",
    !CONSUMER_PLANS.has(plan),
    CONSUMER_PLANS.has(plan)
      ? `model plan is "${plan}": use Claude Code Team/Enterprise or an API key (Anthropic, Bedrock, Vertex) for automation (SEC-9)`
      : `model plan "${plan}" (SEC-9)`,
    "warn",
  );

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

export function formatDoctor(checks: DoctorCheck[]): { text: string; ok: boolean } {
  const lines = checks.map((c) => `${c.ok ? "\u001b[32m✔\u001b[0m" : c.level === "warn" ? "\u001b[33m!\u001b[0m" : "\u001b[31m✘\u001b[0m"} ${c.detail}`);
  const fails = checks.filter((c) => !c.ok && c.level === "fail").length;
  const warns = checks.filter((c) => !c.ok && c.level === "warn").length;
  lines.push("", fails ? `${fails} check(s) failed, ${warns} warning(s).` : `All required checks passed${warns ? `, ${warns} warning(s)` : ""}.`);
  return { text: lines.join("\n"), ok: fails === 0 };
}
