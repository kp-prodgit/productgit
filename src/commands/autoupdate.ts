import { refreshAppSkills } from "../claude/skill.js";
import type { Ctx } from "../core/context.js";
import { notify } from "../core/notify.js";
import { loadState, updateState } from "../core/state.js";
import { installTeamVersion } from "../core/update.js";
import { currentVersion } from "../core/version.js";
import { newVersionNotes } from "../core/whats-new.js";
import type { TickStep } from "./tick.js";

const EVERY_MS = 3600000;

/**
 * The background auto-update (COMPAT-6). When the team turns it on (`cli.autoUpdate`), each tick, at
 * most hourly, pulls the PMX repo and installs its CLI package if it's newer. The running pass finishes
 * on the old version; the next pass uses the new one. If npm needs sudo, PMX can't type a password, so it
 * says so once per version, in a notification and in `pmx doctor`.
 */
export const updateStep: TickStep = async (ctx: Ctx) => {
  // A newer pmx may ship newer Claude commands (/pmx-schedule, /pmx-board); keep the installed copies current.
  const refreshed = await refreshAppSkills().catch(() => []);
  if (!ctx.team.cli?.autoUpdate) return refreshed.length ? `updated Claude commands: ${refreshed.map((n) => `/${n}`).join(", ")}` : null;
  const s = await loadState();
  if (s.autoUpdate && ctx.now().getTime() - Date.parse(s.autoUpdate.checkedAt) < EVERY_MS) return null;
  const r = await installTeamVersion(ctx.personal.repoPath, ctx.exec, { pull: await ctx.repo.hasRemote() });
  const version = "version" in r ? r.version : null;
  const tellOnce = (r.result === "needs-sudo" || r.result === "failed") && s.autoUpdate?.notifiedFor !== version;
  await updateState((st) => {
    st.autoUpdate = { checkedAt: ctx.now().toISOString(), result: r.result, version, notifiedFor: tellOnce ? version : st.autoUpdate?.notifiedFor ?? null };
  });
  if (r.result === "updated") {
    const notes = await newVersionNotes(ctx.exec, currentVersion()).catch(() => null);
    const headline = notes?.split("\n")[0]?.replace(/^What's new in pmx [\d.]+: /, "") ?? null;
    await notify("Product Git updated", `pmx ${r.version} is installed${headline ? `: ${headline}` : ""}. See what's new: pmx whats-new`).catch(() => {});
    return `auto-update: installed pmx ${r.version}`;
  }
  if (tellOnce) {
    const how = r.result === "needs-sudo" ? `Run: ${r.command}` : r.error;
    await notify("Product Git update waiting", `Your team is on pmx ${version}. ${r.result === "needs-sudo" ? "It needs your password: run pmx update in Terminal." : "The install failed: run pmx update."}`).catch(() => {});
    return `auto-update: pmx ${version} is waiting (${how})`;
  }
  return null;
};
