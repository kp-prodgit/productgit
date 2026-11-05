import { createHash } from "node:crypto";
import type { SignalItem } from "./types.js";

/**
 * The personal-content filter (B2, PRIV-2). Fixed rules only (Q10, decided 2026-11-03):
 * deterministic, testable and the same on every machine.
 *
 * Held material is discarded, never stored. Each decision is explained by rule and location
 * (PRIV-4): which source, which rule, and a hash of each held passage, never its text.
 */

export type HoldReason =
  | "one-on-one"
  | "performance"
  | "compensation"
  | "health"
  | "never-ingest"
  | "no-external-participant"
  | "unknown-participants";

type Topic = "performance" | "compensation" | "health" | "one-on-one";

/** The fixed topic rules, with plain-language labels and examples for `pmx explain`. */
export const TOPIC_RULES: Record<Topic, { label: string; examples: string[]; patterns: string[] }> = {
  performance: {
    label: "Performance and HR",
    examples: ["performance review", "PIP", "calibration meeting", "underperforming", "written warning", "disciplinary", "promo packet"],
    patterns: [
      "performance (review|improvement plan|rating|issue|conversation)s?", "perf reviews?", "PIP", "calibration (meeting|session)s?",
      "underperform\\w*", "written warning", "disciplinary", "promo(tion)? packets?", "terminat\\w+ (his|her|their) employment",
    ],
  },
  compensation: {
    label: "Pay and compensation",
    examples: ["salary", "comp band", "pay raise", "bonus", "equity grant", "RSUs", "severance", "payroll"],
    patterns: [
      "salary", "salaries", "compensation", "comp bands?", "pay (raise|rise|band|grade|cut)s?", "raise for (me|him|her|them)",
      "bonus(es)?", "equity grants?", "stock grants?", "RSUs?", "severance", "payroll",
    ],
  },
  health: {
    label: "Health and leave",
    examples: ["medical", "diagnosis", "therapy", "sick leave", "surgery", "pregnant", "parental leave", "mental health", "FMLA"],
    patterns: [
      "medical", "diagnos\\w*", "therapy", "therapist", "sick (leave|day)s?", "illness", "surgery", "pregnan\\w*", "maternity", "paternity",
      "parental leave", "disabilit(y|ies)", "mental health", "FMLA", "doctor'?s? (note|appointment)", "hospital\\w*", "medication",
    ],
  },
  "one-on-one": {
    label: "1:1s and career talks",
    examples: ["1:1", "one-on-one", "skip-level", "career chat"],
    patterns: ["1:1s?", "1-1s?", "1 on 1", "one[- ]on[- ]ones?", "1-on-1s?", "skip[- ]levels?", "career (chat|conversation)s?"],
  },
};

export const TOPICS = Object.fromEntries(
  Object.entries(TOPIC_RULES).map(([k, r]) => [k, new RegExp(`\\b(${r.patterns.join("|")})\\b`, "i")]),
) as Record<Topic, RegExp>;

/** Plain-language names for every hold reason, shared by the terminal and the explain page. */
export const HOLD_LABELS: Record<HoldReason | "all-passages-held", string> = {
  "one-on-one": "1:1s and career talks",
  performance: "Performance and HR",
  compensation: "Pay and compensation",
  health: "Health and leave",
  "never-ingest": "Your do-not-read list",
  "no-external-participant": "No one from outside the company",
  "unknown-participants": "No participant list",
  "all-passages-held": "Every passage was cut",
};

export interface FilterRules {
  internalDomains: string[];
  /** Transcripts need an external participant (B2). Slack items skip this check. */
  requireExternalParticipant: boolean;
  neverIngest: { people: string[]; channels: string[]; meetingTitles: string[] };
}

/** Why one source was used or left out. Holds name the rule; passages are hashes, never text. */
export interface ItemDecision {
  item: SignalItem;
  decision: "kept" | "held";
  rule?: HoldReason | "all-passages-held";
  /** A plain-language reason. Names only company or outside domains, never people. */
  detail: string;
  passages: { rule: HoldReason; hash: string }[];
  passagesKept: number;
}

export interface FilterResult {
  kept: SignalItem[];
  held: Record<HoldReason, number>;
  /** Items dropped whole (as opposed to single segments). */
  heldItems: number;
  decisions: ItemDecision[];
}

const emptyCounts = (): Record<HoldReason, number> => ({
  "one-on-one": 0, performance: 0, compensation: 0, health: 0, "never-ingest": 0,
  "no-external-participant": 0, "unknown-participants": 0,
});

