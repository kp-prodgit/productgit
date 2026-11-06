import { boardUrl, checkBoard, renderBoard } from "../claude/board.js";
import { addAllowRules, ALLOW_RULES, missingAllowRules } from "../claude/permissions.js";
import { appSkillInstalled, appSkillTarget, BOARD_SKILL, claudePresent, installAppSkill } from "../claude/skill.js";
import { linearAccess } from "../linear/access.js";
import { createHash } from "node:crypto";
import { access, constants, mkdir, stat } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Asker } from "../core/ask.js";
import { DEFAULT_TEAM, loadTeamConfig, savePersonalConfig, validateTeamConfig, type PersonalConfig, type Plan, type TeamConfig } from "../core/config.js";
import { resolveClaude } from "../core/claude-bin.js";
import type { Exec } from "../core/exec.js";
import { privateDir, readJson } from "../core/fsutil.js";
import { Git } from "../core/git.js";
import type { Keychain } from "../core/keychain.js";
import { plist, type Launchd } from "../core/launchd.js";
import { paths, pmxHome } from "../core/paths.js";
import { writeProfile } from "../core/profile.js";
import { scaffoldRepo } from "../core/scaffold.js";
import { VENDORED_CLI, vendorCli } from "../core/vendor.js";
import type { Out } from "../core/context.js";

export interface InviteFile {
  version: 1;
  controlPlaneUrl: string;
  orgId: string;
  inviteCode: string;
  team: { repo?: string; linearTeamKey?: string; linearProjectId?: string };
}

export interface InitDeps {
  ask: Asker;
  keychain: Keychain;
  launchd: Launchd;
  exec: Exec;
  out: Out;
  now: () => Date;
  /** Absolute path to the CLI entry, for the launchd job. */
  cliPath: string;
  invite?: InviteFile | null;
  /** Called after the invite is accepted (ee/), to sign in and fetch the policy. */
  onInvite?: (invite: InviteFile) => Promise<void>;
}

const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const expand = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()));

/** A stable, non-identifying machine ID: a hash, not the hostname itself. */
export function machineId(): string {
  return "m" + createHash("sha256").update(hostname()).digest("hex").slice(0, 8);
}

/** Asks until `check` finds no problem. Gives up after three tries, so a script or a pasted command never loops. */
async function askValid(d: InitDeps, q: string, def: string, check: (a: string) => string | null | Promise<string | null>): Promise<string> {
  for (let i = 0; i < 3; i++) {
    const a = (await d.ask.text(q, def)).trim();
    const problem = await check(a);
    if (!problem) return a;
    d.out.warn(`${problem}. Try again.`);
  }
  throw new Error(`No valid answer to "${q}" after three tries. Nothing was saved; run \`pmx init\` again.`);
}

/** Answers that are really a command typed into the wrong prompt (a shell command or a Claude slash command). */
export function looksLikeCommand(a: string): boolean {
  return /^(pmx|npm|npx|node|git|gh|brew|claude|cd|sudo|ls)(\s|$)/i.test(a) || /^\/[a-z][\w-]*$/i.test(a) || /^-/.test(a);
}

/** A folder for the PMX repo: an existing folder, or one this user can create. */
export async function checkFolder(a: string): Promise<string | null> {
  if (!a) return "Enter a folder";
  if (looksLikeCommand(a)) return `"${a}" looks like a command, not a folder`;
  let p = expand(a);
  const st = await stat(p).catch(() => null);
  if (st) return st.isDirectory() ? null : `${p} is a file, not a folder`;
  // Walk up to the nearest folder that exists; PMX creates the rest, so that one must be writable.
  while (!(await stat(p).then(() => true, () => false))) p = dirname(p);
  return access(p, constants.W_OK).then(() => null, () => `You can't create folders in ${p}`);
}

