import type { AgentRuntime } from "./types.js";

/** Used when policy forbids runs on this machine: probe fails and nothing ever starts (fail closed). */
export function refusingRuntime(reason: string): AgentRuntime {
  return {
    name: "refused",
    async probe() {
      return { ok: false, version: null, problems: [reason] };
    },
    async run() {
      throw new Error(`Runs are blocked: ${reason}`);
    },
  };
}
