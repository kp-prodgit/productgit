import { filterItems, type FilterRules, type HoldReason } from "./filter.js";
import type { SignalItem } from "./types.js";

/**
 * Canaries (FLOW-3): fake confidential meetings run through a run's own rules, in memory, every run. Each one
 * must be held (or have its confidential passage cut), which proves today's rules still work on today's
 * config. They never touch the PM's folders, the model or Linear: the relay also refuses any change that
 * carries the marker, so a broken filter can't leak a canary.
 */
export const CANARY_MARKER = "PMX-CANARY-7c1e";

interface Canary {
  name: string;
  /** The rule that must stop it: the whole item, or one passage. */
  expect: { item: HoldReason } | { passage: HoldReason };
  item: Omit<SignalItem, "id" | "kind" | "ref">;
  /** Whether these rules are meant to stop it at all (1:1s are allowed for private to-dos, for example). */
  applies: (r: FilterRules) => boolean;
}

const OUTSIDE = "buyer@canary-customer.example";
const at = "2026-01-01T10:00:00Z";
const talk = (line: string) => `Alex: Thanks for joining.\n\nJordan: ${line}\n\nAlex: Let's pick that up next week.`;

function canaries(r: FilterRules): Canary[] {
  const inside = r.internalDomains[0] ? `teammate@${r.internalDomains[0]}` : "teammate";
  const list: Canary[] = [
    { name: "1:1 title", expect: { item: "one-on-one" }, applies: (x) => !x.allowOneOnOne,
      item: { title: `1:1 Alex / Jordan ${CANARY_MARKER}`, at, participants: [OUTSIDE, inside], text: talk("How is the roadmap going?") } },
    { name: "internal-only meeting", expect: { item: "no-external-participant" }, applies: (x) => x.requireExternalParticipant && x.internalDomains.length > 0,
      item: { title: `Team sync ${CANARY_MARKER}`, at, participants: [inside], text: talk("Let's review the launch checklist.") } },
    { name: "pay passage", expect: { passage: "compensation" }, applies: () => true,
      item: { title: `Customer call ${CANARY_MARKER}`, at, participants: [OUTSIDE, inside], text: talk(`Your salary band moves next quarter. ${CANARY_MARKER}`) } },
    { name: "performance passage", expect: { passage: "performance" }, applies: () => true,
      item: { title: `Customer call ${CANARY_MARKER}`, at, participants: [OUTSIDE, inside], text: talk(`We need to talk about a performance improvement plan. ${CANARY_MARKER}`) } },
    { name: "health passage", expect: { passage: "health" }, applies: () => true,
      item: { title: `Customer call ${CANARY_MARKER}`, at, participants: [OUTSIDE, inside], text: talk(`I'm on sick leave after the surgery. ${CANARY_MARKER}`) } },
  ];
  // The PM's own do-not-read list, used in memory only: the first title and the first person on it.
  const title = r.neverIngest.meetingTitles[0];
  if (title) list.push({ name: "do-not-read title", expect: { item: "never-ingest" }, applies: () => true,
    item: { title: `${title} ${CANARY_MARKER}`, at, participants: [OUTSIDE, inside], text: talk("Status update.") } });
  const person = r.neverIngest.people[0];
  if (person) list.push({ name: "do-not-read person", expect: { item: "never-ingest" }, applies: () => true,
    item: { title: `Customer call ${CANARY_MARKER}`, at, participants: [OUTSIDE, person], text: talk("Status update.") } });
  return list;
}

/** Runs every canary that applies to these rules. `failed` names each one the rules let through. */
export function runCanaries(r: FilterRules): { total: number; held: number; failed: string[] } {
  const list = canaries(r).filter((c) => c.applies(r));
  const failed: string[] = [];
  for (const [i, c] of list.entries()) {
    const item: SignalItem = { ...c.item, id: `C${i + 1}`, kind: "transcript", ref: `canary:${i}` };
    const d = filterItems([item], r).decisions[0];
    const ok = "item" in c.expect
      ? d?.decision === "held" && d.rule === c.expect.item
      : !!d && (d.decision === "held" || d.passages.some((p) => p.rule === (c.expect as { passage: HoldReason }).passage));
    if (!ok) failed.push(c.name);
  }
  return { total: list.length, held: list.length - failed.length, failed };
}

export const CANARY_REFUSAL = "Refusing to send a PMX canary to Linear: a privacy rule let a test meeting through. Run `pmx doctor`.";

/** True when text carries the canary marker. Both Linear paths refuse such changes outright. */
export const hasCanary = (s: string) => s.includes(CANARY_MARKER);
