import { readFile } from "node:fs/promises";
import { writeJson } from "../core/fsutil.js";
import type { Ctx } from "../core/context.js";
import { Git } from "../core/git.js";
import { RunLogStore } from "../core/runlog-store.js";
import { services, type Services } from "../core/services.js";
import { loadState } from "../core/state.js";
import { claim, isDryRunDefault, pull, releaseStale } from "../pull/pull.js";
import { compareReports, neutralityRun, type NeutralityReport } from "../run/neutrality.js";
import { runTask } from "../run/run.js";
import { verifyPr } from "../run/verify.js";
import { synthesize } from "../synth/synthesize.js";
import { startOfDay } from "../meetings/ledger.js";
import type { Command } from "./index.js";
import type { TickStep } from "./tick.js";

async function findTask(svc: Services, ref: string) {
  const all = await svc.tracker.list();
  const t = all.find((x) => x.id === ref || x.identifier.toLowerCase() === ref.toLowerCase());
  if (!t) throw new Error(`No task ${ref} in the PMX project.`);
  return t;
}

export const teamCommands: Command[] = [
  {
    name: "synthesize",
    summary: "Turn team sources into sized tasks in the PMX inbox (a human triages them)",
    usage: "pmx synthesize [--since today | YYYY-MM-DD] [--days 1] [--dry-run]",
    options: { days: { type: "string" }, since: { type: "string" }, "dry-run": { type: "boolean" } },
    async run(a) {
      const ctx = await a.ctx();
      const since = sinceDate(a.values.since, ctx.now());
      const days = Math.max(Number(a.values.days ?? 1), Math.ceil((ctx.now().getTime() - since.getTime()) / 86400000) + 1);
      const r = await synthesize(ctx, await services(ctx), { days, since, dryRun: a.values["dry-run"] });
      for (const p of r.posted) console.log(`+ ${p.identifier} ${p.title}`);
      for (const s of r.skipped) console.log(`· skipped ${s}`);
      const m = r.meetings;
      console.log(`Meetings since ${since.toDateString()}: ${m.processed.length} processed now${m.processed.length ? ` (${m.processed.map((x) => x.entry).join(", ")} marked done in the tracker)` : ""}, ${m.already} already processed by the team, ${m.busy} being processed on another machine.`);
      console.log(a.values["dry-run"]
        ? `Dry run: ${r.posted.length} task(s) would be posted; nothing was. ${r.held} item(s) or passage(s) left out or cut.`
        : `${r.posted.length} task(s) posted to inbox; ${r.held} item(s) or passage(s) left out or cut. Triage them in Linear: move to ready to let agents pull.`);
      console.log("See why each was suggested and sized: pmx explain (or pmx explain --web)");
      return 0;
    },
  },
  {
    name: "pull",
    summary: "Claim and run the highest-value ready task that fits (dry run the first week)",
    usage: "pmx pull [--dry-run | --live]",
    options: { "dry-run": { type: "boolean" }, live: { type: "boolean" } },
    async run(a) {
      const ctx = await a.ctx();
      const dryRun = a.values["dry-run"] ?? (a.values.live ? false : isDryRunDefault(ctx));
      if (dryRun && !a.values["dry-run"]) console.log("First week after install: dry run. Use --live to run for real.\n");
      console.log((await pull(ctx, await services(ctx), { dryRun })).text);
      return 0;
    },
  },
  {
    name: "claim",
    summary: "Claim a specific ready task for your agent and run it",
    usage: "pmx claim <task id> [--no-run]",
    options: { "no-run": { type: "boolean" } },
    async run(a) {
      const ctx = await a.ctx();
      const svc = await services(ctx);
      const task = await findTask(svc, a.positionals[0] ?? "");
      if (task.status !== "ready") throw new Error(`${task.identifier} is ${task.status}; only ready tasks can be claimed (TASK-5).`);
      const got = await claim(ctx, svc, task);
      if (!got.ok) throw new Error(`${task.identifier} is held by ${got.holder}.`);
      if (a.values["no-run"]) {
        console.log(`Claimed ${task.identifier} until ${got.lease.expiresAt}.`);
        return 0;
      }
      console.log((await runTask(ctx, svc, task, got.lease)).message);
      return 0;
    },
  },
  {
    name: "release",
    summary: "Give a claim back, or release stale claims (--stale)",
    usage: "pmx release <task id> | pmx release --stale",
    options: { stale: { type: "boolean" } },
    async run(a) {
      const ctx = await a.ctx();
      const svc = await services(ctx);
      if (a.values.stale) {
        const r = await releaseStale(ctx, svc);
        console.log(r.length ? r.join("\n") : "No stale claims.");
        return 0;
      }
      const task = await findTask(svc, a.positionals[0] ?? "");
      if (!(await svc.lease.release(task.id, ctx.agent))) throw new Error(`${task.identifier} is not claimed by you.`);
      if (task.status === "claimed") {
        await svc.tracker.setAgent(task.id, null);
        await svc.tracker.setStatus(task.id, "ready");
      }
      await new RunLogStore(ctx).record({ type: "release", agent: ctx.agent, machine: ctx.personal.machineId, taskId: task.identifier, reason: "manual" });
      console.log(`Released ${task.identifier}.`);
      return 0;
    },
  },
  {
    name: "verify-record",
    summary: "CI check: every output in this PR has a clean run record (B5)",
    usage: "pmx verify-record [--base origin/main] [--repo .]",
    options: { base: { type: "string" }, repo: { type: "string" } },
    async run(a) {
      const r = await verifyPr(new Git(a.values.repo ?? process.cwd()), a.values.base ?? "origin/main");
      console.log(r.lines.join("\n"));
      return r.ok ? 0 : 1;
    },
  },
  {
    name: "neutrality",
    summary: "Run skill fixtures in a clean profile; compare reports from two machines (B6)",
    usage: "pmx neutrality [--out report.json] | pmx neutrality --compare a.json b.json",
    options: { out: { type: "string" }, compare: { type: "boolean" } },
    async run(a) {
      if (a.values.compare) {
        const [x, y] = await Promise.all(a.positionals.slice(0, 2).map(async (p) => JSON.parse(await readFile(p, "utf8")) as NeutralityReport));
        const r = compareReports(x!, y!);
        console.log(r.lines.join("\n"));
        return r.ok ? 0 : 1;
      }
      const report = await neutralityRun(await a.ctx());
      const out = a.values.out ?? `neutrality-${report.agent.replace(/[^\w.-]/g, "_")}.json`;
      await writeJson(out, report, 0o644);
      for (const e of report.entries) console.log(`${e.checklistOk ? "✔" : "✘"} ${e.skill}@${e.skillVersion} ${e.problems.join("; ")}`);
      console.log(`Report written to ${out}. Run the same on a second machine, then: pmx neutrality --compare a.json b.json`);
      return report.entries.every((e) => e.checklistOk) ? 0 : 1;
    },
  },
];

