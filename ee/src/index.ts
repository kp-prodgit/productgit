// Product Git Commercial License. See ee/LICENSE.
import type { Command } from "../../src/commands/index.js";
import { setHooks, tickSteps } from "../../src/commands/index.js";
import { setUnpauseHandler } from "../../src/commands/review.js";
import { loadPersonalConfig, loadTeamConfig, type TeamConfig } from "../../src/core/config.js";
import type { Ctx } from "../../src/core/context.js";
import { exec } from "../../src/core/exec.js";
import { macKeychain, type Keychain } from "../../src/core/keychain.js";
import { registerServices, registerTeamTransform } from "../../src/core/services.js";
import { linearTracker } from "../../src/tracker/linear.js";
import { autoPaused, unpause } from "./autopause.js";
import { Cloud, DEFAULT_CONTROL_PLANE } from "../../src/cloud/client.js";
import { setAfterLogin } from "../../src/commands/cloud.js";
import { cloudLease } from "./cloud-lease.js";
import { currentLicense, refreshLicense } from "./license.js";
import { login } from "../../src/cloud/login.js";
import { applyPolicy, BRAIN_OFF, getPolicy, type BrainPolicy, type Policy } from "./policy.js";
import { brainPass, formatBrain, listBrainReceipts, queueSize, readBrainReceipt, reviewQueue } from "./brain/brain.js";
import { services } from "../../src/core/services.js";
import { loadState } from "../../src/core/state.js";
import { machineId } from "../../src/commands/init.js";

const cloudFor = (team: TeamConfig, keychain: Keychain, f: typeof fetch = fetch) =>
  team.controlPlane ? new Cloud(team.controlPlane.url || DEFAULT_CONTROL_PLANE, keychain, f) : null;

/** Short-lived Linear token from the OAuth broker (ADMIN-3), kept in memory only. */
async function brokeredTracker(ctx: Ctx) {
  const cloud = cloudFor(ctx.team, ctx.keychain, ctx.fetch);
  if (!cloud || ctx.team.tracker.kind !== "linear") return null;
  if (await ctx.keychain.get("linear-token")) return null; // A personal key still works if the team hasn't moved to the broker.
  const { accessToken } = await cloud.call<{ accessToken: string }>("POST", `/orgs/${ctx.team.controlPlane!.orgId}/linear/token`);
  return linearTracker({ token: accessToken, teamKey: ctx.team.tracker.teamKey, projectId: ctx.team.tracker.projectId, fetch: ctx.fetch });
}

async function cloudLeaseFor(ctx: Ctx) {
  const cloud = cloudFor(ctx.team, ctx.keychain, ctx.fetch);
  if (ctx.team.lease !== "cloud") return null;
  if (!cloud) throw new Error('pmx.config.json sets "lease": "cloud" but has no controlPlane.');
  await refreshLicense(cloud, ctx.team.controlPlane!.orgId, ctx.now());
  return cloudLease(cloud, ctx.team.controlPlane!.orgId);
}

/** The brain's permission for this org, or why it can't run here (BRAIN-1). */
async function brainAccess(ctx: Ctx): Promise<{ policy: Policy; brain: BrainPolicy } | string> {
  const cp = ctx.team.controlPlane;
  if (!cp) return "The brain is part of the Team plan. Run `pmx login`, add the org to pmx.config.json, then upgrade in the hosted app.";
  const lic = await currentLicense(ctx.now(), cp.orgId);
  if (!lic.claims?.features.includes("brain"))
    return `The brain needs a Team plan license (${lic.claims ? `this one includes: ${lic.claims.features.join(", ")}` : lic.problem}). After upgrading, run \`pmx license --refresh\`.`;
  const policy = await getPolicy(cloudFor(ctx.team, ctx.keychain, ctx.fetch)!, cp.orgId, ctx.now());
  return { policy, brain: policy.brain ?? BRAIN_OFF };
}

