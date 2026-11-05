import { formatTasks, tasksJson } from "../claude/tasks.js";
import { boardJson, checkBoard, formatBoard, renderBoard, setBoardUrl, boardUrl } from "../claude/board.js";
import { appSkillInstalled, appSkillTarget, BOARD_SKILL, installAppSkill } from "../claude/skill.js";
import { exec } from "../core/exec.js";
import { macKeychain } from "../core/keychain.js";
import { linearLogin, linearLogout, readGrant } from "../linear/oauth.js";
import { checkRelay, readOutbox, readSnapshot, relayPrompt } from "../tracker/relay.js";
import type { Command } from "./index.js";

async function openUrl(url: string) {
  await exec("open", [url]);
  console.log(`If your browser didn't open, go to:\n${url}`);
}

/** How this machine reaches Linear, in order: API key, Linear sign-in, hosted broker, Claude relay (LINEAR-1, LINEAR-2). */
export async function linearMode(ctx: import("../core/context.js").Ctx): Promise<string> {
  if (ctx.team.tracker.kind !== "linear") return "no Linear project in pmx.config.json";
  if (await ctx.keychain.get("linear-token")) return "Linear API key in the keychain";
  const g = await readGrant(ctx.keychain);
  if (g) return `signed in to Linear${g.user ? ` as ${g.user}` : ""} (renews itself; access valid to ${g.expiresAt.slice(0, 16).replace("T", " ")})`;
  if (ctx.team.controlPlane) return "through the hosted app's Linear connection";
  const snap = await readSnapshot();
  const pending = (await readOutbox()).ops.length;
  return `through Claude (no key or sign-in): ${snap ? `last synced ${snap.syncedAt}` : "not synced yet"}, ${pending} change(s) waiting for the next sync`;
}

export const linearCommands: Command[] = [
  {
    name: "linear",
    summary: "Connect PMX to Linear: login (browser sign-in, no API key), logout, status; without either, Claude relays through its Linear connector",
    usage: "pmx linear login | pmx linear logout | pmx linear status | pmx linear relay --prompt | pmx linear relay --check",
    options: { prompt: { type: "boolean" }, check: { type: "boolean" } },
    async run(a) {
      const sub = a.positionals[0] ?? "status";
      if (sub === "login") {
        const g = await linearLogin({ keychain: macKeychain(), open: openUrl });
        console.log(`Signed in to Linear${g.user ? ` as ${g.user}` : ""}. PMX now talks to Linear directly; access renews itself.`);
        return 0;
      }
      if (sub === "logout") {
        console.log((await linearLogout(macKeychain())) ? "Signed out of Linear and revoked PMX's access." : "Not signed in to Linear.");
        return 0;
      }
      const ctx = await a.ctx();
      if (sub === "relay") {
        if (a.values.check) {
          console.log((await checkRelay(ctx.team, ctx.now())).join("\n"));
          return 0;
        }
        if (a.values.prompt) {
          console.log(await relayPrompt(ctx.team));
          return 0;
        }
        console.log("The Claude relay runs from a scheduled task in your Claude app. See which tasks this machine needs with `pmx schedule`.");
        return 0;
      }
      if (sub === "status") {
        console.log(`Linear: ${await linearMode(ctx)}`);
        return 0;
      }
      throw new Error(`Unknown subcommand "${sub}". Use login, logout, status or relay.`);
    },
  },
  {
    name: "schedule",
    summary: "The scheduled tasks PMX needs in your Claude app and whether each exists; type /pmx-schedule in the Claude app to create them",
    usage: "pmx schedule [--json] | pmx schedule --install-skill",
    options: { json: { type: "boolean" }, "install-skill": { type: "boolean" } },
    async run(a) {
      if (a.values["install-skill"]) {
        const r = await installAppSkill();
        console.log(r === "kept-yours"
          ? `${appSkillTarget()} exists and wasn't written by PMX, so it was left alone.`
          : `${r === "current" ? "Already up to date" : r === "updated" ? "Updated" : "Installed"}: type /pmx-schedule in the Claude app to create PMX's scheduled tasks.`);
        return r === "kept-yours" ? 1 : 0;
      }
      const ctx = await a.ctx().catch(() => null);
      console.log(a.values.json ? JSON.stringify(await tasksJson(ctx?.team ?? null, macKeychain()), null, 2) : await formatTasks(ctx?.team ?? null, macKeychain()));
      return 0;
    },
  },
  {
    name: "board",
    summary: "The team board as a live Claude artifact, read through each viewer's Linear connector; type /pmx-board in the Claude app to publish it",
    usage: "pmx board [--open] | pmx board --json | pmx board --html | pmx board --set-url <link> | pmx board --install-skill",
    options: { json: { type: "boolean" }, html: { type: "boolean" }, open: { type: "boolean" }, "set-url": { type: "string" }, "install-skill": { type: "boolean" } },
    async run(a) {
      if (a.values["install-skill"]) {
        const r = await installAppSkill(BOARD_SKILL);
        console.log(r === "kept-yours"
          ? `${appSkillTarget(BOARD_SKILL)} exists and wasn't written by PMX, so it was left alone.`
          : `${r === "current" ? "Already up to date" : r === "updated" ? "Updated" : "Installed"}: type /pmx-board in the Claude app to publish the team board.`);
        return r === "kept-yours" ? 1 : 0;
      }
      const ctx = await a.ctx();
      if (a.values.json) {
        console.log(JSON.stringify(await boardJson(ctx.team, ctx.personal), null, 2));
        return 0;
      }
      if (a.values["set-url"]) {
        await setBoardUrl(ctx.personal, String(a.values["set-url"]), ctx.now());
        console.log(`Saved. \`pmx board --open\` and \`pmx canvas\` now open ${ctx.personal.board!.url}.`);
        return 0;
      }
      const e = await checkBoard(ctx.team);
      if (a.values.html) {
        if (!e.ok) throw new Error(e.reason);
        console.log(await renderBoard(ctx.team));
        return 0;
      }
      const existing = boardUrl(ctx.team, ctx.personal);
      if (a.values.open && existing) {
        await openUrl(existing.url);
        return 0;
      }
      console.log(formatBoard(ctx.team, ctx.personal, e, await appSkillInstalled(BOARD_SKILL)));
      return 0;
    },
  },
];
