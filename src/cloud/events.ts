import { createHash } from "node:crypto";
import type { RunReceipt } from "../core/receipt.js";
import type { RunLogEntry } from "../core/runlog.js";
import type { Cloud } from "./client.js";

/**
 * Turns run log entries into content-free events (P7, CANVAS-4). Only the fields the control
 * plane's strict schema allows; nulls are dropped; `refused` runs are local-only.
 * The entry hash is the event ID, so re-sending is a no-op.
 */
export function toEvents(entries: RunLogEntry[], sinceTs: string | null): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const e of entries) {
    if (sinceTs && e.ts <= sinceTs) continue;
    if (!e.hash) continue;
    const at = new Date(e.ts).toISOString();
    if (e.type === "run" && e.outcome !== "refused" && ["S", "M", "L", "XL"].includes(e.size)) {
      out.push(strip({
        type: "run", id: e.hash, at, taskId: e.taskId, category: e.category, size: e.size, skillVersion: e.skillVersion,
        runtime: e.runtime, outcome: e.outcome, durationMs: Math.round(e.durationMs), tokens: e.tokens ?? undefined,
        costUsd: e.costUsd ?? undefined, agent: e.agent,
      }));
    } else if (e.type === "verdict" && ["S", "M", "L", "XL"].includes(e.size)) {
      out.push(strip({
        type: "verdict", id: e.hash, at, taskId: e.taskId, category: e.category, size: e.size, verdict: e.verdict,
        editSize: e.editSize ?? undefined, reviewMinutes: e.reviewMinutes ?? undefined, agent: e.agent,
      }));
    }
  }
  return out;
}

function strip(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
}

/**
 * One `pipeline` event per digest or synthesis receipt (never a to-do run): counts and cost only. Never a title, a file
 * name, a rule detail or anything the run read. The ID hashes the agent and receipt ID.
 */
export function pipelineEvents(receipts: RunReceipt[], sinceAt: string | null): Record<string, unknown>[] {
  return receipts
    // Individual to-dos are private to the PM (TODO-1): not even their counts leave the Mac.
    .filter((r) => r.type !== "todo")
    .filter((r) => !sinceAt || r.at > sinceAt)
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((r) => strip({
      type: "pipeline",
      id: createHash("sha256").update(`${r.agent}\n${r.id}`).digest("hex").slice(0, 32),
      at: r.at, kind: r.type, outcome: r.outcome,
      found: r.sources.length,
      used: r.sources.filter((s) => s.decision === "used").length,
      cut: r.sources.reduce((n, s) => n + s.passagesCut.length, 0),
      tasks: r.synth?.tasks.length,
      costUsd: r.model?.costUsd ?? undefined,
      agent: r.agent,
    }));
}

export async function postEvents(cloud: Cloud, orgId: string, events: Record<string, unknown>[]): Promise<number> {
  for (let i = 0; i < events.length; i += 100) await cloud.call("POST", `/orgs/${orgId}/events`, { events: events.slice(i, i + 100) });
  return events.length;
}

export async function syncEvents(cloud: Cloud, orgId: string, entries: RunLogEntry[], sinceTs: string | null): Promise<{ sent: number; lastTs: string | null }> {
  const sent = await postEvents(cloud, orgId, toEvents(entries, sinceTs));
  return { sent, lastTs: entries.at(-1)?.ts ?? sinceTs };
}