const isBrainMachine = (ctx: Ctx, b: BrainPolicy) => {
  const m = b.machine ?? ctx.team.synthesizer;
  return m === ctx.agent || m === ctx.personal.handle;
};

/** Team features (source-visible, commercial). Registered once at CLI start-up. */
export function registerEe(): Command[] {
  registerServices({ paused: autoPaused, tracker: brokeredTracker, lease: cloudLeaseFor });
  setUnpauseHandler(unpause);

  registerTeamTransform(async (team, personal) => {
    const cloud = cloudFor(team, macKeychain());
    if (!cloud) return { team, blockRuns: null };
    return applyPolicy(team, personal, await getPolicy(cloud, team.controlPlane!.orgId, new Date()));
  });

  // The brain runs before pull, so tasks it makes ready can be pulled in the same pass.
  tickSteps.splice(Math.max(0, tickSteps.findIndex(([n]) => n === "pull")), 0, [
    "brain",
    async (ctx) => {
      const access = await brainAccess(ctx).catch(() => null);
      if (!access || typeof access === "string" || access.brain.level === "off" || !isBrainMachine(ctx, access.brain)) return null;
      const s = await loadState();
      if (s.lastBrainAt && ctx.now().getTime() - Date.parse(s.lastBrainAt) < access.brain.everyHours * 3600000) return null;
      const r = await brainPass(ctx, await services(ctx), { policy: access.brain, policyVersion: access.policy.version });
      const n = (m: string) => r.decisions.filter((d) => d.mode === m && !d.error).length;
      return `brain (${r.level}): ${n("executed")} done, ${n("queued")} waiting for approval, ${n("recommended")} suggested`;
    },
  ]);

  setAfterLogin(async (ctx) => {
    if (!ctx.team.controlPlane) return;
    const lic = await refreshLicense(cloudFor(ctx.team, ctx.keychain)!, ctx.team.controlPlane.orgId, new Date()).catch(() => null);
    if (lic) console.log(`License: ${lic.plan}, ${lic.seats} seats.`);
  });

  setHooks({
    invite: async (invite) => {
      await login({ keychain: macKeychain(), label: machineId(), inviteCode: invite.inviteCode, open: openUrl });
      console.log("Joined the team and signed in to Product Git.");
    },
    doctor: async () => {
      const p = await loadPersonalConfig().catch(() => null);
      const team = p ? await loadTeamConfig(p.repoPath).catch(() => null) : null;
      if (!team?.controlPlane) return [];
      const kc = macKeychain();
      const signedIn = !!(await kc.get("machine-token"));
      const lic = await currentLicense(new Date(), team.controlPlane.orgId);
      return [
        { id: "ee.signed-in", ok: signedIn, detail: signedIn ? "signed in to the Product Git control plane" : "not signed in: run `pmx login`", level: "fail" as const },
        { id: "ee.license", ok: !!lic.claims, detail: lic.claims ? `${lic.claims.plan} license, ${lic.claims.seats} seats, valid to ${new Date(lic.claims.exp * 1000).toISOString().slice(0, 10)}` : `license: ${lic.problem}`, level: team.lease === "cloud" ? ("fail" as const) : ("warn" as const) },
      ];
    },
    status: async (ctx) => {
      if (!ctx.team.controlPlane) return [];
      const lic = await currentLicense(ctx.now(), ctx.team.controlPlane.orgId);
      return [`Control plane: ${ctx.team.controlPlane.url} (org ${ctx.team.controlPlane.orgId}) · license ${lic.claims ? `${lic.claims.plan}, ${lic.claims.seats} seats` : lic.problem}`];
    },
  });

  return eeCommands;
}

async function openUrl(url: string) {
  await exec("open", [url]);
  console.log(`If your browser didn't open, go to:\n${url}`);
}

