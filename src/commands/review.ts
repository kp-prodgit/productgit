import { RunLogStore } from "../core/runlog-store.js";
import { services } from "../core/services.js";
import { acceptStats, formatStats } from "../review/queue.js";
import { startReviewServer } from "../review/server.js";
import { terminalReview } from "../review/tui.js";
import { exec } from "../core/exec.js";
import type { Command } from "./index.js";

/** Set by ee/ when team features are registered. */
export let unpauseHandler: ((ctx: any, category: string) => Promise<string>) | null = null;
export function setUnpauseHandler(h: typeof unpauseHandler): void {
  unpauseHandler = h;
}

export const reviewCommand: Command = {
  name: "review",
  summary: "Review drafts: accept, reject or redo with a note (terminal, or --web for a local page)",
  usage: "pmx review [--web] [--all] | pmx review --stats [--days 30] | pmx review --unpause <category>",
  options: { web: { type: "boolean" }, all: { type: "boolean" }, stats: { type: "boolean" }, days: { type: "string" }, unpause: { type: "string" } },
  async run(a) {
    const ctx = await a.ctx();
    if (a.values.stats) {
      const store = new RunLogStore(ctx);
      const entries = (await store.exists()) ? await store.entries() : [];
      console.log(formatStats(acceptStats(entries, ctx.now(), Number(a.values.days ?? ctx.team.autoPause.windowDays))));
      return 0;
    }
    if (a.values.unpause) {
      if (!unpauseHandler) throw new Error("Auto-pause is a team feature (ee/).");
      console.log(await unpauseHandler(ctx, a.values.unpause));
      return 0;
    }
    const svc = await services(ctx);
    if (a.values.web) {
      const s = await startReviewServer(ctx, svc, { all: a.values.all });
      console.log(`Review page: ${s.url}\nPress Ctrl+C to stop.`);
      await exec("open", [s.url]);
      await new Promise<void>((resolve) => process.on("SIGINT", () => s.close().then(resolve)));
      return 0;
    }
    console.log(await terminalReview(ctx, svc, a.ask, { all: a.values.all }));
    return 0;
  },
};
