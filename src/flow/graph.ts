import { HOLD_LABELS, type HoldReason } from "../core/filter.js";
import type { RunReceipt } from "../core/receipt.js";
import type { RunLogEntry, VerifyResult } from "../core/runlog.js";
import type { State } from "../core/state.js";
import type { LiveSource } from "../explain/resolve.js";
import { kindOf, toMeeting, toTask } from "../tracker/linear.js";

/**
 * The flow view's one model (FLOW-1): every meeting and Slack thread PMX read or held, the runs that read them,
 * the skills they used, the tasks they proposed, the Linear issues those became, the agent runs that worked
 * them, the verdicts and the spend. Built from records PMX already keeps; nothing here is inferred unless an
 * edge says `inferred`.
 *
 * Three levels, by who may see them (FLOW-1, PRIV-4):
 *  - "local": the PM's own screen (`pmx flow --web`). Held items show the file and title found again on this Mac.
 *  - "shared": what the local MCP server gives the Claude artifact. Held items are a rule and a count, with
 *    opaque IDs; no folders, no to-do text, no `detail` strings, no hashes.
 *  - "team": the shared run log only, as every teammate's clone has it. No meetings, no titles.
 */
export type FlowLevel = "local" | "shared" | "team";

export type NodeKind = "source" | "skipped" | "vault" | "run" | "skill" | "task" | "todo" | "issue" | "meeting" | "execution" | "verdict";
export type EdgeKind = "read" | "held" | "skipped" | "cited" | "synthesized" | "registered" | "duplicate-of" | "lodged" | "produced" | "used-skill" | "executed" | "judged";

/** The six columns, left to right: arrivals, the checkpoint, the workshop, tasks, Linear, departures. */
export const STAGES = ["Arrivals", "Checkpoint", "Workshop", "Tasks", "Linear", "Departures"] as const;

export interface FlowNode {
  id: string;
  kind: NodeKind;
  stage: number;
  label: string;
  at?: string | null;
  status?: string | null;
  /** The receipt this node came from, if any; the local page links to `pmx explain`. */
  run?: string;
  url?: string | null;
  costUsd?: number | null;
  durationMs?: number | null;
  meta: Record<string, string | number | boolean | null>;
}

export interface FlowEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  rule?: string;
  /** True when PMX matched by title because an older record has no link. Drawn dashed. */
  inferred?: boolean;
}

export interface FlowCheck {
  id: "held-never-in-linear" | "canaries" | "runlog-chain" | "outbox-clean" | "links";
  status: "ok" | "violated" | "unknown";
  label: string;
  detail: string;
}

export interface FlowGraph {
  v: 1;
  level: FlowLevel;
  at: string;
  agent: string;
  window: { since: string; until: string; hours: number };
  runs: { id: string; type: string; at: string; outcome: string; dryRun: boolean }[];
  nodes: FlowNode[];
  edges: FlowEdge[];
  checks: FlowCheck[];
  /** Spend per ledger day in the window, against the cap that applied (USD; PMX has no plan-credit figure). */
  budget: { day: string; spentUsd: number; capUsd: number }[];
  skills: { name: string; version: string; source: string; uses: number }[];
  /** The headline numbers for the trust ledger. */
  summary: { read: number; held: number; skippedUpstream: number; tasks: number; registered: number; executions: number; spentUsd: number; capUsd: number | null };
  freshness: { linearSyncedAt: string | null; oldestReceipt: string | null; runlogEntries: number | null };
  /** Links PMX can't draw from what it has, in plain words. */
  gaps: string[];
}

