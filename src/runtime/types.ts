import type { TeamConfig } from "../core/config.js";
import type { InvocationOpts } from "../core/profile.js";

export interface RunResult {
  ok: boolean;
  /** The agent's final message. */
  text: string;
  costUsd: number | null;
  tokens: number | null;
  durationMs: number;
  /** Stopped by the per-run spend or turn cap (SEC-6). */
  capped: boolean;
  error?: string;
}

export interface ProbeResult {
  ok: boolean;
  version: string | null;
  problems: string[];
}

/**
 * One interface per swappable engine (P2). Claude Code is the only implementation.
 * `probe` must fail closed: if the runtime can't meet the isolation profile, no run starts.
 */
export interface AgentRuntime {
  readonly name: string;
  probe(team: TeamConfig): Promise<ProbeResult>;
  run(o: InvocationOpts): Promise<RunResult>;
}
