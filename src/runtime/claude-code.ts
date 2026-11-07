import type { TeamConfig } from "../core/config.js";
import { LOGIN_HINT, profileSignedIn, resolveClaude } from "../core/claude-bin.js";
import { exec as defaultExec, type Exec } from "../core/exec.js";
import { cleanInvocation, profileChecks, type InvocationOpts } from "../core/profile.js";
import type { AgentRuntime, ProbeResult, RunResult } from "./types.js";

export function claudeCode(exec: Exec = defaultExec): AgentRuntime {
  return {
    name: "claude-code",

    async probe(team: TeamConfig): Promise<ProbeResult> {
      const problems: string[] = [];
      const v = await resolveClaude(exec);
      if (!v) problems.push("Claude Code is not installed (https://code.claude.com).");
      for (const c of await profileChecks(team)) if (!c.ok) problems.push(`clean profile: ${c.detail}`);
      if (v && (await profileSignedIn(exec))?.ok === false) problems.push(`clean profile isn't signed in: ${LOGIN_HINT}`);
      return { ok: problems.length === 0, version: v?.version ?? null, problems };
    },

    async run(o: InvocationOpts): Promise<RunResult> {
      const inv = cleanInvocation(o);
      inv.cmd = (await resolveClaude(exec))?.cmd ?? inv.cmd;
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
      const ok = out.is_error === false && subtype === "success";
      return {
        ok,
        text: String(out.result ?? ""),
        costUsd: typeof out.total_cost_usd === "number" ? out.total_cost_usd : null,
        tokens: tokens || null,
        durationMs: Number(out.duration_ms ?? durationMs),
        capped,
        error: ok ? undefined : runError(out),
      };
    },
  };
}

/**
 * Claude's own words for a failed run. The subtype says "success" even when is_error is true
 * (for example "Not logged in · Please run /login"), so the result text comes first.
 */
export function runError(out: any): string {
  const said = String(out.result ?? "").trim();
  const reason = String(out.terminal_reason ?? out.subtype ?? "").trim();
  const text = said ? `${said}${reason && reason !== "success" ? ` (${reason})` : ""}` : reason && reason !== "success" ? reason : "Claude Code reported an error";
  return /not logged in|\/login/i.test(said) ? `${text}. PMX's own Claude profile isn't signed in: ${LOGIN_HINT}` : text.slice(0, 2000);
}
