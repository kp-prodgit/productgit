import type { Ctx } from "../core/context.js";
import { listReceipts, readReceipt, type RunReceipt } from "../core/receipt.js";
import { RunLogStore } from "../core/runlog-store.js";
import { verify } from "../core/runlog.js";
import { loadState } from "../core/state.js";
import { resolveLive, type LiveSource } from "../explain/resolve.js";
import { overlay, readOutbox, readResolved, readSnapshot } from "../tracker/relay.js";
import { buildFlowGraph, type FlowGraph, type FlowLevel } from "./graph.js";

/** Reads everything the flow view needs from this Mac and the PMX repo, then builds the graph (FLOW-1). */
export async function loadFlowGraph(ctx: Pick<Ctx, "team" | "personal" | "repo" | "exec" | "agent" | "now">, o: { level: FlowLevel; hours?: number }): Promise<FlowGraph> {
  const hours = o.hours ?? 24;
  const now = ctx.now();
  const receipts: RunReceipt[] = [];
  if (o.level !== "team") for (const id of await listReceipts()) {
    const r = await readReceipt(id);
    if (r) receipts.push(r);
  }
  const store = new RunLogStore(ctx);
  const runlog = (await store.exists().catch(() => false)) ? await store.entries().catch(() => null) : null;
  const snap = await readSnapshot();
  const outbox = await readOutbox();
  const issues = snap ? overlay(snap, outbox.ops) : null;
  const state = await loadState();
  const live: Record<string, LiveSource[]> = {};
  if (o.level === "local") {
    const since = new Date(now.getTime() - hours * 3600000).toISOString();
    for (const r of receipts) if (r.at >= since && r.sources.some((s) => s.decision === "left-out")) live[r.id] = await resolveLive(r, ctx.personal.sources.transcriptDirs);
  }
  return buildFlowGraph({
    level: o.level, now, hours, agent: ctx.agent, receipts, runlog, chain: runlog ? verify(runlog) : null,
    issues: o.level === "team" ? null : issues, linearSyncedAt: snap?.syncedAt ?? null,
    outbox: outbox.ops.map((op) => ({ kind: op.kind, text: JSON.stringify(op) })), resolved: await readResolved(),
    state, caps: { personalUsd: ctx.personal.budget.dailyUsd, teamUsd: ctx.team.caps.perDayUsd, resetHour: ctx.personal.budget.resetHour },
    live: o.level === "local" ? live : undefined,
  });
}
