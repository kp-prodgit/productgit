import type { InvocationOpts } from "../core/profile.js";
import type { AgentRuntime, RunResult } from "./types.js";

/** A scripted runtime for tests and `--runtime mock` demos. Never calls a model. */
export function mockRuntime(
  respond: (o: InvocationOpts) => Promise<string | Partial<RunResult>> | string | Partial<RunResult>,
): AgentRuntime & { calls: InvocationOpts[] } {
  const calls: InvocationOpts[] = [];
  return {
    name: "mock",
    calls,
    async probe() {
      return { ok: true, version: "mock", problems: [] };
    },
    async run(o) {
      calls.push(o);
      const r = await respond(o);
      const base: RunResult = { ok: true, text: "", costUsd: 0.01, tokens: 1000, durationMs: 5, capped: false };
      return typeof r === "string" ? { ...base, text: r } : { ...base, ...r };
    },
  };
}
