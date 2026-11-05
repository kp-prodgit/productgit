import type { TeamConfig } from "../core/config.js";
import { exec as defaultExec, type Exec } from "../core/exec.js";
import { cleanInvocation, profileChecks, type InvocationOpts } from "../core/profile.js";
import type { AgentRuntime, ProbeResult, RunResult } from "./types.js";

export function claudeCode(exec: Exec = defaultExec): AgentRuntime {
  return {
    name: "claude-code",

    async probe(team: TeamConfig): Promise<ProbeResult> {
      const problems: string[] = [];
      const v = await exec("claude", ["--version"], { timeoutMs: 15000 });
      if (v.code !== 0) problems.push("Claude Code is not installed or not on PATH (https://code.claude.com).");
      for (const c of await profileChecks(team)) if (!c.ok) problems.push(`clean profile: ${c.detail}`);
      return { ok: problems.length === 0, version: v.code === 0 ? v.stdout.trim() : null, problems };
    },

    async run(o: InvocationOpts): Promise<RunResult> {
      const inv = cleanInvocation(o);
      const started = Date.now();
      const r = await exec(inv.cmd, inv.args, { cwd: inv.cwd, env: inv.env, timeoutMs: 3 * 60 * 60 * 1000, input: "" });
      const durationMs = Date.now() - started;
      let out: any = null;
      try {
        out = JSON.parse(r.stdout);
      } catch {
        return { ok: false, text: "", costUsd: null, tokens: null, durationMs, capped: false, error: (r.stderr || r.stdout).trim().slice(0, 2000) };
      }
      const u = out.usage ?? {};
      const tokens = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
        .map((k) => Number(u[k] ?? 0))
        .reduce((a, b) => a + b, 0);
      const subtype = String(out.subtype ?? "");
      const capped = /max_turns|budget/.test(subtype);
      return {
        ok: out.is_error === false && subtype === "success",
        text: String(out.result ?? ""),
        costUsd: typeof out.total_cost_usd === "number" ? out.total_cost_usd : null,
        tokens: tokens || null,
        durationMs: Number(out.duration_ms ?? durationMs),
        capped,
        error: out.is_error ? subtype || "error" : undefined,
      };
    },
  };
}
