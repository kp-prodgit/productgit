import { createHash } from "node:crypto";
import type { SignalItem } from "../core/types.js";
import type { MeetingEntry } from "../tracker/types.js";

const h = (s: string) => `m${createHash("sha256").update(s).digest("hex").slice(0, 16)}`;
const normTitle = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * The identities of one meeting (MEET-1), as hashes. Two PMs who collected the same meeting, from the
 * same connector or from different ones, get at least one key in common:
 *  - the connector's own ID (same Fireflies meeting, same key);
 *  - the calendar identity: day, title and everyone's email address.
 * Without either, the transcript's opening text stands in, so the same file is never processed twice.
 */
export function meetingKeys(item: Pick<SignalItem, "at" | "title" | "participants" | "text" | "origin">): string[] {
  const keys: string[] = [];
  if (item.origin?.sourceId) keys.push(h(`src|${item.origin.source}|${item.origin.sourceId}`));
  const emails = item.participants.filter((p) => p.includes("@")).map((p) => p.toLowerCase()).sort();
  const day = item.at.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(day) && emails.length) keys.push(h(`cal|${day}|${normTitle(item.title)}|${emails.join(",")}`));
  if (!keys.length) keys.push(h(`txt|${item.text.replace(/\s+/g, " ").trim().slice(0, 2000)}`));
  return keys;
}

/** Local midnight `days` days before `now`: polling picks up today's meetings by default (MEET-3). */
export function startOfDay(now: Date, daysBack = 0): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  return d;
}

export const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export interface MeetingPlan {
  /** Not processed yet, with the open ledger entry to reuse when an earlier attempt failed. */
  fresh: { item: SignalItem; entry: MeetingEntry | null }[];
  /** Already done by someone on the team. */
  already: { item: SignalItem; entry: MeetingEntry }[];
  /** Held before `since`, so out of this pass. */
  before: SignalItem[];
  /** Everything that isn't a meeting (Slack), untouched. */
  other: SignalItem[];
}

/** Sorts gathered items against the team's meeting ledger (MEET-2, MEET-3). Pure. */
export function planMeetings(items: SignalItem[], entries: MeetingEntry[], since: Date): MeetingPlan {
  const plan: MeetingPlan = { fresh: [], already: [], before: [], other: [] };
  const done = new Map<string, MeetingEntry>();
  const open = new Map<string, MeetingEntry>();
  for (const e of entries) for (const k of e.keys) (e.status === "done" ? done : open).set(k, e);
  const cutoff = localDay(since);
  for (const item of items) {
    if (item.kind !== "transcript" || !item.keys?.length) {
      plan.other.push(item);
      continue;
    }
    const hit = item.keys.map((k) => done.get(k)).find(Boolean);
    if (hit) plan.already.push({ item, entry: hit });
    else if (item.at.slice(0, 10) < cutoff) plan.before.push(item);
    else plan.fresh.push({ item, entry: item.keys.map((k) => open.get(k)).find(Boolean) ?? null });
  }
  return plan;
}
