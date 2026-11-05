import { checkCollected, collectPrompt, ensureCollectFolder } from "../collect/collect.js";
import { rollup } from "../company/rollup.js";
import { savePersonalConfig } from "../core/config.js";
import type { Ctx } from "../core/context.js";
import { services } from "../core/services.js";
import { loadState } from "../core/state.js";
import { localDay, startOfDay } from "../meetings/ledger.js";
import { completeTodo, formatTodos, loadTodos, refreshTodos } from "../todo/todo.js";
import type { Command } from "./index.js";
import type { TickStep } from "./tick.js";

function sinceArg(v: string | undefined, now: Date): Date {
  if (!v || v === "today") return startOfDay(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--since takes "today" or a date like 2026-11-05, not "${v}".`);
  return new Date(`${v}T00:00:00`);
}

export const meetingCommands: Command[] = [
  {
    name: "collect",
    summary: "Meeting transcripts from your Claude connectors (Granola, Fireflies…): print the scheduled task's instructions, or check what it saved",
    usage: "pmx collect --prompt [--team] | pmx collect --check",
    options: { prompt: { type: "boolean" }, check: { type: "boolean" }, team: { type: "boolean" } },
    async run(a) {
      const ctx = await a.ctx();
      if (a.values.check) {
        console.log((await checkCollected(ctx)).join("\n"));
        return 0;
      }
      if (a.values.prompt) {
        console.log(await collectPrompt(ctx, { scope: a.values.team ? "team" : "mine" }));
        return 0;
      }
      const added = await ensureCollectFolder(ctx.personal);
      const s = await loadState();
      console.log([
        "PMX doesn't hold connector access. A scheduled task in your Claude app does the collecting, with the connectors you already have:",
        '  "Every weekday at 12:30 and 17:30: run `pmx collect --prompt` and follow its instructions."',
        "Add `--team` on the synthesizer's machine to collect meetings shared with your team, not just yours.",
        "",
        `Transcripts land in ${ctx.personal.sources.transcriptDirs.at(-1)}${added ? " (just added to your transcript folders)" : ""}.`,
        `Last collected: ${s.lastCollectAt ?? "never"}.`,
      ].join("\n"));
      return 0;
    },
  },
  {
    name: "todo",
    summary: "Your own to-dos from your meetings, including 1:1s; stays on this Mac. --refresh reads today's unprocessed meetings",
    usage: "pmx todo [--all] [--json] | pmx todo --refresh [--since today|YYYY-MM-DD] [--dry-run] | pmx todo done <id> | pmx todo --me <name or email>",
    options: {
      refresh: { type: "boolean" }, since: { type: "string" }, "dry-run": { type: "boolean" }, all: { type: "boolean" }, json: { type: "boolean" },
      me: { type: "string", multiple: true },
    },
    async run(a) {
      const ctx = await a.ctx();
      if (a.values.me?.length) {
        const vals: string[] = a.values.me;
        ctx.personal.identity = { names: vals.filter((v) => !v.includes("@")), emails: vals.filter((v) => v.includes("@")).map((v) => v.toLowerCase()) };
        await savePersonalConfig(ctx.personal);
        console.log(`Your to-dos are now found for: ${vals.join(", ")}.`);
        return 0;
      }
      if (a.positionals[0] === "done") {
        const t = await completeTodo(a.positionals[1] ?? "", ctx.now());
        console.log(`✔ ${t.text}`);
        return 0;
      }
      if (a.values.refresh) {
        const since = sinceArg(a.values.since, ctx.now());
        const r = await refreshTodos(ctx, { since, dryRun: a.values["dry-run"] });
        console.log(`Meetings since ${localDay(since)}: ${r.meetings.read} read now, ${r.meetings.alreadyRead} already read for to-dos.`);
        console.log(r.added.length ? `${a.values["dry-run"] ? "Would add" : "Added"} ${r.added.length} to-do(s):\n${formatTodos(r.added)}` : "No new to-dos.");
        if (r.receiptId) console.log(`See how each meeting was read: pmx explain ${r.receiptId}`);
        return 0;
      }
      const store = await loadTodos();
      const items = a.values.all ? store.items : store.items.filter((t) => t.status === "open");
      console.log(a.values.json ? JSON.stringify(items, null, 2) : formatTodos(items));
      return 0;
    },
  },
  {
    name: "company",
    summary: "Roll teams' PMX tasks up into company-level themes in this repo's PMX project; reads tasks, never transcripts",
    usage: "pmx company [--dry-run]",
    options: { "dry-run": { type: "boolean" } },
    async run(a) {
      const ctx = await a.ctx();
      const r = await rollup(ctx, await services(ctx), { dryRun: a.values["dry-run"] });
      for (const t of r.teams) console.log(`${t.error ? "✘" : "·"} ${t.name}: ${t.error ?? `${t.tasks} open task(s)`}`);
      for (const p of r.posted) console.log(`+ ${p.identifier} ${p.title}\n    from ${p.tasks.join(", ")}`);
      for (const s of r.skipped) console.log(`· skipped ${s}`);
      if (!r.posted.length && !r.skipped.length) console.log("No themes span two teams right now.");
      return 0;
    },
  },
];

/** Individual to-dos on every tick: only today's meetings not read yet; no model call otherwise (TODO-3). */
export const todoStep: TickStep = async (ctx: Ctx) => {
  // Only for PMs who collect meetings or have used `pmx todo`, so nobody's folder is read for to-dos unasked.
  const store = await loadTodos();
  if (!(await loadState()).lastCollectAt && !store.items.length && !Object.keys(store.processed).length) return null;
  const r = await refreshTodos(ctx, { skipIfNothingNew: true });
  return r.meetings.read ? `read ${r.meetings.read} meeting(s) for to-dos, ${r.added.length} new to-do(s)` : null;
};

/** The company roll-up, once a day on the company machine (COMPANY-1). */
export const companyStep: TickStep = async (ctx: Ctx) => {
  const c = ctx.team.company;
  if (!c?.teams.length || ctx.team.tracker.kind === "none") return null;
  const machine = c.machine ?? ctx.team.synthesizer;
  if (machine !== ctx.agent && machine !== ctx.personal.handle) return null;
  const s = await loadState();
  if (s.lastRollupAt && ctx.now().getTime() - Date.parse(s.lastRollupAt) < 24 * 3600000) return null;
  const r = await rollup(ctx, await services(ctx));
  return `company roll-up: ${r.posted.length} theme(s) posted`;
};
