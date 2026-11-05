import type { ParseArgsConfig } from "node:util";
import type { Asker } from "../core/ask.js";
import { loadPersonalConfig, loadTeamConfig, type PersonalConfig, type TeamConfig } from "../core/config.js";
import { consoleOut, type Ctx } from "../core/context.js";
import { exec } from "../core/exec.js";
import { readJson } from "../core/fsutil.js";
import { effectiveTeam } from "../core/services.js";
import { macKeychain } from "../core/keychain.js";
import { macLaunchd } from "../core/launchd.js";
import { runDigest } from "./digest.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { runInit, type InviteFile } from "./init.js";
import { runStatus } from "./status.js";
import { digestStep, runTick, type TickStep } from "./tick.js";
import { runUninstall } from "./uninstall.js";
import { VENDORED_CLI, vendorCli } from "../core/vendor.js";
import { atLeast, currentVersion, vendoredVersion } from "../core/version.js";
import { installTeamVersion, type UpdateOutcome } from "../core/update.js";
import { Git } from "../core/git.js";
import { loadState } from "../core/state.js";
import { writeJson } from "../core/fsutil.js";
import { TEAM_CONFIG_FILE } from "../core/paths.js";
import { join } from "node:path";
import { listReceipts, readReceipt } from "../core/receipt.js";
import { skillInventory } from "../core/skills.js";
import { formatReceipt, formatSkills } from "../explain/format.js";
import { resolveLive } from "../explain/resolve.js";
import { startExplainServer } from "../explain/server.js";
import { pullStep, releaseStep, synthStep, teamCommands } from "./team.js";
import { reviewCommand } from "./review.js";
import { cloudCommands } from "./cloud.js";
import { companyStep, meetingCommands, todoStep } from "./meetings.js";
import { updateStep } from "./autoupdate.js";
import { syncAnalytics } from "../cloud/account.js";

export interface RunArgs {
  values: Record<string, any>;
  positionals: string[];
  ask: Asker;
  ctx: () => Promise<Ctx>;
  cliPath: string;
}

export interface Command {
  name: string;
  summary: string;
  usage?: string;
  options: NonNullable<ParseArgsConfig["options"]>;
  run(a: RunArgs): Promise<number>;
}

const yes = { yes: { type: "boolean", short: "y" } } as const;

/** Steps `pmx tick` runs, in order. Later milestones add synthesis and pull. */
export const tickSteps: [string, TickStep][] = [
  // First, so the rest of a pass never runs on a version the team has moved past (COMPAT-6).
  ["update", updateStep],
  ["digest", digestStep],
  ["todo", todoStep],
  ["release", releaseStep],
  ["synthesize", synthStep],
  ["company", companyStep],
  ["pull", pullStep],
  ["events", syncAnalytics],
];

