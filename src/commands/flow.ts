import { loadFlowGraph } from "../flow/graph-load.js";
import { trustClaims } from "../flow/graph.js";
import { addNeverIngest, checkNeverIngest, whatIf, type NeverIngestKind } from "../flow/edit.js";
import { exec } from "../core/exec.js";
import { flowJson, renderFlow, setFlowUrl } from "../claude/flow.js";
import { appSkillTarget, FLOW_SKILL, installAppSkill } from "../claude/skill.js";
import { installMcp, mcpInstalled, serveMcp } from "../mcp/server.js";
import { startExplainServer } from "../explain/server.js";
import type { Command } from "./index.js";

const hoursOf = (v: string | undefined) => {
  if (v === undefined) return 24;
  const m = String(v).match(/^(\d+)(h|d)?$/);
  if (!m) throw new Error(`--window takes hours or days, like 24h or 7d (up to 14d), not "${v}".`);
  const h = Number(m[1]) * (m[2] === "d" ? 24 : 1);
  if (h < 1 || h > 336) throw new Error("--window must be between 1h and 14d.");
  return h;
};

export const flowCommands: Command[] = [
  {
    name: "flow",
    summary: "See where data went: meetings read and held, tasks, Linear issues, agent runs, skills and spend (FLOW-1)",
    usage: "pmx flow [--web [--no-open]] [--window 24h|7d] [--team] [--json] | pmx flow --install-skill | --publish-json | --html | --set-url <link>",
    options: {
      web: { type: "boolean" }, "no-open": { type: "boolean" }, "install-skill": { type: "boolean" }, "publish-json": { type: "boolean" }, html: { type: "boolean" }, "set-url": { type: "string" }, window: { type: "string" }, team: { type: "boolean" }, json: { type: "boolean" } },
    async run(a) {
      if (a.values["install-skill"]) {
        const r = await installAppSkill(FLOW_SKILL);
        console.log(r === "kept-yours"
          ? `${appSkillTarget(FLOW_SKILL)} exists and wasn't written by PMX, so it was left alone.`
          : `${r === "current" ? "Already up to date" : r === "updated" ? "Updated" : "Installed"}: type /pmx-flow in the Claude app to publish the flow view.${(await mcpInstalled()) ? "" : " Run `pmx mcp --install` once too, so the page can reach PMX."}`);
        return r === "kept-yours" ? 1 : 0;
      }
      const ctx = await a.ctx();
      if (a.values["publish-json"]) {
        console.log(JSON.stringify(await flowJson(ctx.team, ctx.personal), null, 2));
        return 0;
      }
      if (a.values.html) {
        console.log(await renderFlow(ctx.team, ctx.personal));
        return 0;
      }
      if (a.values["set-url"]) {
        await setFlowUrl(ctx.personal, String(a.values["set-url"]), ctx.now());
        console.log(`Saved. The flow view is ${ctx.personal.flow!.url}`);
        return 0;
      }
      if (a.values.web) {
        const s = await startExplainServer({ team: ctx.team, personal: ctx.personal, flow: (hours, scope) => loadFlowGraph(ctx, { level: scope === "team" ? "team" : "local", hours }) });
        if (!a.values["no-open"]) await exec("open", [s.flowUrl]);
        console.log(`PMX flow: ${s.flowUrl}\nOnly this Mac can open it. Press Ctrl+C to stop.`);
        await new Promise<void>((resolve) => process.on("SIGINT", () => s.close().then(resolve)));
        return 0;
      }
      const g = await loadFlowGraph(ctx, { level: a.values.team ? "team" : a.values.json ? "shared" : "local", hours: hoursOf(a.values.window) });
      if (a.values.json) {
        console.log(JSON.stringify(g, null, 2));
        return 0;
      }
      console.log([`Flow for the last ${g.window.hours}h (${g.level === "team" ? "team run log" : "this Mac"}):`, ...trustClaims(g).map((c) => `  ${c}`), ...g.gaps.map((x) => `  · ${x}`)].join("\n"));
      return g.checks.some((c) => c.status === "violated") ? 1 : 0;
    },
  },
  {
    name: "never-ingest",
    summary: "Your do-not-read list: meeting titles, people and channels PMX never reads. `add` only adds (FLOW-6)",
    usage: "pmx never-ingest | pmx never-ingest add --title <text> | --person <name or email> | --channel <name or ID>",
    options: { title: { type: "string" }, person: { type: "string" }, channel: { type: "string" } },
    async run(a) {
      const ctx = await a.ctx();
      const ni = ctx.personal.neverIngest;
      if (a.positionals[0] !== "add") {
        console.log([`Titles: ${ni.meetingTitles.join(", ") || "(none)"}`, `People: ${ni.people.join(", ") || "(none)"}`, `Channels: ${ni.channels.join(", ") || "(none)"}`,
          "Only you see this list; run records keep only how many entries it has. To remove an entry, edit ~/.pmx/config.json."].join("\n"));
        return 0;
      }
      const given = (["title", "person", "channel"] as NeverIngestKind[]).filter((k) => a.values[k] !== undefined);
      if (given.length !== 1) throw new Error("Give exactly one of --title, --person or --channel.");
      const { kind, value } = checkNeverIngest(given[0]!, a.values[given[0]!]);
      const w = await whatIf(kind, value);
      const r = await addNeverIngest(ctx.personal, kind, value, "cli");
      console.log(r.added ? `Added to your do-not-read list. ${kind === "title" ? `In the last 14 days it would have held ${w.meetings} meeting(s) and ${w.tasks} task(s). ` : ""}${w.note}` : "Already on your do-not-read list.");
      return 0;
    },
  },
  {
    name: "mcp",
    summary: "PMX's read-only server for the /pmx-flow artifact (the Claude app starts it); --install registers it with the Claude desktop app",
    usage: "pmx mcp | pmx mcp --install [--yes]",
    options: { install: { type: "boolean" }, yes: { type: "boolean", short: "y" } },
    async run(a) {
      if (a.values.install) {
        if (!a.values.yes && !(await a.ask.confirm("Register PMX's read-only server with the Claude desktop app, so the /pmx-flow page can read PMX on this Mac? Any Claude chat on this Mac can then read PMX's flow metadata (never held meeting titles).", true))) return 1;
        const r = await installMcp(process.execPath, a.cliPath);
        if (r.error) throw new Error(r.error);
        console.log(r.changed ? "Registered. Restart the Claude app, then open your /pmx-flow page there." : "Already registered.");
        return 0;
      }
      await serveMcp(() => a.ctx());
      return 0;
    },
  },
];