export interface FlowInputs {
  level: FlowLevel;
  now: Date;
  hours: number;
  agent: string;
  receipts: RunReceipt[];
  runlog: RunLogEntry[] | null;
  chain: VerifyResult | null;
  /** Linear as PMX sees it: the relay snapshot with queued changes overlaid, or the direct API's issues. */
  issues: any[] | null;
  linearSyncedAt: string | null;
  /** Changes waiting for the next Linear sync. */
  outbox: { kind: string; text: string }[];
  /** PENDING-… → real identifier, from the relay. */
  resolved: Record<string, { identifier: string }>;
  state: Pick<State, "ledger" | "caps" | "collectReports">;
  caps: { personalUsd: number; teamUsd: number; resetHour: number };
  /** Local level only: held items found again in the PM's folders, by receipt ID. */
  live?: Record<string, LiveSource[]>;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const label = (rule: string) => HOLD_LABELS[rule as HoldReason | "all-passages-held"] ?? rule;

/** Ledger day for a timestamp, as `budget/provider.ts` counts it. */
function ledgerDay(d: Date, resetHour: number): string {
  const s = new Date(d.getTime() - resetHour * 3600000);
  return `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, "0")}-${String(s.getDate()).padStart(2, "0")}`;
}

export function buildFlowGraph(i: FlowInputs): FlowGraph {
  const hours = Math.max(1, Math.min(336, Math.round(i.hours)));
  const since = new Date(i.now.getTime() - hours * 3600000);
  const inWindow = (at: string | undefined | null) => !!at && at >= since.toISOString() && at <= i.now.toISOString();
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const gaps: string[] = [];
  const add = (n: FlowNode) => (nodes.has(n.id) ? nodes.get(n.id)! : (nodes.set(n.id, n), n));
  const link = (from: string, to: string, kind: EdgeKind, extra: Partial<FlowEdge> = {}) => {
    if (nodes.has(from) && nodes.has(to) && !edges.some((e) => e.from === from && e.to === to && e.kind === kind)) edges.push({ from, to, kind, ...extra });
  };
  const team = i.level === "team";
  const local = i.level === "local";

  // Linear: tasks and the meeting ledger, as of the last sync. Titles are what Linear already shows the team.
  const issues = (i.issues ?? []).map((n) => ({ n, kind: kindOf(n) }));
  const byIdentifier = new Map(issues.map((x) => [x.n.identifier as string, x]));
  const byTitle = new Map(issues.filter((x) => x.kind !== "meeting").map((x) => [norm(x.n.title ?? ""), x]));
  const ledgerKeys = new Map<string, string>();
  for (const x of issues) if (x.kind === "meeting") for (const k of toMeeting(x.n).keys) ledgerKeys.set(k, x.n.identifier);
  const resolve = (id: string) => i.resolved[id]?.identifier ?? id;
  const issueNode = (identifier: string) => {
    const x = byIdentifier.get(resolve(identifier));
    if (!x) {
      if (!team) return null;
      // The team view knows only identifiers from the run log.
      return add({ id: `lin:${identifier}`, kind: "issue", stage: 4, label: identifier, meta: { identifier } });
    }
    const t = toTask(x.n);
    const meeting = x.kind === "meeting";
    return add({
      id: `lin:${t.identifier}`, kind: meeting ? "meeting" : "issue", stage: 4, label: team ? t.identifier : `${t.identifier} · ${t.title}`,
      status: t.status, url: t.url || null, at: x.n.createdAt ?? null,
      meta: { identifier: t.identifier, category: t.category, size: t.size, pending: !!x.n.pending, agent: t.agent },
    });
  };

  // The checkpoint: one vault for everything held, and one node for what the collection task skipped upstream.
  const receipts = team ? [] : i.receipts.filter((r) => inWindow(r.at)).sort((a, b) => a.at.localeCompare(b.at));
  const skillUses = new Map<string, { name: string; version: string; source: string; uses: number }>();
  const useSkill = (name: string, version: string, source: string, target: string) => {
    const id = `skill:${name}@${version}`;
    add({ id, kind: "skill", stage: 2, label: `${name} · ${version.slice(0, 7)}`, meta: { name, version, source } });
    const u = skillUses.get(id) ?? { name, version, source, uses: 0 };
    u.uses++;
    skillUses.set(id, u);
    link(id, target, "used-skill");
  };
  let read = 0, held = 0, skippedUpstream = 0, tasksN = 0, registered = 0;
  const heldKeys: { keys: string[]; run: string }[] = [];
  let canaryTotal = 0, canaryHeld = 0;
  const canaryFailed = new Set<string>();
  let oldLinks = 0, unresolved = 0;

  if (!team) {
    add({ id: "vault", kind: "vault", stage: 1, label: "Held: never sent to the model or Linear", meta: {} });
    const reports = i.state.collectReports.filter((r) => inWindow(r.at));
    const skipped: Record<string, number> = {};
    for (const r of reports) for (const [k, v] of Object.entries(r.skipped)) skipped[k] = (skipped[k] ?? 0) + v;
    skippedUpstream = Object.values(skipped).reduce((a, b) => a + b, 0);
    const neverIngest = (skipped["never-ingest-title"] ?? 0) + (skipped["never-ingest-person"] ?? 0);
    if (reports.length) {
      add({
        id: "skipped", kind: "skipped", stage: 0, label: `Skipped before saving: ${skippedUpstream}`,
        meta: { ...skipped, runs: reports.length, connectors: [...new Set(reports.map((r) => r.connector).filter(Boolean))].join(", ") || null, saved: reports.reduce((a, r) => a + r.saved, 0) },
      });
      if (neverIngest) link("skipped", "vault", "skipped", { rule: "never-ingest" });
    }
  }

  // Shared views number held items instead of showing their hashes, the same number for the same file.
  const heldSeq = new Map<string, number>();
  const usedSeq = new Map<string, number>();
  for (const r of receipts) {
    const runId = `run:${r.id}`;
    add({
      id: runId, kind: "run", stage: 2, run: r.id, at: r.at,
      label: `${r.type === "synthesize" ? "Synthesis" : r.type === "digest" ? "Digest" : "To-dos"} · ${r.at.slice(11, 16)} UTC`,
      status: r.dryRun ? "dry-run" : r.outcome, costUsd: r.model?.costUsd ?? null, durationMs: r.model?.durationMs ?? null,
      meta: {
        type: r.type, outcome: r.outcome, dryRun: !!r.dryRun, model: r.model?.name ?? null, tokens: r.model?.tokens ?? null,
        masked: Object.values(r.masked).reduce((a, b) => a + b, 0), scope: r.window.scope,
        canaries: r.canaries ? `${r.canaries.held}/${r.canaries.total}` : null, error: r.error ? r.error.slice(0, 200) : null,
      },
    });
    if (r.canaries) {
      canaryTotal += r.canaries.total;
      canaryHeld += r.canaries.held;
      for (const f of r.canaries.failed) canaryFailed.add(f);
    }
    for (const s of r.skills) useSkill(s.name, s.version, s.source, runId);
    const live = i.live?.[r.id];
    const usedIds = new Map<string, string>();
    r.sources.forEach((s, idx) => {
      if (s.decision === "used") {
        read++;
        // Only this Mac's page uses path hashes as IDs; shared views number sources instead (PRIV-4).
        if (!usedSeq.has(s.refHash)) usedSeq.set(s.refHash, usedSeq.size + 1);
        const id = local ? `src:${s.refHash}` : `src:${usedSeq.get(s.refHash)}`;
        const cut: Record<string, number> = {};
        for (const p of s.passagesCut) cut[p.rule] = (cut[p.rule] ?? 0) + 1;
        add({
          id, kind: "source", stage: 0, label: s.title ?? s.file ?? "Source", at: s.at ?? null, status: "used",
          meta: {
            origin: s.origin ?? (s.kind === "slack" ? "slack" : "file"), channel: s.channel ?? null, passagesUsed: s.passagesUsed,
            passagesCut: s.passagesCut.length, cutRules: Object.keys(cut).map(label).join(", ") || null,
            ledger: s.ledger?.state ?? null, ...(local ? { detail: s.detail, file: s.file ?? null } : {}),
          },
        });
        link(id, runId, "read");
        if (s.id) usedIds.set(s.id, id);
        if (s.ledger?.entry && issueNode(s.ledger.entry)) link(id, `lin:${resolve(s.ledger.entry)}`, "lodged");
        return;
      }
      if (!heldSeq.has(s.refHash)) held++;
      if (s.keys?.length) heldKeys.push({ keys: s.keys, run: r.id });
      const rule = s.rule ?? "unknown";
      const found = local ? live?.[idx] : undefined;
      heldSeq.set(s.refHash, heldSeq.get(s.refHash) ?? heldSeq.size + 1);
      const id = local ? `held:${s.refHash}` : `held:${heldSeq.get(s.refHash)}`;
      add({
        id, kind: "source", stage: 0, status: "held",
        label: found?.title ?? found?.file ?? (local ? "A file no longer in your folders" : `Held · ${label(rule)}`),
        meta: { rule, ruleLabel: label(rule), origin: s.origin ?? (s.kind === "slack" ? "slack" : "file"), ...(local ? { detail: s.detail, file: found?.file ?? null } : {}) },
      });
      link(id, "vault", "held", { rule });
    });

    // Synthesized tasks: cited sources → task → the Linear issue it became.
    (r.synth?.tasks ?? []).forEach((t, idx) => {
      tasksN++;
      const id = `task:${r.id}:${idx}`;
      add({
        id, kind: "task", stage: 3, run: r.id, label: t.title, at: r.at, status: r.dryRun ? "dry-run" : "proposed",
        meta: { category: t.category, size: t.size, why: t.sizing?.why ?? null, flags: t.sizing?.flags.join(", ") || null, sources: t.sources.length },
      });
      link(runId, id, "synthesized");
      for (const sid of t.sources) if (usedIds.has(sid)) link(usedIds.get(sid)!, id, "cited");
      const p = t.posted;
      if (p && "identifier" in p) {
        const n = issueNode(p.identifier);
        if (n) { link(id, n.id, "registered"); registered++; }
        else if (/^PENDING-/.test(resolve(p.identifier))) unresolved++;
      } else if (p && "duplicateOf" in p) {
        const n = issueNode(p.duplicateOf);
        if (n) link(id, n.id, "duplicate-of");
      } else if (!p && !r.dryRun) {
        // Receipts from before 0.11.0 don't say which issue a task became: match by title, drawn dashed.
        const x = byTitle.get(norm(t.title));
        const n = x ? issueNode(x.n.identifier) : null;
        if (n) { link(id, n.id, "registered", { inferred: true }); registered++; oldLinks++; }
      }
    });

    // Private to-dos stay on this Mac: their text only on the local page, a count elsewhere.
    const added = r.todo?.added ?? [];
    if (added.length) {
      if (local) added.forEach((t, idx) => {
        const id = `todo:${r.id}:${idx}`;
        add({ id, kind: "todo", stage: 3, run: r.id, label: t.text, at: r.at, status: "private", meta: { due: t.due } });
        link(runId, id, "synthesized");
        for (const sid of t.source.split(/[,\s]+/)) if (usedIds.has(sid)) link(usedIds.get(sid)!, id, "cited");
      });
      else {
        const id = `todo:${r.id}`;
        add({ id, kind: "todo", stage: 3, run: r.id, label: `${added.length} private to-do(s), kept on the PM's Mac`, at: r.at, status: "private", meta: { count: added.length } });
        link(runId, id, "synthesized");
      }
    }
  }

  // Meeting ledger entries tie each processed meeting to the tasks it produced (MEET-2).
  for (const n of [...nodes.values()].filter((x) => x.kind === "meeting")) {
    const x = byIdentifier.get(String(n.meta.identifier));
    if (x) for (const t of toMeeting(x.n).tasks) { const tn = issueNode(t); if (tn) link(n.id, tn.id, "produced"); }
  }

  // Departures: agent runs and review verdicts from the run log.
  const log = (i.runlog ?? []).filter((e) => inWindow(e.ts));
  let executions = 0;
  const lastRun = new Map<string, string>();
  for (const e of log) {
    if (e.type === "run") {
      executions++;
      const id = `exec:${e.taskId}:${e.ts}`;
      add({
        id, kind: "execution", stage: 5, at: e.ts, label: `${e.taskId} · ${e.outcome}`, status: e.outcome, costUsd: e.costUsd, durationMs: e.durationMs,
        meta: { taskId: e.taskId, category: e.category, size: e.size, agent: e.agent, tokens: e.tokens, runtime: e.runtime, skill: e.skill },
      });
      const n = issueNode(e.taskId);
      if (n) link(n.id, id, "executed");
      useSkill(e.skill, e.skillVersion, "team", id);
      lastRun.set(e.taskId, id);
    } else if (e.type === "verdict") {
      const id = `verdict:${e.taskId}:${e.ts}`;
      add({ id, kind: "verdict", stage: 5, at: e.ts, label: `${e.taskId} · ${e.verdict}`, status: e.verdict, meta: { taskId: e.taskId, reviewMinutes: e.reviewMinutes, editSize: e.editSize, agent: e.agent } });
      const run = lastRun.get(e.taskId);
      if (run) link(run, id, "judged");
      else { const n = issueNode(e.taskId); if (n) link(n.id, id, "judged"); }
    } else if (team && (e.type === "synthesize" || e.type === "digest")) {
      const id = `run:${e.agent}:${e.ts}`;
      add({
        id, kind: "run", stage: 2, at: e.ts, label: `${e.type === "synthesize" ? "Synthesis" : "Digest"} · ${e.agent}`, status: e.type === "digest" ? e.outcome : "posted",
        costUsd: e.costUsd, durationMs: e.durationMs, meta: { type: e.type, agent: e.agent, held: e.held, posted: e.type === "synthesize" ? e.posted : null },
      });
      held += e.held;
    }
  }

  // Spend per day against the cap that applied (PULL-5). Plan credit isn't something PMX can read (Q1).
  const budget: FlowGraph["budget"] = [];
  if (!team) {
    for (let d = new Date(since); d <= i.now; d = new Date(d.getTime() + 86400000)) {
      const day = ledgerDay(d, i.caps.resetHour);
      if (budget.some((b) => b.day === day)) continue;
      budget.push({ day, spentUsd: i.state.ledger[day] ?? 0, capUsd: Math.min(i.state.caps[day] ?? i.caps.personalUsd, i.caps.teamUsd) });
    }
    const today = ledgerDay(i.now, i.caps.resetHour);
    if (!budget.some((b) => b.day === today)) budget.push({ day: today, spentUsd: i.state.ledger[today] ?? 0, capUsd: Math.min(i.state.caps[today] ?? i.caps.personalUsd, i.caps.teamUsd) });
  }

  // The checks behind the seal (FLOW-3).
  const checks: FlowCheck[] = [];
  if (!team) {
    const leaked = heldKeys.filter((h) => h.keys.some((k) => ledgerKeys.has(k)));
    const outboxCanary = i.outbox.filter((o) => o.text.includes("PMX-CANARY-")).length;
    checks.push(i.issues === null
      ? { id: "held-never-in-linear", status: "unknown", label: "Held meetings stayed out of Linear", detail: "PMX has no copy of Linear yet, so it can't compare. Run the Linear sync." }
      : leaked.length
        ? { id: "held-never-in-linear", status: "violated", label: "Held meetings stayed out of Linear", detail: `${leaked.length} held meeting(s) match a meeting in Linear's ledger: ${[...new Set(leaked.flatMap((h) => h.keys.map((k) => ledgerKeys.get(k)).filter(Boolean)))].join(", ")}. A teammate may have processed the same meeting; check it.` }
        : { id: "held-never-in-linear", status: "ok", label: "Held meetings stayed out of Linear", detail: `${held} held item(s) and ${skippedUpstream} skipped before saving; none matches any of the ${ledgerKeys.size} meeting key(s) in Linear, and every task cites only sources that passed.` });
    checks.push(canaryTotal === 0
      ? { id: "canaries", status: "unknown", label: "Canaries held", detail: "No run in this window tested canaries yet (runs from pmx 0.11.0 on do)." }
      : canaryFailed.size
        ? { id: "canaries", status: "violated", label: "Canaries held", detail: `${canaryTotal - canaryHeld} of ${canaryTotal} test meeting(s) got past the rules: ${[...canaryFailed].join(", ")}. Run \`pmx doctor\`.` }
        : { id: "canaries", status: "ok", label: "Canaries held", detail: `${canaryHeld} of ${canaryTotal} fake confidential meetings were held by this window's own rules.` });
    checks.push(outboxCanary
      ? { id: "outbox-clean", status: "violated", label: "Nothing confidential is waiting to go to Linear", detail: `${outboxCanary} queued change(s) carry a canary marker.` }
      : { id: "outbox-clean", status: "ok", label: "Nothing confidential is waiting to go to Linear", detail: `${i.outbox.length} change(s) waiting for the next sync; none carries a canary.` });
  }
  if (i.chain) checks.push(i.chain.ok
    ? { id: "runlog-chain", status: "ok", label: "Run log unbroken", detail: `${i.chain.entries} entries from ${i.chain.agents} agent(s); every hash matches.` }
    : { id: "runlog-chain", status: "violated", label: "Run log unbroken", detail: i.chain.problems.slice(0, 3).join("; ") });
  else checks.push({ id: "runlog-chain", status: "unknown", label: "Run log unbroken", detail: "No run log yet: no agent has run a task." });
  if (!team) checks.push(oldLinks || unresolved
    ? { id: "links", status: "unknown", label: "Every link is recorded", detail: [oldLinks ? `${oldLinks} task link(s) matched by title (older runs don't record the issue; drawn dashed)` : "", unresolved ? `${unresolved} task(s) wait for the next Linear sync` : ""].filter(Boolean).join("; ") }
    : { id: "links", status: "ok", label: "Every link is recorded", detail: "Every task that went to Linear in this window records the issue it became." });

  if (!team && !receipts.length) gaps.push("No PMX run on this Mac in this window. Widen the window, or check `pmx schedule`.");
  if (i.issues === null && !team) gaps.push("No copy of Linear yet: issues appear after the next Linear sync.");
  const oldest = i.receipts.map((r) => r.at).sort()[0] ?? null;
  if (!team && oldest && oldest > since.toISOString()) gaps.push(`PMX keeps run records for 14 days; the oldest here is from ${oldest.slice(0, 10)}.`);
  if (!team) for (const e of (i.runlog ?? []).filter((x) => inWindow(x.ts) && x.agent === i.agent && (x.type === "synthesize" || x.type === "digest")))
    if ("receipt" in e && e.receipt && !receipts.some((r) => r.id === e.receipt)) gaps.push(`Run ${e.receipt} is in the run log but its record has expired on this Mac.`);

  const spent = budget.reduce((a, b) => a + b.spentUsd, 0);
  const todayCap = budget.at(-1)?.capUsd ?? null;
  return {
    v: 1, level: i.level, at: i.now.toISOString(), agent: i.agent, window: { since: since.toISOString(), until: i.now.toISOString(), hours },
    runs: receipts.map((r) => ({ id: r.id, type: r.type, at: r.at, outcome: r.outcome, dryRun: !!r.dryRun })),
    nodes: [...nodes.values()], edges, checks, budget, skills: [...skillUses.values()],
    summary: { read, held, skippedUpstream, tasks: tasksN, registered, executions, spentUsd: Math.round(spent * 10000) / 10000, capUsd: todayCap },
    freshness: { linearSyncedAt: i.linearSyncedAt, oldestReceipt: oldest, runlogEntries: i.runlog?.length ?? null },
    gaps,
  };
}

/** Plain-language claims for the top of the page (the trust ledger). Every one is backed by nodes in the graph. */
export function trustClaims(g: FlowGraph): string[] {
  const s = g.summary;
  const out: string[] = [];
  if (g.level !== "team") {
    out.push(`${s.read} source(s) read, ${s.held} held${s.skippedUpstream ? `, ${s.skippedUpstream} skipped before saving` : ""}.`);
    const byRule = new Map<string, number>();
    for (const n of g.nodes) if (n.status === "held") byRule.set(String(n.meta.ruleLabel), (byRule.get(String(n.meta.ruleLabel)) ?? 0) + 1);
    if (byRule.size) out.push(`Held: ${[...byRule].map(([k, v]) => `${v} ${k.toLowerCase()}`).join(", ")}.`);
  }
  out.push(`${s.tasks} task(s) proposed, ${s.registered} in Linear; ${s.executions} agent run(s).`);
  if (s.capUsd !== null) out.push(`$${s.spentUsd.toFixed(2)} spent in this window; today's cap is $${s.capUsd.toFixed(2)}.`);
  for (const c of g.checks) out.push(`${c.status === "ok" ? "✔" : c.status === "violated" ? "✘" : "?"} ${c.label}: ${c.detail}`);
  return out;
}
