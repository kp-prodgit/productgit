import type { Asker } from "../core/ask.js";
import type { Ctx } from "../core/context.js";
import type { Services } from "../core/services.js";
import { decide, loadQueue, type ReviewItem, type Verdict } from "./queue.js";

function summary(item: ReviewItem): string {
  const r = item.record;
  const lines = [
    `━━ ${item.task.identifier} · ${item.task.title}`,
    `   ${item.task.category} · size ${item.task.size} · ${item.prUrl}`,
  ];
  if (r) {
    lines.push(`   ${r.skill.name}@${r.skill.version} · ${r.model} · ${r.agent} · ${(r.durationMs / 60000).toFixed(1)} min${r.costUsd != null ? ` · $${r.costUsd.toFixed(2)}` : ""}`);
    lines.push(`   clean profile ${r.profile.checksFailed.length ? "✘ " + r.profile.checksFailed.join(", ") : "✔"} · checklist ${r.checklist.ok ? "✔" : "⚠ " + r.checklist.problems.join("; ")}`);
  } else lines.push("   ⚠ no run record");
  return lines.join("\n");
}

/** `pmx review`: the terminal review queue (REV-2). */
export async function terminalReview(ctx: Ctx, svc: Services, ask: Asker, o: { all?: boolean } = {}): Promise<string> {
  const { items, host } = await loadQueue(ctx, svc, o);
  if (!items.length) return "Nothing waiting for review.";
  const done: string[] = [];
  for (const item of items) {
    ctx.out.info("\n" + summary(item));
    for (const f of item.files) ctx.out.info(`\n── ${f.path}\n\n${f.content.trim()}\n`);
    const shownAt = Date.now();
    const choice = await ask.choose("Decision", ["accept", "redo", "reject", "skip", "quit"], "skip");
    if (choice === "quit") break;
    if (choice === "skip") continue;
    const verdict: Verdict = choice === "accept" ? "accepted" : choice === "reject" ? "rejected" : "redo";
    const note = verdict === "accepted" ? undefined : await ask.text(verdict === "redo" ? "What should the agent change?" : "Why reject it?");
    done.push(await decide(ctx, svc, host, item, verdict, { note, reviewMinutes: Math.max(1, Math.round((Date.now() - shownAt) / 60000)) }));
  }
  return done.length ? done.join("\n") : "No decisions made.";
}
