import { analyticsOn, ANALYTICS_DISCLOSURE, cloudTarget, connect, pendingEvents, shareOrg } from "../cloud/account.js";
import { Cloud, DEFAULT_CONTROL_PLANE } from "../cloud/client.js";
import { login } from "../cloud/login.js";
import { savePersonalConfig } from "../core/config.js";
import { exec } from "../core/exec.js";
import { macKeychain } from "../core/keychain.js";
import { machineId } from "./init.js";
import type { Command } from "./index.js";

const APP = "https://app.productgit.com";

async function openUrl(url: string) {
  await exec("open", [url]);
  console.log(`If your browser didn't open, go to:\n${url}`);
}

/** ee/ adds the license refresh here; the free sign-in needs nothing more. */
export let afterLogin: ((ctx: import("../core/context.js").Ctx) => Promise<void>) | undefined;
export function setAfterLogin(f: typeof afterLogin): void {
  afterLogin = f;
}

export const cloudCommands: Command[] = [
  {
    name: "login",
    summary: "Sign in to the free hosted app: team board in the browser, analytics on the Team plan",
    options: {},
    async run(a) {
      const ctx = await a.ctx();
      await login({ keychain: macKeychain(), label: machineId(), open: openUrl });
      const cloud = new Cloud(cloudTarget(ctx.team, ctx.personal)?.url ?? DEFAULT_CONTROL_PLANE, ctx.keychain, ctx.fetch);
      const r = await connect({ cloud, team: ctx.team, personal: ctx.personal, ask: a.ask, now: ctx.now() });
      console.log(`Signed in. ${r.created ? "Created a free org" : "Using org"} ${r.target.orgId} (${r.plan} plan).`);
      if (await shareOrg(ctx.personal.repoPath, ctx.team, r.target, a.ask))
        console.log("Wrote controlPlane to pmx.config.json. Commit it in a PR so teammates join this org.");
      console.log(analyticsOn(ctx.personal) ? "Analytics: on. `pmx analytics off` stops them." : "Analytics: off. `pmx analytics on` starts them.");
      await afterLogin?.(ctx);
      console.log("Open the team board with `pmx canvas`.");
      return 0;
    },
  },
  {
    name: "analytics",
    summary: "Show, start or stop the content-free events this machine sends to your hosted org",
    usage: "pmx analytics [on | off] [--show]",
    options: { show: { type: "boolean" } },
    async run(a) {
      const ctx = await a.ctx();
      const arg = a.positionals[0];
      if (arg === "on" || arg === "off") {
        ctx.personal.analytics = { enabled: arg === "on", decidedAt: ctx.now().toISOString() };
        await savePersonalConfig(ctx.personal);
        console.log(arg === "on" ? "Analytics on. Events go out on the next background pass." : "Analytics off. Nothing more is sent.");
        return 0;
      }
      if (arg) throw new Error(`Unknown option "${arg}". Use on, off or --show.`);
      const target = cloudTarget(ctx.team, ctx.personal);
      const p = await pendingEvents(ctx);
      if (a.values.show) {
        console.log(JSON.stringify(p.events, null, 2));
        return 0;
      }
      console.log(ANALYTICS_DISCLOSURE, "\n");
      console.log(`Status: ${analyticsOn(ctx.personal) ? "on" : ctx.personal.analytics ? "off" : "off (not signed in yet)"}`);
      console.log(`Org: ${target ? target.orgId : "none: run `pmx login`"}`);
      console.log(`Waiting to send: ${p.events.length} event(s). See them with \`pmx analytics --show\`.`);
      return 0;
    },
  },
  {
    name: "canvas",
    summary: "Open the team board in the browser: pool → ready → in flight → review → done (free)",
    options: {},
    async run(a) {
      const ctx = await a.ctx();
      const target = cloudTarget(ctx.team, ctx.personal);
      if (!target) {
        console.log("The board lives in the free hosted app. Run `pmx login` first.");
        return 1;
      }
      const url = `${APP}/?org=${encodeURIComponent(target.orgId)}`;
      await openUrl(url);
      return 0;
    },
  },
];
