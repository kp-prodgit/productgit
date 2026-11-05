import { join } from "node:path";
import type { Ctx } from "../core/context.js";
import { writeFileIn } from "../core/git.js";
import { outputHost } from "../core/host.js";
import { paths } from "../core/paths.js";
import { sendSlackDm } from "../sources/slack.js";

/** Commits an approved digest (PRIV-3: only after the PM approved it) on a branch and opens a PR. */
export async function publishDigest(ctx: Ctx, week: string, markdown: string): Promise<{ url: string }> {
  const branch = `pmx/digest/${ctx.personal.handle}/${week}`;
  const base = await ctx.repo.defaultBranch();
  const remote = await ctx.repo.hasRemote();
  if (remote) await ctx.repo.ok(["fetch", "--quiet", "origin", base]);
  const dir = join(paths.worktrees(), `digest-${ctx.personal.handle}-${week}`);
  const wt = await ctx.repo.worktree(dir, branch, remote ? `origin/${base}` : base);
  try {
    await writeFileIn(wt.cwd, `digests/${ctx.personal.handle}/${week}.md`, markdown);
    await wt.commitAll(`Digest ${week} for ${ctx.personal.handle}`);
    const host = await outputHost(wt, ctx.keychain, ctx.exec, ctx.fetch);
    const pr = await host.openPr({
      branch,
      base,
      title: `Digest ${week} (${ctx.personal.handle})`,
      body: `Weekly signal digest, approved by ${ctx.personal.handle} before commit.\n\n_Opened by Product Git._`,
      labels: ["pmx", "pmx-digest"],
    });
    return { url: pr.url };
  } finally {
    await ctx.repo.removeWorktree(dir);
  }
}

export async function dmDigest(ctx: Ctx, markdown: string): Promise<boolean> {
  const userId = ctx.personal.digest.slackDmUserId;
  if (!userId) return false;
  const token = await ctx.keychain.get("slack-token");
  if (!token) return false;
  await sendSlackDm({ token, userId, text: markdown.slice(0, 39000), fetch: ctx.fetch });
  return true;
}
