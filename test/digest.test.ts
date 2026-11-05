import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { scriptedAsker } from "../src/core/ask.js";
import { RunLogStore } from "../src/core/runlog-store.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { runDigest } from "../src/commands/digest.js";
import { stagingPath } from "../src/digest/digest.js";
import { freshHome, git, pmxRepo, testCtx, tmp, writeTranscript } from "./helpers.js";

const MODEL_OUTPUT = `## Top themes

**SSO setup is slow**
- Admins spend two hours per workspace [T1]
- This line has no citation
- This one cites a source that doesn't exist [T7]

## Notable quotes

- "A SCIM sync would do it." [T1]

## Suggested follow-ups

- Size a SCIM spec [T1]
`;

describe("pmx digest (DIG-1, DIG-2, PRIV-3)", () => {
  beforeEach(freshHome);

  async function setup(remote: boolean) {
    const { repo, origin } = await pmxRepo({ internalDomains: ["us.com"] }, { remote });
    const dir = await tmp("transcripts-");
    await writeTranscript(dir, "acme.md", "---\ntitle: Acme onboarding\nparticipants: jane@acme.com, kp@us.com\n---\nJane: Admins spend two hours on SSO. Mail me at jane@acme.com.\n\nJane: A SCIM sync would do it.\n\nKP: Unrelated, my bonus is late.");
    await writeTranscript(dir, "one-on-one.md", "---\ntitle: Ana / Raj 1:1\nparticipants: ana@us.com, raj@us.com\n---\nRaj: about my performance review");
    const runtime = mockRuntime(() => MODEL_OUTPUT);
    const ctx = await testCtx({ repo, runtime, team: { internalDomains: ["us.com"] }, personal: { sources: { transcriptDirs: [dir], slackChannel: null } } });
    return { ctx, repo, origin, runtime };
  }

  it("redacts, holds personal content, gives the model no tools, and drops uncited claims", async () => {
    const { ctx, runtime } = await setup(false);
    const res = await runDigest(ctx, scriptedAsker({ approve: "reject" }), {});
    expect(res).toMatch(/Rejected/);

    const call = runtime.calls[0]!;
    expect(call.tools).toEqual([]);
    expect(call.prompt).toMatch(/<source_data_[0-9a-f]{12}>/);
    expect(call.prompt).toContain("[EMAIL]");
    expect(call.prompt).not.toContain("jane@acme.com");
    expect(call.prompt).not.toMatch(/bonus|performance review|Raj/);

    const shown = ctx.out.lines.join("\n");
    expect(shown).toContain("Admins spend two hours per workspace [T1]");
    expect(shown).not.toContain("no citation");
    expect(shown).not.toContain("[T7]");
    expect(shown).toMatch(/2 uncited claims removed/);
    expect(shown).toMatch(/Found 2 conversations · used 1 · left out 1 · cut 1 passage · masked 1 email address/);
  });

  it("rejecting deletes the staged draft and nothing reaches git", async () => {
    const { ctx, repo } = await setup(false);
    const before = await git(repo, "rev-list", "--all", "--count");
    await runDigest(ctx, scriptedAsker({ approve: "reject" }), {});
    await expect(stat(stagingPath("2026-W45"))).rejects.toThrow();
    const branches = await git(repo, "branch", "--list", "pmx/digest/*");
    expect(branches).toBe("");
    // Only the run log branch moved.
    const log = await git(repo, "log", "--all", "--format=%s");
    expect(log).not.toMatch(/Digest/);
    expect(Number(await git(repo, "rev-list", "--all", "--count"))).toBeGreaterThan(Number(before));
  });

  it("staging keeps the draft outside git until approval", async () => {
    const { ctx, repo } = await setup(false);
    const res = await runDigest(ctx, scriptedAsker({}), { stage: true });
    expect(res).toMatch(/Staged at/);
    const staged = await readFile(stagingPath("2026-W45"), "utf8");
    expect(staged).toContain("# Signal digest · 2026-W45");
    expect(await git(repo, "status", "--porcelain")).toBe("");
  });

  it("approving commits on a branch, pushes a run log, and the chain verifies", async () => {
    const { ctx, repo, origin } = await setup(true);
    // Local "PR": no GitHub remote, so the output host is local branches pushed to origin.
    const res = await runDigest(ctx, scriptedAsker({ approve: "approve" }), {});
    expect(res).toMatch(/Approved\. Committed on pmx\/digest\/ana\/2026-W45/);
    const file = await git(repo, "show", "pmx/digest/ana/2026-W45:digests/ana/2026-W45.md");
    expect(file).toContain("## Sources");
    expect(file).toContain("**[T1]** Acme onboarding");
    expect(file).not.toContain("jane@acme.com");
    expect(await git(origin!, "branch", "--list", "pmx/runlog")).toContain("pmx/runlog");
    const v = await new RunLogStore(ctx).verify();
    expect(v).toMatchObject({ ok: true, entries: 2 });
  });
});
