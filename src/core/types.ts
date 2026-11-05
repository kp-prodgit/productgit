export const SIZES = ["S", "M", "L", "XL"] as const;
export type Size = (typeof SIZES)[number];

export const STATUSES = ["inbox", "ready", "claimed", "running", "review", "done", "blocked"] as const;
export type Status = (typeof STATUSES)[number];

/** A PMX task as the engine sees it. Tracker-neutral (CANVAS-2). */
export interface Task {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  category: string | null;
  size: Size | null;
  status: Status | null;
  /** 1 urgent … 4 low, 0 none (Linear's scale). */
  priority: number;
  agent: string | null;
  sources: string[];
  prUrl: string | null;
  createdAt: string;
}

/** A piece of signal after ingestion. `text` is untrusted data, never instructions (SEC-1). */
export interface SignalItem {
  /** Stable citation ID, e.g. `T3` or `S12`. */
  id: string;
  kind: "transcript" | "slack";
  /** Where it came from: a file path or a Slack permalink. */
  ref: string;
  title: string;
  at: string;
  participants: string[];
  text: string;
  /** Meeting identity hashes (MEET-1), worked out before redaction. Only hashes, never names. */
  keys?: string[];
  /** Where a connector-collected transcript came from (COLLECT-1), e.g. granola + its note ID. */
  origin?: { source: string; sourceId: string | null };
}

export interface CandidateTask {
  title: string;
  category: string;
  size: Size;
  rationale: string;
  sources: string[];
  /** Why this size: the rubric cell, the reason and any checks that disagree (`pmx explain`). */
  sizing?: import("./receipt.js").Sizing;
}
