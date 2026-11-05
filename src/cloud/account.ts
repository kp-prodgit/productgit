import { join } from "node:path";
import type { Asker } from "../core/ask.js";
import { savePersonalConfig, type PersonalConfig, type TeamConfig } from "../core/config.js";
import type { Ctx } from "../core/context.js";
import { readJson, writeJson } from "../core/fsutil.js";
import { listReceipts, readReceipt, type RunReceipt } from "../core/receipt.js";
import { RunLogStore } from "../core/runlog-store.js";
import { loadState, updateState } from "../core/state.js";
import { Cloud, DEFAULT_CONTROL_PLANE } from "./client.js";
import { pipelineEvents, postEvents, toEvents } from "./events.js";

export interface CloudTarget {
  url: string;
  orgId: string;
}

/** The hosted org this machine talks to: the team's (pmx.config.json) first, else the PM's own free org. */
export function cloudTarget(team: TeamConfig, personal: PersonalConfig): CloudTarget | null {
  if (team.controlPlane) return { url: team.controlPlane.url || DEFAULT_CONTROL_PLANE, orgId: team.controlPlane.orgId };
  return personal.cloud ?? null;
}

export const analyticsOn = (p: PersonalConfig) => !!p.analytics?.enabled;

/** Shown before analytics start and by `pmx analytics` (PRIV-5). Plain words, matching the event schema. */
export const ANALYTICS_DISCLOSURE = `Product Git analytics send content-free events to your hosted org:
  · each agent run: task ID, category, size, skill version, outcome, duration, tokens, cost
  · each review: task ID, category, size, accepted / rejected / redo, minutes to review
  · each digest or task suggestion: how many sources were found, used and cut, how many tasks, cost
  · your agent handle (an ID such as kp@a1b2c3), never your name or email
Never sent: transcripts, Slack text, drafts, task titles or descriptions, file names, who was in a call.
Your team's analytics page (Team plan) is built only from these events.
See exactly what's pending with \`pmx analytics --show\`. Stop any time with \`pmx analytics off\`.`;

interface Me {
  userId: string;
  orgs: { orgId: string; name: string; role: "admin" | "member"; plan: string }[];
}

/**
 * After `pmx login` (PLAN-1): use the team's org, else the PM's only org, else ask, else create a free
 * one. Then show what analytics send and record the PM's choice (PRIV-5). Nothing is sent before that.
 */
export async function connect(o: { cloud: Cloud; team: TeamConfig; personal: PersonalConfig; ask: Asker; now: Date }): Promise<{ target: CloudTarget; plan: string; created: boolean }> {
  const me = await o.cloud.call<Me>("GET", "/me");
  let target = cloudTarget(o.team, o.personal);
  let created = false;
  if (!target) {
    let orgId: string | undefined;
    if (me.orgs.length === 1) orgId = me.orgs[0]!.orgId;
    else if (me.orgs.length > 1) {
      const list = me.orgs.map((x, i) => `  ${i + 1}. ${x.name} (${x.plan})`).join("\n");
      const pick = Number(await o.ask.text(`You belong to several Product Git orgs:\n${list}\nWhich one is this team's?`, "1"));
      orgId = me.orgs[Math.max(0, Math.min(me.orgs.length - 1, pick - 1))]!.orgId;
    } else {
      orgId = (await o.cloud.call<{ orgId: string }>("POST", "/orgs", { name: o.team.team })).orgId;
      created = true;
    }
    target = { url: o.cloud.url, orgId };
    o.personal.cloud = target;
  }
  const plan = me.orgs.find((x) => x.orgId === target!.orgId)?.plan ?? "free";

  if (!o.personal.analytics) {
    console.log(`\n${ANALYTICS_DISCLOSURE}\n`);
    const enabled = await o.ask.confirm("Send these content-free events?", true);
    o.personal.analytics = { enabled, decidedAt: o.now.toISOString() };
  }
  await savePersonalConfig(o.personal);
  return { target, plan, created };
}

/** Offers to put the org in pmx.config.json, so teammates who sign in join the same one. */
export async function shareOrg(repoPath: string, team: TeamConfig, target: CloudTarget, ask: Asker): Promise<boolean> {
  if (team.controlPlane) return false;
  if (!(await ask.confirm("Add this org to pmx.config.json so teammates join it when they sign in?", true))) return false;
  const file = join(repoPath, "pmx.config.json");
  const raw = (await readJson<Record<string, unknown>>(file)) ?? {};
  await writeJson(file, { ...raw, controlPlane: { url: target.url, orgId: target.orgId } }, 0o644);
  return true;
}

/** Events not sent yet: this machine's run log entries and receipts since the last sync. */
export async function pendingEvents(ctx: Ctx): Promise<{ events: Record<string, unknown>[]; lastTs: string | null; lastAt: string | null }> {
  const s = await loadState();
  const store = new RunLogStore(ctx);
  const mine = (await store.exists()) ? (await store.entries()).filter((e) => e.agent === ctx.agent) : [];
  const receipts: RunReceipt[] = [];
  for (const id of await listReceipts()) {
    const r = await readReceipt(id);
    if (r && r.agent === ctx.agent) receipts.push(r);
  }
  const pipeline = pipelineEvents(receipts, s.lastPipelineSyncAt);
  return {
    events: [...toEvents(mine, s.lastEventSyncAt), ...pipeline],
    lastTs: mine.at(-1)?.ts ?? s.lastEventSyncAt,
    lastAt: (pipeline.at(-1)?.at as string | undefined) ?? s.lastPipelineSyncAt,
  };
}

/** The tick step: sends pending events if this PM signed in and left analytics on (PRIV-5). */
export async function syncAnalytics(ctx: Ctx): Promise<string | null> {
  const target = cloudTarget(ctx.team, ctx.personal);
  if (!target || !analyticsOn(ctx.personal) || !(await ctx.keychain.get("machine-token"))) return null;
  const p = await pendingEvents(ctx);
  if (!p.events.length) return null;
  const sent = await postEvents(new Cloud(target.url, ctx.keychain, ctx.fetch), target.orgId, p.events);
  await updateState((st) => {
    st.lastEventSyncAt = p.lastTs;
    st.lastPipelineSyncAt = p.lastAt;
  });
  return `sent ${sent} content-free event(s)`;
}
