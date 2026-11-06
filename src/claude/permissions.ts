import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeAppHome } from "./skill.js";

/**
 * Always-allow rules for PMX's scheduled tasks (CLAUDE-3). A scheduled run stalls on any permission prompt
 * nobody answers, and blocks every later run of that task. Allow rules in the PM's ~/.claude/settings.json
 * also apply to scheduled sessions, so PMX adds rules for its own command and its own folder, and only with
 * the PM's consent. Connector tools (Linear, meetings) still ask once, on the first "Run now".
 */
export const ALLOW_RULES = ["Bash(pmx *)", "Read(~/.pmx/**)", "Edit(~/.pmx/**)"] as const;

export const claudeSettingsFile = () => join(claudeAppHome(), "settings.json");

async function readSettings(): Promise<{ settings: any; error?: string }> {
  const raw = await readFile(claudeSettingsFile(), "utf8").catch(() => null);
  if (raw === null || !raw.trim()) return { settings: {} };
  try {
    const settings = JSON.parse(raw);
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return { settings: null, error: "isn't a JSON object" };
    return { settings };
  } catch {
    return { settings: null, error: "isn't valid JSON" };
  }
}

/** Rules from ALLOW_RULES that aren't in the PM's settings yet. */
export async function missingAllowRules(): Promise<string[]> {
  const { settings } = await readSettings();
  const have = new Set<string>(Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : []);
  return ALLOW_RULES.filter((r) => !have.has(r));
}

/** Adds the missing rules and keeps everything else in the file. Never rewrites a file it can't parse. */
export async function addAllowRules(): Promise<{ added: string[]; error?: string }> {
  const { settings, error } = await readSettings();
  if (error) return { added: [], error: `${claudeSettingsFile()} ${error}, so PMX left it alone. Add these to permissions.allow yourself: ${ALLOW_RULES.join(", ")}` };
  const perms = settings.permissions && typeof settings.permissions === "object" ? settings.permissions : (settings.permissions = {});
  const allow: string[] = Array.isArray(perms.allow) ? perms.allow : (perms.allow = []);
  const added = ALLOW_RULES.filter((r) => !allow.includes(r));
  if (!added.length) return { added };
  allow.push(...added);
  await mkdir(claudeAppHome(), { recursive: true });
  await writeFile(claudeSettingsFile(), JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  return { added };
}
