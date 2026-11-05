// Product Git Commercial License. See ee/LICENSE.
import type { TeamConfig } from "../../../src/core/config.js";
import { SIZES, type Size, type Task } from "../../../src/core/types.js";
import { BRAIN_ACTIONS, type BrainAction, type BrainPolicy } from "../policy.js";

/** One action the model proposed. Untrusted until `guard` has checked it. */
export interface Proposal {
  task: string | null;
  action: BrainAction;
  value?: string | number;
  why: string;
  confidence: number;
}

export type Mode = "recommended" | "queued" | "executed" | "blocked";

/**
 * The fixed rules (Q10, BRAIN-3), in the order they're checked. The model never sees or changes them.
 * Each ID is what a `brain` event carries; the text is what `pmx brain --why` and the tracker comment say.
 */
export const RULES = {
  "unknown-task": "the task isn't on the PMX board",
  "bad-value": "the proposed value isn't valid for this action",
  "wrong-status": "the task isn't in the status this action needs",
  "category-not-allowed": "the task's category isn't allowed by team config or admin policy",
  "hold-is-advice": "a hold is advice for a person, so it's only posted as a comment",
  "low-confidence": "confidence under 0.5, so it's only a suggestion",
  "brain-off": "the brain is off in admin policy",
  "level-recommend": "admin policy allows suggestions only",
  "level-approve": "admin policy asks a person to approve every action",
  "action-not-allowed": "admin policy doesn't allow this action on autopilot",
  "category-outside-limits": "the category is outside the autopilot limits",
  "size-over-limit": "the task is bigger than the autopilot size limit",
  "kill-switch": "the team kill switch is on, so no agent runs start",
  "category-paused": "the category is paused, so no agent runs start",
  "review-queue-full": "the review queue is full; reviews come before new runs",
  "daily-run-limit": "the autopilot run limit for today is reached",
  "one-run-per-pass": "the brain starts at most one run per pass",
  "over-budget": "the task's size costs more than today's remaining budget",
} as const;
export type RuleId = keyof typeof RULES;

export interface GuardState {
  policy: BrainPolicy;
  team: TeamConfig;
  tasks: Map<string, Task>;
  paused: Map<string, string>;
  killSwitch: boolean;
  reviewCount: number;
  runsToday: number;
  startedThisPass: number;
  budgetLeftUsd: number;
}

const NEEDS: Partial<Record<BrainAction, Task["status"][]>> = {
  "make-ready": ["inbox"],
  "start-run": ["ready"],
  release: ["claimed"],
  "set-priority": ["inbox", "ready", "blocked"],
  "set-size": ["inbox", "ready", "blocked"],
};
const rank = (s: Size | null) => (s ? SIZES.indexOf(s) : SIZES.length);

/** Checks only the proposal itself: real task, valid value, right status. Used again at approval time. */
export function validate(p: Proposal, s: Pick<GuardState, "team" | "tasks">): RuleId | null {
  if (!BRAIN_ACTIONS.includes(p.action)) return "bad-value";
  const task = p.task ? s.tasks.get(p.task) ?? null : null;
  if (p.action === "pause-category") {
    if (typeof p.value !== "string" || !s.team.categories[p.value]) return "bad-value";
    return null;
  }
  if (!task) return "unknown-task";
  if (p.action === "set-priority" && !(Number.isInteger(p.value) && (p.value as number) >= 1 && (p.value as number) <= 4)) return "bad-value";
  if (p.action === "set-size" && !SIZES.includes(p.value as Size)) return "bad-value";
  const needs = NEEDS[p.action];
  if (needs && !needs.includes(task.status)) return "wrong-status";
  if ((p.action === "make-ready" || p.action === "start-run") && (!task.category || !s.team.categories[task.category])) return "category-not-allowed";
  if (p.action === "start-run" && !task.size) return "bad-value";
  return null;
}

/**
 * Decides what happens to a proposal (BRAIN-2, BRAIN-3): carried out, queued for a person, posted as
 * a suggestion, or blocked. Pure and deterministic, so the same board and policy always give the same
 * answer. No rule here lets the brain approve an agent's output: that action doesn't exist.
 */
export function guard(p: Proposal, s: GuardState): { mode: Mode; rule: RuleId | null } {
  const invalid = validate(p, s);
  if (invalid) return { mode: "blocked", rule: invalid };
  if (s.policy.level === "off") return { mode: "blocked", rule: "brain-off" };
  if (p.action === "hold") return { mode: "recommended", rule: "hold-is-advice" };
  if (!(p.confidence >= 0.5)) return { mode: "recommended", rule: "low-confidence" };
  if (s.policy.level === "recommend") return { mode: "recommended", rule: "level-recommend" };

  const task = p.task ? s.tasks.get(p.task)! : null;
  const cost = task?.size ? s.team.sizes[task.size].costUsd : 0;
  if (p.action === "start-run") {
    if (s.killSwitch) return { mode: "blocked", rule: "kill-switch" };
    if (s.paused.has(task!.category!)) return { mode: "blocked", rule: "category-paused" };
    if (s.reviewCount >= s.team.reviewQueueCap) return { mode: "queued", rule: "review-queue-full" };
    if (cost > s.budgetLeftUsd) return { mode: "queued", rule: "over-budget" };
  }
  if (s.policy.level === "approve") return { mode: "queued", rule: "level-approve" };

  const lim = s.policy.autopilot;
  if (!(lim.actions as string[]).includes(p.action)) return { mode: "queued", rule: "action-not-allowed" };
  const category = p.action === "pause-category" ? (p.value as string) : task?.category;
  if (lim.categories.length && (!category || !lim.categories.includes(category))) return { mode: "queued", rule: "category-outside-limits" };
  if (task) {
    const biggest = p.action === "set-size" ? Math.max(rank(task.size), rank(p.value as Size)) : rank(task.size);
    if (biggest > rank(lim.maxSize)) return { mode: "queued", rule: "size-over-limit" };
  }
  if (p.action === "start-run") {
    if (s.runsToday >= lim.maxRunsPerDay) return { mode: "queued", rule: "daily-run-limit" };
    if (s.startedThisPass >= 1) return { mode: "queued", rule: "one-run-per-pass" };
  }
  return { mode: "executed", rule: null };
}