/** A git URL (https, ssh, scp-style, file) or a local repo folder. Blank means "create a new repo". */
export async function checkGitUrl(a: string): Promise<string | null> {
  if (!a) return null;
  if (looksLikeCommand(a)) return `"${a}" looks like a command, not a git URL`;
  if (/^(https?|ssh|git|file):\/\/\S+$/.test(a) || /^[\w.-]+@[\w.-]+:\S+$/.test(a)) return null;
  if (await stat(join(expand(a), ".git")).then(() => true, () => false)) return null;
  return "Enter a git URL like https://github.com/acme/pmx.git or git@github.com:acme/pmx.git";
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Mon-Fri", "Mon,Wed,Fri" or "Sun-Sat" → day numbers (0 = Sunday). Null when it can't be read. */
export function parseDays(a: string): number[] | null {
  const day = (s: string) => DAYS.findIndex((d) => d.toLowerCase() === s.trim().slice(0, 3).toLowerCase());
  const out = new Set<number>();
  for (const part of a.split(",").map((x) => x.trim()).filter(Boolean)) {
    const [from, to] = part.split("-");
    const f = day(from ?? ""), t = to === undefined ? f : day(to);
    if (f < 0 || t < 0) return null;
    for (let i = f; ; i = (i + 1) % 7) { out.add(i); if (i === t) break; }
  }
  return out.size ? [...out].sort((x, y) => x - y) : null;
}

export function formatDays(days: number[]): string {
  const s = [...days].sort((a, b) => a - b);
  const contiguous = s.length > 1 && s.every((d, i) => i === 0 || d === s[i - 1]! + 1);
  return contiguous ? `${DAYS[s[0]!]}-${DAYS[s[s.length - 1]!]}` : s.map((d) => DAYS[d]).join(",");
}

/** "9:00-18:00" → ["09:00", "18:00"]. The end may be 24:00 and must come after the start. */
export function parseHours(a: string): [string, string] | null {
  const m = /^(\d{1,2}):([0-5]\d)\s*-\s*(\d{1,2}):([0-5]\d)$/.exec(a.trim());
  if (!m) return null;
  const [sh, sm, eh, em] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
  if (sh > 23 || eh > 24 || (eh === 24 && em > 0) || eh * 60 + em <= sh * 60 + sm) return null;
  const hhmm = (h: number, mm: number) => `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  return [hhmm(sh, sm), hhmm(eh, em)];
}

export async function runInit(d: InitDeps): Promise<PersonalConfig> {
  const { ask, out } = d;
  if (process.platform !== "darwin") throw new Error("Product Git v1 runs on macOS only (SCOPE-3).");

  const cc = await resolveClaude(d.exec);
  out.info(cc ? `Found Claude Code ${cc.version}${cc.onPath ? "" : ` at ${cc.cmd}`}.` : "Claude Code was not found. Install it from https://code.claude.com, then run `pmx doctor`.");

  const existing = await readJson<PersonalConfig>(paths.config());

  // 1. The PMX repo. Cloning a repo the PM named is the only write before the summary.
  out.info("PMX keeps your team's shared skills, memory and settings in a git repo, the \"PMX repo\". On your own? Accept the default and PMX creates one. Joining a team? Give the folder where you cloned it, or its git URL at the next question.");
  const repoPath = expand(await askValid(d, "Path to your team's PMX repo checkout", existing?.repoPath ?? join(homedir(), "pmx"), checkFolder));
  let repoNote = "existing repo";
  let newRepo: { team: string; tracker: TeamConfig["tracker"] } | null = null;
  if (!(await stat(join(repoPath, ".git")).then(() => true, () => false))) {
    const cloneInto = async (u: string) => {
      await mkdir(dirname(repoPath), { recursive: true });
      // `--` so an answer can never be read as a git option.
      const r = await d.exec("git", ["clone", "--", u, repoPath]);
      return r.code === 0 ? null : `git clone failed: ${r.stderr.trim().split("\n").pop()}`;
    };
    const invited = d.invite?.team.repo;
    if (invited) {
      const problem = (await checkGitUrl(invited)) ?? (await cloneInto(invited));
      if (problem) throw new Error(`The invite's repo ${invited} couldn't be cloned (${problem}). Ask your team lead for a new invite.`);
    }
    const url = invited ?? (await askValid(d, "No git repo there. Git URL of your team's PMX repo (blank to create a new one)", "", async (u) => (await checkGitUrl(u)) ?? (u ? cloneInto(u) : null)));
    repoNote = url ? `cloned from ${url}` : "new repo";
  }

  let team: TeamConfig;
  try {
    team = await loadTeamConfig(repoPath);
    out.info(`Using team config for "${team.team}".`);
  } catch {
    if (!(await ask.confirm("This repo has no pmx.config.json. Set it up as a new PMX repo?", true)))
      throw new Error("A PMX repo needs pmx.config.json. Ask your team lead for the repo or an invite file.");
    const teamName = await askValid(d, "Team name", "product", (a) => (/^\w[\w .-]{0,39}$/.test(a) ? null : "Use up to 40 letters, numbers, spaces, dots or dashes"));
    const linearTeamKey = (d.invite?.team.linearTeamKey ?? (await askValid(d, "Linear team key, like ENG (blank for none yet)", "", (a) => (!a || /^[a-z][a-z0-9]{0,9}$/i.test(a) ? null : "A Linear team key is a short code like ENG or PRO2")))).toUpperCase();
    const linearProjectId = linearTeamKey
      ? d.invite?.team.linearProjectId ?? (await askValid(d, "Linear PMX project ID (blank to add later)", "", (a) => (!a || (/^[\w-]{3,}$/.test(a) && !looksLikeCommand(a)) ? null : "Paste the project's ID from Linear")))
      : "";
    newRepo = { team: teamName, tracker: linearTeamKey && linearProjectId ? { kind: "linear", teamKey: linearTeamKey, projectId: linearProjectId } : { kind: "none" } };
    team = validateTeamConfig({ ...DEFAULT_TEAM, ...newRepo });
  }

  // 2. About this PM.
  const userDefault = (process.env.USER ?? "pm").replace(/[^\w-]/g, "") || "pm";
  const handle = await askValid(d, "Your handle (short, no spaces, used in branch names)", existing?.handle ?? userDefault, (a) => (/^[\w-]{1,32}$/.test(a) ? null : "Use letters, numbers, - or _ only"));
  const plan = (await ask.choose<Plan>(
    "Model plan for runs",
    ["team", "enterprise", "api", "bedrock", "vertex", "pro", "max"],
    existing?.plan ?? "team",
  )) as Plan;
  const cats = Object.keys(team.categories);
  const categories = split(await askValid(d, `Categories your agent accepts (${cats.join(", ")})`, (existing?.categories ?? cats).join(", "), (a) => {
    const unknown = split(a).filter((c) => !cats.includes(c));
    return unknown.length ? `Unknown: ${unknown.join(", ")}. Pick from ${cats.join(", ")}` : split(a).length ? null : "Pick at least one";
  }));
  const days = parseDays(await askValid(d, "Working days (like Mon-Fri or Mon,Wed,Fri)", formatDays(existing?.workingHours.days ?? [1, 2, 3, 4, 5]), (a) => (parseDays(a) ? null : "Use day names like Mon-Fri or Mon,Tue,Thu")))!;
  const [start, end] = parseHours(await askValid(d, "Working hours, in this Mac's local time (HH:MM-HH:MM)", existing ? `${existing.workingHours.start}-${existing.workingHours.end}` : "09:00-18:00", (a) => (parseHours(a) ? null : "Use HH:MM-HH:MM, like 09:00-18:00, with the end after the start")))!;
  const cap = team.caps.perDayUsd;
  const dailyUsd = Number(await askValid(d, `Daily spend cap for your agent's runs, in USD (0 pauses it; your team allows up to ${cap})`, String(existing?.budget.dailyUsd ?? Math.min(10, cap)), (a) => {
    const n = Number(a);
    return a === "" || !Number.isFinite(n) || n < 0 ? "Enter a number of dollars, like 10" : n > cap ? `Your team allows at most ${cap} a day` : null;
  }));

  // 3. Sources (default-deny, B2).
  const transcriptDirs = team.allowedSources.includes("transcripts")
    ? split(await askValid(d, "Folders with call transcripts to include (comma-separated)", (existing?.sources.transcriptDirs ?? [paths.transcripts()]).join(", "), (a) => (split(a).some(looksLikeCommand) ? "That looks like a command, not a folder" : null))).map(expand)
    : [];
  let slackChannel: string | null = null;
  if (team.allowedSources.includes("slack") && team.slackChannels.length) {
    const ch = await askValid(d, `Slack channel ID for your digest (one of ${team.slackChannels.join(", ")}, blank for none)`, existing?.sources.slackChannel ?? "", (a) => (!a || team.slackChannels.includes(a) ? null : `Pick one of ${team.slackChannels.join(", ")}`));
    slackChannel = ch || null;
  }
  const people = split(await ask.text("Never ingest anything involving these people (names or emails, comma-separated)", existing?.neverIngest.people.join(", ") ?? ""));
  const meetingTitles = split(await ask.text("Never ingest meetings whose titles contain (comma-separated)", existing?.neverIngest.meetingTitles.join(", ") ?? ""));
  const channels = split(await ask.text("Never ingest these channels (comma-separated)", existing?.neverIngest.channels.join(", ") ?? ""));
  const dm = slackChannel ? await askValid(d, "Your Slack user ID, to DM you the digest (blank to skip)", existing?.digest.slackDmUserId ?? "", (a) => (!a || /^[UW][A-Z0-9]{6,}$/.test(a) ? null : "A Slack user ID looks like U012AB3CD")) : "";

  const personal: PersonalConfig = {
    version: 1,
    handle,
    machineId: existing?.machineId ?? machineId(),
    repoPath,
    installedAt: existing?.installedAt ?? d.now().toISOString(),
    plan,
    categories,
    workingHours: { days, start, end },
    budget: { dailyUsd, resetHour: existing?.budget.resetHour ?? 0, overrideUsd: null },
    sources: { transcriptDirs, slackChannel },
    neverIngest: { people, channels, meetingTitles },
    crmNamesFile: existing?.crmNamesFile ?? null,
    digest: { weekday: existing?.digest.weekday ?? 5, slackDmUserId: dm || null },
  };

  // 4. Nothing is written until the PM has seen every answer.
  const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const tracker = team.tracker.kind === "linear" ? `Linear ${team.tracker.teamKey}` : "no Linear yet";
  out.info([
    "",
    "PMX will save this setup:",
    `  PMX repo       ${repoPath} (${repoNote}, team "${team.team}", ${tracker})`,
    `  You            ${handle}, ${plan} plan`,
    `  Agent work     ${categories.join(", ")}`,
    `  Working time   ${formatDays(days)} ${start}-${end} local time, up to $${dailyUsd} a day${dailyUsd === 0 ? " (paused)" : ""}`,
    `  Transcripts    ${transcriptDirs.join(", ") || "none"}`,
    ...(team.allowedSources.includes("slack") ? [`  Slack digest   ${slackChannel ?? "none"}`] : []),
    `  Never ingest   ${count(people.length, "person", "people")}, ${count(meetingTitles.length, "meeting title")}, ${count(channels.length, "channel")}`,
    `  Saved to       ${paths.config()}`,
  ].join("\n"));
  if (!(await ask.confirm("Save this setup?", true))) throw new Error("Nothing was saved. Run `pmx init` again to change your answers.");

  if (newRepo) {
    if (!(await stat(join(repoPath, ".git")).then(() => true, () => false))) {
      await mkdir(repoPath, { recursive: true });
      await d.exec("git", ["init", "-q", "-b", "main", repoPath]);
    }
    const git = new Git(repoPath, d.exec);
    const created = await scaffoldRepo(repoPath, newRepo);
    // Teammates and CI install the CLI from the repo, so they don't need npm access to it.
    await vendorCli(repoPath, d.exec).then(
      () => created.push(VENDORED_CLI),
      (e) => out.warn(`Couldn't add the CLI package to the repo (${e.message}). Run \`pmx vendor\` later.`),
    );
    out.info(`Created ${created.length} files in ${repoPath}.`);
    if (created.length && (await ask.confirm("Commit the PMX repo setup now?", true))) {
      await git.ok(["add", "-A"]);
      await git.ok(["commit", "-q", "-m", "Set up PMX repo with Product Git"]);
      out.info("Committed. Push it and protect main with required code-owner review (see CODEOWNERS).");
    }
    team = await loadTeamConfig(repoPath);
  }
  const git = new Git(repoPath, d.exec);

  // ~/.pmx holds transcripts, drafts and receipts: private to this user (PRIV-1). Folders the PM picks keep their own permissions.
  await privateDir(pmxHome());
  for (const dir of transcriptDirs) await (resolve(dir) === resolve(paths.transcripts()) ? privateDir(dir) : mkdir(dir, { recursive: true }));
  await savePersonalConfig(personal);

  // Secrets go to the keychain only (SEC-10).
  const secrets: [Parameters<Keychain["set"]>[0], string, boolean][] = [
    ["slack-token", "Slack bot token, read-only scopes plus chat:write for DMs (blank to skip)", !!slackChannel || team.synthesizer === handle],
    ["github-token", "GitHub token for opening PRs in the PMX repo (blank to use `gh`)", !!(await git.remoteUrl())?.includes("github.com")],
  ];
  for (const [name, q, needed] of secrets) {
    if (!needed || (await d.keychain.get(name))) continue;
    const v = await ask.secret(q);
    if (v) await d.keychain.set(name, v);
  }

  // 5. Clean profile (B1) and the one launchd job.
  await writeProfile(team);
  if (await ask.confirm("Register the background job (runs `pmx tick` every 30 minutes)?", true)) {
    await mkdir(paths.logs(), { recursive: true });
    await d.launchd.install(plist({ node: process.execPath, cli: d.cliPath, pmxHome: pmxHome() }));
    out.info("Registered launchd job com.productgit.pmx.");
  }
  if (d.invite && d.onInvite) await d.onInvite(d.invite);

  // CLAUDE-2 and BOARD-1: commands in the PM's own Claude app. /pmx-schedule creates PMX's scheduled tasks;
  // /pmx-board publishes the team board as a live artifact, offered only when Claude and Linear are both in use.
  const board = await checkBoard(team);
  const question = board.ok
    ? "Add /pmx-schedule and /pmx-board commands to your Claude app, so Claude can create PMX's scheduled tasks and publish your team's live board?"
    : "Add a /pmx-schedule command to your Claude app, so Claude can create PMX's scheduled tasks for you?";
  if (await ask.confirm(question, true)) {
    for (const name of board.ok ? [undefined, BOARD_SKILL] as const : [undefined] as const) {
      const r = await installAppSkill(name).catch(() => null);
      if (r === "kept-yours") out.warn(`Left your own ${appSkillTarget(name)} alone.`);
    }
    if (board.ok) await renderBoard(team).catch(() => null);
  }
  // CLAUDE-3: scheduled runs stall on prompts nobody answers, so offer always-allow rules for PMX's own command and folder.
  if ((await claudePresent()) && (await missingAllowRules()).length
    && (await ask.confirm(`Let PMX's scheduled tasks run pmx and use ~/.pmx without asking each time? (adds ${ALLOW_RULES.join(", ")} to your Claude settings)`, true))) {
    const r = await addAllowRules();
    if (r.error) out.warn(r.error);
  }
  if ((await linearAccess(team, d.keychain)) === "relay") out.info("Linear: PMX reaches it through your Claude app's Linear connector. No key or sign-in needed.");
  out.info("\nSetup done. The first week runs pulls as dry runs, so you can see what your agent would do.");
  return personal;
}

/** The one "Next step" block, printed after doctor so it's the last thing the PM reads. */
export async function nextSteps(team: TeamConfig, personal: PersonalConfig): Promise<string> {
  const lines = ["Next step:"];
  lines.push((await appSkillInstalled())
    ? "  1. Open the Claude desktop app (Code tab), start a session with auto mode off, and type /pmx-schedule. Claude creates PMX's scheduled tasks; click \"Run now\" on each once."
    : "  1. Run `pmx schedule` and paste what it prints into the Claude desktop app (Code tab), in a session with auto mode off.");
  lines.push(`  2. Put call transcripts in ${personal.sources.transcriptDirs[0] ?? "a transcripts folder"} and run \`pmx digest\`.`);
  const shared = boardUrl(team, personal);
  if (shared) lines.push(`Your team's board: ${shared.url}`);
  else if ((await checkBoard(team)).ok && (await appSkillInstalled(BOARD_SKILL))) lines.push("For the team board, type /pmx-board in the Claude app: Claude publishes it as a live artifact that reads Linear through your Linear connector.");
  return lines.join("\n");
}
