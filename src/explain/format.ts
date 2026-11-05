import { homedir } from "node:os";
import { HOLD_LABELS } from "../core/filter.js";
import type { RunReceipt } from "../core/receipt.js";
import type { RedactionKind } from "../core/redact.js";
import type { SkillInfo } from "../core/skills.js";
import { FLAG_TEXT } from "../synth/synthesize.js";
import type { LiveSource } from "./resolve.js";

const MASK_NAMES: Record<RedactionKind, [string, string]> = {
  email: ["email address", "email addresses"],
  phone: ["phone number", "phone numbers"],
  card: ["card number", "card numbers"],
  id: ["ID number", "ID numbers"],
  person: ["customer name", "customer names"],
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const tilde = (p: string) => p.replace(homedir(), "~");
const money = (n: number | null) => (n === null ? "cost unknown" : `$${n.toFixed(2)}`);

export function maskedText(m: RunReceipt["masked"]): string {
  const parts = (Object.entries(m) as [RedactionKind, number][]).filter(([, n]) => n).map(([k, n]) => plural(n, ...MASK_NAMES[k]));
  return parts.length ? parts.join(", ") : "nothing";
}

/** The two lines `pmx digest` prints, so the PM sees counts in plain words and where to look. */
export function receiptSummary(r: RunReceipt): string {
  const used = r.sources.filter((s) => s.decision === "used").length;
  const cut = r.sources.reduce((n, s) => n + s.passagesCut.length, 0);
  const parts = [
    `Found ${plural(r.sources.length, "conversation")}`,
    `used ${used}`,
    `left out ${r.sources.length - used}`,
    `cut ${plural(cut, "passage")}`,
    `masked ${maskedText(r.masked)}`,
  ];
  if (r.model) parts.push(money(r.model.costUsd));
  return `${parts.join(" · ")}\nSee how each one was decided: pmx explain (or pmx explain --web)`;
}

/** The full receipt for the terminal: every source, the rule that decided it, what Claude got. */
export function formatReceipt(r: RunReceipt, live: LiveSource[]): string {
  const when = new Date(r.at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const title = r.type === "digest" ? "Digest" : r.dryRun ? "Suggested tasks (dry run)" : "Suggested tasks";
  const out = [`${title} · ${when} · ${r.outcome}`, ""];
  const where = r.rules.folders.length ? r.rules.folders.map(tilde).join(", ") : "your sources";
  out.push(`1. Found ${plural(r.sources.length, "conversation")} in ${where} from the last ${r.window.days} days`);
  for (const s of r.skippedSources) out.push(`   - skipped: ${s}`);
  out.push("", "2. Privacy rules decided what Claude may read");
  r.sources.forEach((s, i) => {
    const l = live[i];
    const name = s.file ?? l?.file ?? (s.kind === "slack" ? "a Slack message" : "a file that's no longer in your folder");
    if (s.decision === "used") out.push(`   ✔ used      [${s.id}] ${name}: ${s.detail}`);
    else out.push(`   ✘ left out  ${name}: ${HOLD_LABELS[s.rule!]}, because ${s.detail}`);
    (l?.cuts ?? s.passagesCut.map((c) => ({ rule: c.rule, line: null, matched: null }))).forEach((c) => {
      const at = c.line ? `line ${c.line}` : "a passage";
      out.push(`               cut ${at}: ${HOLD_LABELS[c.rule]}${c.matched ? ` (matched "${c.matched}")` : ""}`);
    });
  });
  out.push("", `3. Masked before Claude saw it: ${maskedText(r.masked)}`);
  if (r.model) {
    const skills = r.skills.map((k) => `${k.name} (${k.source === "team" ? "team copy" : "built-in copy"}, version ${k.version})`).join(" + ");
    out.push("", `4. Claude wrote the draft: ${r.model.name} using ${skills}`, `   Tools: ${r.model.tools}`, `   ${money(r.model.costUsd)} · ${(r.model.durationMs / 1000).toFixed(1)}s`);
  }
  if (r.digest) {
    out.push("", `5. Citation check: ${plural(r.digest.cited.length, "source")} cited, ${plural(r.digest.removedClaims, "claim")} removed for missing a citation`);
    out.push("", `6. Draft: ${tilde(r.digest.staged)}. Only on your Mac until you approve it with \`pmx digest --review\`.`);
  }
  if (r.synth) {
    out.push("", `5. ${plural(r.synth.tasks.length, "suggested task")}, each sized with the pmx-size rubric:`);
    for (const t of r.synth.tasks) {
      out.push(`   ${t.size.padEnd(2)} ${t.title} (${t.category}, ${plural(t.sources.length, "source")})`);
      if (t.sizing) {
        out.push(`      why: ${t.sizing.cell ?? "no rubric cell given"}${t.sizing.why ? `. ${t.sizing.why}` : ""}`);
        for (const f of t.sizing.flags) out.push(`      check: ${FLAG_TEXT[f]}`);
      }
    }
    for (const s of r.synth.skipped) out.push(`   skipped: ${s}`);
  }
  if (r.error) out.push("", `The run failed: ${r.error}`);
  out.push("", "Left-out text is never stored. File names and lines above were found just now in your own folders.");
  return out.join("\n");
}

export function formatSkills(skills: SkillInfo[]): string {
  const out = [
    "Claude skills PMX can use. Runs load them from your team folder first, then from the copy built into pmx.",
    "They run in Product Git's own Claude profile (~/.pmx/claude), never in your personal Claude Code.",
    '"differs from built-in" means your team edited its copy, or this pmx ships a newer one.',
    "",
  ];
  for (const s of skills) {
    out.push(`${s.name}  ·  ${s.status}  ·  version ${s.version}`);
    out.push(`   ${s.description}`);
    out.push(`   When: ${s.usedBy}`);
    out.push(`   File: ${tilde(s.path)}`, "");
  }
  return out.join("\n").trimEnd();
}