/** Tick steps for team mode: stale releases, synthesis on the designated machine, then one pull. */
export const releaseStep: TickStep = async (ctx) => {
  if (ctx.team.tracker.kind === "none") return null;
  const r = await releaseStale(ctx, await services(ctx));
  return r.length ? r.join("; ") : null;
};

/** `--since today` (default) or a date: the first day whose meetings count as unprocessed (MEET-3). */
function sinceDate(v: string | undefined, now: Date): Date {
  if (!v || v === "today") return startOfDay(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--since takes "today" or a date like 2026-11-05, not "${v}".`);
  return new Date(`${v}T00:00:00`);
}

/**
 * Polls every tick on the synthesizer machine (MEET-3): today's meetings not yet in the team's ledger
 * are processed at once. With nothing new it makes no model call. Slack still runs every 6 hours.
 */
export const synthStep: TickStep = async (ctx: Ctx) => {
  if (ctx.team.synthesizer !== ctx.agent && ctx.team.synthesizer !== ctx.personal.handle) return null;
  if (ctx.team.tracker.kind === "none") return null;
  const s = await loadState();
  const slackDue = !s.lastSynthAt || ctx.now().getTime() - new Date(s.lastSynthAt).getTime() >= 6 * 3600000;
  const r = await synthesize(ctx, await services(ctx), { days: 2, since: startOfDay(ctx.now()), skipIfNothingNew: !slackDue });
  if (!r.meetings.processed.length && !r.posted.length) return null;
  return `${r.meetings.processed.length} meeting(s) processed and marked done, ${r.posted.length} task(s) posted to inbox`;
};

export const pullStep: TickStep = async (ctx) => {
  if (ctx.team.tracker.kind === "none") return null;
  const r = await pull(ctx, await services(ctx), { dryRun: isDryRunDefault(ctx) });
  return r.ran ? r.ran.message : r.dryRun ? `dry run: ${r.selection?.candidates[0]?.identifier ?? "nothing"} would be pulled` : null;
};