const eeCommands: Command[] = [
  {
    name: "brain",
    summary: "Team plan: assess the board and suggest, queue or (on autopilot) take the next actions, each with its reason",
    usage: "pmx brain [--dry-run] | pmx brain --review | pmx brain --why [<id>] | pmx brain --status",
    options: { "dry-run": { type: "boolean" }, review: { type: "boolean" }, why: { type: "boolean" }, status: { type: "boolean" } },
    async run(a) {
      const ctx = await a.ctx();
      if (a.values.why) {
        const id = a.positionals[0] ?? (await listBrainReceipts())[0];
        const r = id ? await readBrainReceipt(id) : null;
        console.log(r ? formatBrain(r) : "No brain passes on this machine yet. Run `pmx brain --dry-run`.");
        return r ? 0 : 1;
      }
      const access = await brainAccess(ctx);
      if (typeof access === "string") {
        console.log(access);
        return 1;
      }
      const b = access.brain;
      if (a.values.status) {
        const last = (await listBrainReceipts())[0];
        console.log([
          `Level: ${b.level} (admin policy v${access.policy.version})`,
          `Runs on: ${b.machine ?? ctx.team.synthesizer ?? "no machine set"}${isBrainMachine(ctx, b) ? " (this machine)" : ""}, every ${b.everyHours} h`,
          `Autopilot limits: ${b.autopilot.actions.join(", ") || "no actions"} · up to size ${b.autopilot.maxSize} · ${b.autopilot.categories.join(", ") || "every allowed category"} · ${b.autopilot.maxRunsPerDay} run(s) a day`,
          `Waiting for approval here: ${await queueSize(ctx.now())}`,
          `Last pass: ${last ?? "none"}${last ? " (see `pmx brain --why`)" : ""}`,
        ].join("\n"));
        return 0;
      }
      const svc = await services(ctx);
      if (a.values.review) {
        console.log((await reviewQueue(ctx, svc, a.ask)).join("\n"));
        return 0;
      }
      if (b.level === "off" && !a.values["dry-run"]) {
        console.log("The brain is off in your admin policy. An admin can turn it on in the hosted app (Admin → Brain). Try `pmx brain --dry-run` to see what it would suggest.");
        return 1;
      }
      // A dry run with the brain off shows what "recommend" would say, and changes nothing.
      const policy = b.level === "off" ? { ...b, level: "recommend" as const } : b;
      const r = await brainPass(ctx, svc, { policy, policyVersion: access.policy.version, dryRun: a.values["dry-run"] });
      console.log(formatBrain(r));
      return 0;
    },
  },
  {
    name: "policy",
    summary: "Show the admin policy applied to this machine",
    options: {},
    async run(a) {
      const ctx = await a.ctx();
      const cloud = cloudFor(ctx.team, ctx.keychain);
      if (!cloud) {
        console.log("No control plane in pmx.config.json; only team config applies.");
        return 0;
      }
      const p = await getPolicy(cloud, ctx.team.controlPlane!.orgId, new Date());
      console.log(JSON.stringify({ policyVersion: p.version, effective: { categories: Object.keys(ctx.team.categories), sources: ctx.team.allowedSources, egress: ctx.team.egress, model: ctx.team.model, reviewQueueCap: ctx.team.reviewQueueCap } }, null, 2));
      return 0;
    },
  },
  {
    name: "license",
    summary: "Show or refresh this machine's Team license",
    options: { refresh: { type: "boolean" } },
    async run(a) {
      const ctx = await a.ctx();
      if (!ctx.team.controlPlane) throw new Error("No control plane in pmx.config.json.");
      const c = a.values.refresh
        ? await refreshLicense(cloudFor(ctx.team, ctx.keychain)!, ctx.team.controlPlane.orgId, new Date())
        : (await currentLicense(new Date(), ctx.team.controlPlane.orgId)).claims;
      console.log(c ? `${c.plan} · ${c.seats} seats · features ${c.features.join(", ")} · valid to ${new Date(c.exp * 1000).toISOString().slice(0, 10)}` : "No valid license. Run `pmx license --refresh`.");
      return 0;
    },
  },
];