const lc = (s: string) => s.toLowerCase();
const domainOf = (p: string) => (p.includes("@") ? lc(p.split("@").pop()!) : null);

function mentions(text: string, needle: string): boolean {
  if (!needle.trim()) return false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${needle.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu");
  return re.test(text);
}

export function itemHoldReason(item: SignalItem, r: FilterRules): HoldReason | null {
  return itemDecision(item, r).reason;
}

export function itemDecision(item: SignalItem, r: FilterRules): { reason: HoldReason | null; detail: string } {
  const ni = r.neverIngest;
  if (TOPICS["one-on-one"].test(item.title)) return { reason: "one-on-one", detail: "the title looks like a 1:1 or career talk" };
  if (ni.meetingTitles.some((t) => lc(item.title).includes(lc(t)))) return { reason: "never-ingest", detail: "the title matches your do-not-read list" };
  if (ni.channels.some((c) => lc(c).replace(/^#/, "") === lc(item.ref).replace(/^#/, "") || lc(item.title) === lc(c).replace(/^#/, "")))
    return { reason: "never-ingest", detail: "the channel is on your do-not-read list" };
  if (item.participants.some((p) => ni.people.some((x) => lc(p) === lc(x) || mentions(p, x))))
    return { reason: "never-ingest", detail: "a participant is on your do-not-read list" };
  if (item.kind === "transcript" && r.requireExternalParticipant) {
    if (item.participants.length === 0) return { reason: "unknown-participants", detail: "the file lists no participants, so PMX can't tell it's a customer call" };
    const internal = r.internalDomains.map(lc);
    const outside = [...new Set(item.participants.map(domainOf).filter((d): d is string => d !== null && !internal.includes(d)))];
    if (!outside.length) {
      const why = internal.length ? `everyone is on your company's domains (${internal.join(", ")})` : "no participant has an email address";
      return { reason: "no-external-participant", detail: why };
    }
    return { reason: null, detail: `has someone from outside the company (${outside.join(", ")})` };
  }
  return { reason: null, detail: item.kind === "slack" ? "a message in an approved channel" : "passed every rule" };
}

/** Utterances or paragraphs: the unit the topic rules judge. Shared with `pmx explain` to locate holds. */
export function segments(text: string): string[] {
  return text.split(/\n(?=\s*\n)|\n(?=[^\n]{1,60}:\s)/);
}

/** A held passage is remembered only by this hash, so it can be located later in the PM's own file. */
export const passageHash = (seg: string) => createHash("sha256").update(seg.trim()).digest("hex").slice(0, 16);

/** Drops the segments that hit a topic rule. `passages` collects each hold as rule + hash. */
export function screenText(text: string, r: FilterRules, counts: Record<HoldReason, number>, passages?: ItemDecision["passages"]): string {
  const kept: string[] = [];
  for (const seg of segments(text)) {
    let reason: HoldReason | null = null;
    for (const [topic, re] of Object.entries(TOPICS) as [Topic, RegExp][]) {
      if (re.test(seg)) {
        reason = topic;
        break;
      }
    }
    if (!reason && r.neverIngest.people.some((p) => mentions(seg, p))) reason = "never-ingest";
    if (reason) {
      counts[reason]++;
      passages?.push({ rule: reason, hash: passageHash(seg) });
    } else kept.push(seg);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function filterItems(items: SignalItem[], r: FilterRules): FilterResult {
  const held = emptyCounts();
  const kept: SignalItem[] = [];
  const decisions: ItemDecision[] = [];
  let heldItems = 0;
  for (const item of items) {
    const { reason, detail } = itemDecision(item, r);
    if (reason) {
      held[reason]++;
      heldItems++;
      decisions.push({ item, decision: "held", rule: reason, detail, passages: [], passagesKept: 0 });
      continue;
    }
    const passages: ItemDecision["passages"] = [];
    const text = screenText(item.text, r, held, passages);
    const passagesKept = text ? segments(text).filter((s) => s.trim()).length : 0;
    if (text) {
      kept.push({ ...item, text });
      decisions.push({ item, decision: "kept", detail, passages, passagesKept });
    } else decisions.push({ item, decision: "held", rule: "all-passages-held", detail: "every passage hit a privacy rule", passages, passagesKept: 0 });
  }
  return { kept, held, heldItems, decisions };
}

export function totalHeld(h: Record<HoldReason, number>): number {
  return Object.values(h).reduce((a, b) => a + b, 0);
}
