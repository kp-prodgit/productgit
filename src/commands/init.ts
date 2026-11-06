import { boardUrl, checkBoard, renderBoard } from "../claude/board.js";
import { addAllowRules, ALLOW_RULES, missingAllowRules } from "../claude/permissions.js";
import { appSkillInstalled, appSkillTarget, BOARD_SKILL, claudePresent, installAppSkill } from "../claude/skill.js";
import { linearAccess } from "../linear/access.js";
import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Asker } from "../core/ask.js";
import { loadTeamConfig, savePersonalConfig, type PersonalConfig, type Plan, type TeamConfig } from "../core/config.js";
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

export async function runInit(d: InitDeps): Promise<PersonalConfig> {
  const { ask, out } = d;
  if (process.platform !== "darwin") throw new Error("Product Git v1 runs on macOS only (SCOPE-3).");

  const cc = await d.exec("claude", ["--version"], { timeoutMs: 15000 });
  out.info(cc.code === 0 ? `Found Claude Code ${cc.stdout.trim()}.` : "Claude Code was not found. Install it from https://code.claude.com, then run `pmx doctor`.");

  const existing = await readJson<PersonalConfig>(paths.config());

  // 1. The PMX repo.
  let repoPath = expand(await ask.text("Path to your team's PMX repo checkout", existing?.repoPath ?? join(homedir(), "pmx")));
  const repoExists = await stat(join(repoPath, ".git")).then(() => true, () => false);
  if (!repoExists) {
    const url = d.invite?.team.repo ?? (await ask.text("No git repo there. Git URL to clone (blank to create a new local repo)", ""));
    await mkdir(join(repoPath, ".."), { recursive: true });
    if (url) {
      const r = await d.exec("git", ["clone", url, repoPath]);
      if (r.code !== 0) throw new Error(`git clone failed: ${r.stderr.trim()}`);
    } else {
      await mkdir(repoPath, { recursive: true });
      await d.exec("git", ["init", "-q", "-b", "main", repoPath]);
    }
  }
  const git = new Git(repoPath, d.exec);

  let team: TeamConfig;
  try {
    team = await loadTeamConfig(repoPath);
    out.info(`Using team config for "${team.team}".`);
  } catch {
    if (!(await ask.confirm("This repo has no pmx.config.json. Set it up as a new PMX repo?", true)))
      throw new Error("A PMX repo needs pmx.config.json. Ask your team lead for the repo or an invite file.");
    const teamName = await ask.text("Team name", "product");
    const linearTeamKey = d.invite?.team.linearTeamKey ?? (await ask.text("Linear team key (blank for none yet)", ""));
    const linearProjectId = linearTeamKey ? d.invite?.team.linearProjectId ?? (await ask.text("Linear PMX project ID", "")) : "";
    const created = await scaffoldRepo(repoPath, {
      team: teamName,
      tracker: linearTeamKey && linearProjectId ? { kind: "linear", teamKey: linearTeamKey, projectId: linearProjectId } : { kind: "none" },
    });
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

  // 2. About this PM.
  const handle = (await ask.text("Your handle (short, no spaces, used in branch names)", existing?.handle ?? process.env.USER ?? "pm")).replace(/[^\w-]/g, "");
  const plan = (await ask.choose<Plan>(
    "Model plan for runs",
    ["team", "enterprise", "api", "bedrock", "vertex", "pro", "max"],
    existing?.plan ?? "team",
  )) as Plan;
  const cats = Object.keys(team.categories);
  const categories = split(await ask.text(`Categories your agent accepts (${cats.join(", ")})`, (existing?.categories ?? cats).join(", "))).filter((c) => cats.includes(c));
  const hours = await ask.text("Working hours (HH:MM-HH:MM, Mon–Fri)", existing ? `${existing.workingHours.start}-${existing.workingHours.end}` : "09:00-18:00");
  const [start = "09:00", end = "18:00"] = hours.split("-").map((s) => s.trim());
  const dailyUsd = Number(await ask.text("Daily spend cap for your agent, in USD", String(existing?.budget.dailyUsd ?? Math.min(10, team.caps.perDayUsd))));

  // 3. Sources (default-deny, B2).
  const transcriptDirs = team.allowedSources.includes("transcripts")
    ? split(await ask.text("Folders with call transcripts to include (comma-separated)", (existing?.sources.transcriptDirs ?? [paths.transcripts()]).join(", "))).map(expand)
    : [];
  // ~/.pmx holds transcripts, drafts and receipts: private to this user (PRIV-1). Folders the PM picks keep their own permissions.
  await privateDir(pmxHome());
  for (const dir of transcriptDirs) await (resolve(dir) === resolve(paths.transcripts()) ? privateDir(dir) : mkdir(dir, { recursive: true }));
  let slackChannel: string | null = null;
  if (team.allowedSources.includes("slack") && team.slackChannels.length) {
    const ch = await ask.text(`Slack channel ID for your digest (one of ${team.slackChannels.join(", ")}, blank for none)`, existing?.sources.slackChannel ?? "");
    slackChannel = team.slackChannels.includes(ch) ? ch : null;
  }
  const people = split(await ask.text("Never ingest anything involving these people (names or emails, comma-separated)", existing?.neverIngest.people.join(", ") ?? ""));
  const meetingTitles = split(await ask.text("Never ingest meetings whose titles contain (comma-separated)", existing?.neverIngest.meetingTitles.join(", ") ?? ""));
  const channels = split(await ask.text("Never ingest these channels (comma-separated)", existing?.neverIngest.channels.join(", ") ?? ""));
  const dm = slackChannel ? await ask.text("Your Slack user ID, to DM you the digest (blank to skip)", existing?.digest.slackDmUserId ?? "") : "";

  // 4. Secrets go to the keychain only (SEC-10).
  const secrets: [Parameters<Keychain["set"]>[0], string, boolean][] = [
    ["slack-token", "Slack bot token, read-only scopes plus chat:write for DMs (blank to skip)", !!slackChannel || team.synthesizer === handle],
    ["github-token", "GitHub token for opening PRs in the PMX repo (blank to use `gh`)", !!(await git.remoteUrl())?.includes("github.com")],
  ];
  for (const [name, q, needed] of secrets) {
    if (!needed || (await d.keychain.get(name))) continue;
    const v = await ask.secret(q);
    if (v) await d.keychain.set(name, v);
  }

  const personal: PersonalConfig = {
    version: 1,
    handle,
    machineId: existing?.machineId ?? machineId(),
    repoPath,
    installedAt: existing?.installedAt ?? d.now().toISOString(),
    plan,
    categories,
    workingHours: { days: [1, 2, 3, 4, 5], start, end },
    budget: { dailyUsd: Number.isFinite(dailyUsd) ? dailyUsd : 10, resetHour: existing?.budget.resetHour ?? 0, overrideUsd: null },
    sources: { transcriptDirs, slackChannel },
    neverIngest: { people, channels, meetingTitles },
    crmNamesFile: existing?.crmNamesFile ?? null,
    digest: { weekday: existing?.digest.weekday ?? 5, slackDmUserId: dm || null },
  };
  await privateDir(pmxHome());
  await savePersonalConfig(personal);

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
