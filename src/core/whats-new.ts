import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Exec } from "./exec.js";
import { paths } from "./paths.js";
import { loadState, updateState } from "./state.js";
import { compareVersions, currentVersion } from "./version.js";

/**
 * What's new, per release (NEW-1). Every version PMX ships has an entry here; a test fails the build without
 * one, so no feature reaches users unannounced. Each item says what changed in the PM's terms and, where
 * there is one, the command to try. Newest first. CHANGELOG.md keeps the full detail.
 */
export interface ReleaseNote {
  version: string;
  date: string;
  headline: string;
  items: { what: string; try?: string }[];
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "0.13.0", date: "2026-11-07", headline: "No more working hours",
    items: [
      { what: "PMX works whenever this Mac is on and awake, within your daily spend cap. `pmx init` no longer asks for working days or hours, and hours you saved before are ignored: nothing to change." },
      { what: "The README's Updating section says exactly how to update each kind of existing machine.", try: "pmx update" },
    ],
  },
  {
    version: "0.12.0", date: "2026-11-07", headline: "PMX tells you what's new after every update",
    items: [
      { what: "After an update, the first pmx command shows what changed since your last version, once. Claude Code sees it too when it runs the update.", try: "pmx whats-new" },
      { what: "`pmx update` prints what's new as soon as it installs, and the update notification names the headline." },
    ],
  },
  {
    version: "0.11.0", date: "2026-11-07", headline: "See where your data went",
    items: [
      { what: "A flow view of every meeting PMX read or held, the tasks it proposed, the Linear issues they became, agent runs, skills and spend. Click anything to trace its path.", try: "pmx flow --web" },
      { what: "An audit that checks no held meeting reached Linear, and fake confidential \"canary\" meetings every run must hold. `pmx doctor` fails if one gets through." },
      { what: "The same view as a live Claude artifact that reads your Mac.", try: "pmx mcp --install, then pmx flow --install-skill, then /pmx-flow in the Claude app" },
      { what: "Add a meeting title, person or channel to your do-not-read list, with a preview of what it would have held.", try: "pmx never-ingest add --title \"…\"" },
      { what: "PMX's own Claude profile now signs in with `pmx claude login`; `pmx login` is the hosted-app sign-in again." },
    ],
  },
  {
    version: "0.10.1", date: "2026-11-06", headline: "Runs that fail say why",
    items: [
      { what: "A failed run shows Claude's own error, and PMX's Claude profile has its own sign-in.", try: "pmx claude login" },
      { what: "The background job finds Claude Code wherever your shell does; run `pmx init` again to re-register an older job." },
      { what: "`pmx status` and `pmx doctor` show the background job's last pass and each scheduled task's last run.", try: "pmx schedule" },
    ],
  },
  {
    version: "0.10.0", date: "2026-11-06", headline: "A solo install that works",
    items: [
      { what: "A prebuilt release with checksums, and an install guide Claude Code follows (INSTALL.md)." },
      { what: "`pmx init` checks every answer and shows a summary before saving anything." },
      { what: "`pmx doctor --json` for scripts and Claude; `pmx update --latest` installs the newest release.", try: "pmx doctor" },
    ],
  },
];

const newer = (a: string, b: string) => (compareVersions(a, b) ?? 0) > 0;

/** Notes for versions after `after` up to and including `upTo`, newest first. `after` null means just `upTo`'s own. */
export function notesBetween(after: string | null, upTo = currentVersion()): ReleaseNote[] {
  return RELEASE_NOTES.filter((n) => !newer(n.version, upTo) && (after ? newer(n.version, after) : n.version === upTo));
}

export function formatNotes(notes: ReleaseNote[]): string {
  if (!notes.length) return "Nothing new.";
  return notes.map((n) => [`What's new in pmx ${n.version}: ${n.headline}`, ...n.items.map((i) => `  • ${i.what}${i.try ? `\n    Try: ${i.try}` : ""}`)].join("\n")).join("\n\n");
}

/** Called just before an install replaces this pmx: the new one shows what changed since this version. */
export async function markUpdatingFrom(version = currentVersion()): Promise<void> {
  await updateState((s) => {
    const since = s.whatsNew?.since;
    s.whatsNew = { seen: s.whatsNew?.seen ?? null, since: since && newer(version, since) ? since : version };
  }).catch(() => {});
}

/** A fresh install starts up to date: nothing to announce. */
export async function markSeen(version = currentVersion()): Promise<void> {
  await updateState((s) => (s.whatsNew = { seen: version, since: null })).catch(() => {});
}

/**
 * What this Mac hasn't been told yet. After an update through PMX it knows the old version. After a manual
 * install over a pmx from before 0.12.0 it doesn't, so it covers releases since this Mac was set up, at most
 * the last three. Before `pmx init` there's nothing to announce.
 */
export async function pendingNotes(o: { installedAt?: string | null } = {}): Promise<ReleaseNote[]> {
  const s = await loadState();
  const from = s.whatsNew?.since ?? s.whatsNew?.seen ?? null;
  if (from) return notesBetween(from);
  if (!(await stat(paths.config()).then(() => true, () => false))) return [];
  const since = o.installedAt ?? null;
  return RELEASE_NOTES.filter((n) => !newer(n.version, currentVersion()) && (!since || n.date >= since.slice(0, 10))).slice(0, 3);
}

/** Commands that never show the notes: machine protocols, the background job, and the ones that handle it themselves. */
export const QUIET_COMMANDS = new Set(["tick", "mcp", "whats-new", "uninstall"]);

/** Shows pending notes once, on stderr so JSON on stdout stays clean, then marks them seen. Never throws. */
export async function announceOnce(write: (s: string) => void, o: { installedAt?: string | null } = {}): Promise<void> {
  try {
    const notes = await pendingNotes(o);
    if (notes.length) write(`${formatNotes(notes)}\n\nSee this again with \`pmx whats-new\`.\n`);
    if (notes.length || (await stat(paths.config()).then(() => true, () => false))) await markSeen();
  } catch {}
}

/**
 * Asks the pmx that was just installed what's new since `from`. The running process is the old version and
 * doesn't know the new notes; the new one is in npm's global bin. Null when it can't be asked.
 */
export async function newVersionNotes(exec: Exec, from: string): Promise<string | null> {
  const prefix = (await exec("npm", ["prefix", "-g"], { timeoutMs: 30000 })).stdout.trim();
  if (!prefix) return null;
  const r = await exec(join(prefix, "bin", "pmx"), ["whats-new", "--since", from], { timeoutMs: 30000 });
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}
