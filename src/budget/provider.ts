import type { PersonalConfig, TeamConfig } from "../core/config.js";
import type { State } from "../core/state.js";

export interface Budget {
  remainingUsd: number;
  capUsd: number;
  spentUsd: number;
  resetAt: Date;
  minutesToReset: number;
  source: "override" | "ledger";
}

/** The ledger day a timestamp falls in, given the reset hour (local time). */
export function ledgerDay(d: Date, resetHour: number): string {
  const shifted = new Date(d.getTime() - resetHour * 3600000);
  const y = shifted.getFullYear();
  const m = String(shifted.getMonth() + 1).padStart(2, "0");
  const day = String(shifted.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function nextReset(now: Date, resetHour: number): Date {
  const r = new Date(now);
  r.setHours(resetHour, 0, 0, 0);
  if (r <= now) r.setDate(r.getDate() + 1);
  return r;
}

/**
 * The budget provider (PULL-5), framed as spend caps and pacing (P10).
 * Order: an official usage source (none exists yet, Q1), then the self-tracked ledger against the
 * declared daily cap, then a manual override. The team's per-machine daily cap always wins (SEC-6).
 */
export function budget(p: PersonalConfig, team: TeamConfig, s: State, now: Date): Budget {
  const resetAt = nextReset(now, p.budget.resetHour);
  const minutesToReset = Math.round((resetAt.getTime() - now.getTime()) / 60000);
  const capUsd = Math.min(p.budget.dailyUsd, team.caps.perDayUsd);
  const spentUsd = s.ledger[ledgerDay(now, p.budget.resetHour)] ?? 0;
  if (p.budget.overrideUsd != null) {
    return { remainingUsd: Math.max(0, Math.min(p.budget.overrideUsd, team.caps.perDayUsd - spentUsd)), capUsd, spentUsd, resetAt, minutesToReset, source: "override" };
  }
  return { remainingUsd: Math.max(0, capUsd - spentUsd), capUsd, spentUsd, resetAt, minutesToReset, source: "ledger" };
}

export function recordSpend(s: State, p: PersonalConfig, now: Date, usd: number | null): void {
  if (!usd) return;
  const day = ledgerDay(now, p.budget.resetHour);
  s.ledger[day] = Math.round(((s.ledger[day] ?? 0) + usd) * 10000) / 10000;
  s.caps = { ...s.caps, [day]: p.budget.dailyUsd };
}