export const commands: Command[] = [
  {
    name: "init",
    summary: "Set up this Mac: PMX repo, clean profile, skills, keychain, background job",
    usage: "pmx init [--invite pmx-invite.json] [--yes]",
    options: { ...yes, invite: { type: "string" } },
    async run(a) {
      const invite = a.values.invite ? await readJson<InviteFile>(a.values.invite) : null;
      await runInit({
        ask: a.ask, keychain: macKeychain(), launchd: macLaunchd(), exec, out: consoleOut, now: () => new Date(),
        cliPath: a.cliPath, invite, onInvite: inviteHook,
      });
      const r = formatDoctor(await doctorChecks());
      console.log("\n" + r.text);
      return 0;
    },
  },
  {
    name: "doctor",
    summary: "Green/red checklist, including every clean-profile check",
    options: {},
    async run() {
      const r = formatDoctor(await doctorChecks());
      console.log(r.text);
      return r.ok ? 0 : 1;
    },
  },
  {
    name: "digest",
    summary: "Build this week's digest from your sources and approve it before it's committed",
    usage: "pmx digest [--review] [--stage] [--days 7]",
    options: { review: { type: "boolean" }, stage: { type: "boolean" }, days: { type: "string" } },
    async run(a) {
      const ctx = await a.ctx();
      console.log(await runDigest(ctx, a.ask, { review: a.values.review, stage: a.values.stage, days: a.values.days ? Number(a.values.days) : undefined }));
      return 0;
    },
  },
  {
    name: "status",
    summary: "Show config, kill switch, spend and recent runs",
    options: {},
    async run(a) {
      console.log(await runStatus(await a.ctx(), await statusExtra(await a.ctx())));
      return 0;
    },
  },
  {
    name: "tick",
    summary: "One scheduler pass (run by launchd every 30 minutes)",
    options: {},
    async run(a) {
      const ctx = await a.ctx();
      for (const line of await runTick(ctx, tickSteps)) console.log(`${new Date().toISOString()} ${line}`);
      return 0;
    },
  },
  {
    name: "explain",
    summary: "Show how a run decided: what was read, left out, cut and masked, which skills ran, sizes, cost",
    usage: "pmx explain [<run id>] [--list] [--json] [--web]",
    options: { list: { type: "boolean" }, json: { type: "boolean" }, web: { type: "boolean" } },
    async run(a) {
      const personal = await loadPersonalConfig();
      const team = await loadTeamConfig(personal.repoPath);
      if (a.values.web) {
        const s = await startExplainServer({ team, personal });
        await exec("open", [s.url]);
        console.log(`How PMX decided: ${s.url}\nOnly this Mac can open it. Press Ctrl+C to stop.`);
        await new Promise<void>((resolve) => process.on("SIGINT", () => s.close().then(resolve)));
        return 0;
      }
      const ids = await listReceipts();
      if (a.values.list) {
        console.log(ids.length ? ids.join("\n") : "No runs yet. Run `pmx digest`.");
        return 0;
      }
      const id = a.positionals[0] ?? ids[0];
      const r = id ? await readReceipt(id) : null;
      if (!r) {
        console.log(id ? `No run "${id}". See \`pmx explain --list\`.` : "No runs yet. Run `pmx digest`, then `pmx explain`.");
        return 1;
      }
      const live = await resolveLive(r, personal.sources.transcriptDirs);
      console.log(a.values.json ? JSON.stringify({ receipt: r, live }, null, 2) : formatReceipt(r, live));
      return 0;
    },
  },
  {
    name: "skills",
    summary: "List the Claude skills PMX can use, what each does and when it runs",
    options: { json: { type: "boolean" } },
    async run(a) {
      const personal = await loadPersonalConfig();
      const team = await loadTeamConfig(personal.repoPath);
      const skills = await skillInventory(personal.repoPath, team.categories);
      console.log(a.values.json ? JSON.stringify(skills, null, 2) : formatSkills(skills));
      return 0;
    },
  },
  {
    name: "vendor",
    summary: "Put this CLI's package in the PMX repo, so teammates and CI install the same version; --require makes it the team minimum",
    usage: "pmx vendor [--require [--auto-update | --no-auto-update]] [--repo <PMX repo path>]",
    options: { repo: { type: "string" }, require: { type: "boolean" }, "auto-update": { type: "boolean" }, "no-auto-update": { type: "boolean" } },
    async run(a) {
      const repo = a.values.repo ?? (await loadPersonalConfig()).repoPath;
      const version = await vendorCli(repo, exec);
      if (a.values.require) {
        const file = join(repo, TEAM_CONFIG_FILE);
        const raw = (await readJson<Record<string, unknown>>(file)) ?? {};
        const prev = (raw.cli ?? {}) as { autoUpdate?: boolean };
        const autoUpdate = a.values["auto-update"] ? true : a.values["no-auto-update"] ? false : prev.autoUpdate;
        await writeJson(file, { ...raw, cli: { min: version, ...(autoUpdate !== undefined ? { autoUpdate } : {}) } }, 0o644);
      }
      console.log(`Wrote ${VENDORED_CLI} (productgit ${version}) in ${repo}.${a.values.require ? `\nSet cli.min to ${version} in ${TEAM_CONFIG_FILE}: older machines keep personal work but stop shared team work until they run \`pmx update\`.${a.values["auto-update"] ? " Auto-update is on: each machine's background job installs it within the hour." : ""}` : ""}
Commit ${a.values.require ? "both files" : "it"} in a PR of its own. Teammates update with \`pmx update\`.`);
      return 0;
    },
  },
  {
    name: "update",
    summary: "Install your team's pmx version from the PMX repo (pulls the repo first); --check only compares versions",
    usage: "pmx update [--check] [--force]",
    options: { check: { type: "boolean" }, force: { type: "boolean" } },
    async run(a) {
      const personal = await loadPersonalConfig();
      const repo = personal.repoPath;
      const git = new Git(repo, exec);
      if (await git.hasRemote()) {
        const pulled = await exec("git", ["-C", repo, "pull", "--ff-only", "--quiet"], { timeoutMs: 60000 });
        if (pulled.code !== 0) console.warn(`Couldn't pull the PMX repo (${pulled.stderr.trim() || "git pull failed"}); using what's checked out.`);
      }
      const team = await loadTeamConfig(repo).catch(() => null);
      const tgz = join(repo, VENDORED_CLI);
      const current = currentVersion();
      const vendored = await vendoredVersion(tgz, exec);
      const min = team?.cli?.min ?? null;
      const cloud = (await loadState()).cloudVersions;
      console.log([
        `This machine:  pmx ${current}`,
        `Team package:  ${vendored ? `pmx ${vendored} (${VENDORED_CLI})` : "none in the PMX repo"}`,
        `Team minimum:  ${min ?? "none set"}${min && !atLeast(current, min) ? "  ← this machine is too old for shared work" : ""}`,
        ...(cloud?.latest ? [`Latest release: pmx ${cloud.latest}`] : []),
      ].join("\n"));
      if (a.values.check) return min && !atLeast(current, min) ? 1 : 0;
      const r = await installTeamVersion(repo, exec, { force: a.values.force });
      const say: Record<UpdateOutcome["result"], string> = {
        "no-package": "\nAsk your team lead to run `pmx vendor --require` and commit it.",
        current: "\nUp to date.",
        updated: `\nUpdated to pmx ${vendored}. The background job uses it from its next pass.`,
        "dev-install": "\nThis pmx runs from a source checkout, so it isn't replaced. Pull and rebuild the checkout instead.",
        "needs-sudo": `\nnpm can't write to its global folder. Run:\n  ${r.result === "needs-sudo" ? r.command : ""}\nor install Node with Homebrew or nvm, so updates (and auto-updates) don't need sudo.`,
        failed: `\nnpm install failed: ${r.result === "failed" ? r.error : ""}`,
      };
      console.log(say[r.result]);
      return r.result === "current" || r.result === "updated" ? 0 : 1;
    },
  },
  ...meetingCommands,
  ...teamCommands,
  reviewCommand,
  ...cloudCommands,
  {
    name: "uninstall",
    summary: "Remove the background job, clean profile, keychain items and ~/.pmx",
    options: { ...yes },
    async run(a) {
      await runUninstall({ ask: a.ask, keychain: macKeychain(), launchd: macLaunchd(), exec, out: consoleOut, yes: a.values.yes });
      return 0;
    },
  },
];

/** Hooks later milestones (and ee/) fill in. */
export let inviteHook: ((i: InviteFile) => Promise<void>) | undefined;
export let doctorExtra: (() => Promise<import("./doctor.js").DoctorCheck[]>) | undefined;
export let statusExtra: (ctx: Ctx) => Promise<string[]> = async () => [];

export function setHooks(h: { invite?: typeof inviteHook; doctor?: typeof doctorExtra; status?: typeof statusExtra }): void {
  if (h.invite) inviteHook = h.invite;
  if (h.doctor) doctorExtra = h.doctor;
  if (h.status) statusExtra = h.status;
}

async function doctorChecks() {
  let personal: PersonalConfig | null = null;
  let team: TeamConfig | null = null;
  let teamError: string | undefined;
  try {
    personal = await loadPersonalConfig();
    team = (await effectiveTeam(await loadTeamConfig(personal.repoPath), personal)).team;
  } catch (e: any) {
    teamError = e.message;
  }
  return runDoctor({ personal, team, teamError, keychain: macKeychain(), launchd: macLaunchd(), exec, extra: doctorExtra });
}
