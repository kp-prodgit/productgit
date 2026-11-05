import { validateTeamConfig, DEFAULT_TEAM, type TeamConfig } from "../core/config.js";
import type { Git } from "../core/git.js";
import { TEAM_CONFIG_FILE } from "../core/paths.js";
import { envFingerprint } from "../core/profile.js";
import { verifyRecord, type RunRecord } from "./record.js";

export interface PrCheck {
  ok: boolean;
  lines: string[];
}

/**
 * The CI check for PMX repo PRs (B5): every output added under `outputs/` must come with a clean
 * run record. Team config is read from the PR's base, so a PR can't loosen the rules it's judged by.
 * The fingerprint is recomputed from CLAUDE.md and project settings at the run's own base commit.
 */
export async function verifyPr(git: Git, base: string): Promise<PrCheck> {
  const lines: string[] = [];
  const show = async (ref: string, path: string) => {
    const r = await git.raw(["show", `${ref}:${path}`]);
    return r.code === 0 ? r.stdout : null;
  };
  const cfgText = await show(base, TEAM_CONFIG_FILE);
  if (!cfgText) return { ok: false, lines: [`No ${TEAM_CONFIG_FILE} on ${base}.`] };
  const team = validateTeamConfig({ ...DEFAULT_TEAM, team: "team", ...JSON.parse(cfgText) } as TeamConfig);

  const changed = (await git.ok(["diff", "--name-only", "--diff-filter=AM", `${base}...HEAD`])).split("\n").filter(Boolean);
  const outputs = changed.filter((f) => /^outputs\/[^/]+\/[^/]+$/.test(f) && !f.startsWith("outputs/memory-proposals/"));
  if (!outputs.length) return { ok: true, lines: ["No agent outputs in this PR; nothing to check."] };

  let ok = true;
  const ids = new Set(outputs.map((f) => f.split("/").pop()!.replace(/\.[^.]+$/, "")));
  for (const id of ids) {
    const text = await show("HEAD", `.pmx/runs/${id}.json`);
    if (!text) {
      ok = false;
      lines.push(`✘ ${id}: no run record at .pmx/runs/${id}.json`);
      continue;
    }
    let rec: RunRecord;
    try {
      rec = JSON.parse(text);
    } catch {
      ok = false;
      lines.push(`✘ ${id}: run record is not valid JSON`);
      continue;
    }
    const runBase = rec.context?.baseCommit;
    const isAncestor = runBase ? (await git.raw(["merge-base", "--is-ancestor", runBase, "HEAD"])).code === 0 : false;
    const expected = isAncestor ? await envFingerprint((rel) => show(runBase!, rel), team) : "";
    const v = verifyRecord(rec, team, expected);
    if (!isAncestor) v.problems.push("run base commit is not in this branch's history");
    if (v.problems.length) {
      ok = false;
      lines.push(`✘ ${id}: ${v.problems.join("; ")}`);
    } else lines.push(`✔ ${id}: clean run record (${rec.skill.name}@${rec.skill.version}, ${rec.model}, ${rec.agent})`);
  }
  return { ok, lines };
}
