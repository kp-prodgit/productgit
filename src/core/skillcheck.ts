import { citedIds } from "./citations.js";
import { SIZES, type Size } from "./types.js";

export interface SkillMeta {
  kind: "core" | "category";
  category?: string;
  output?: string;
  requiredHeadings?: string[];
  minCitations?: number;
}

export function skillMeta(skillText: string): SkillMeta {
  const fm = skillText.match(/^---\n([\s\S]*?)\n---/);
  const line = fm?.[1]?.split("\n").find((l) => l.startsWith("pmx:"));
  if (!line) return { kind: "core" };
  return JSON.parse(line.slice(4).trim()) as SkillMeta;
}

export function skillName(skillText: string): string | null {
  return skillText.match(/^---\n[\s\S]*?^name:\s*(\S+)/m)?.[1] ?? null;
}

export interface OutputCheck {
  ok: boolean;
  problems: string[];
  citations: number;
}

/**
 * Checks a draft against the skill's machine-readable checklist: required headings, a minimum
 * number of citations, and no citation to a source the task didn't provide. Used by the smoke
 * test (SKILL-6), the neutrality test (B6) and every run before its PR opens.
 */
export function checkOutput(meta: SkillMeta, output: string, validIds?: Set<string>): OutputCheck {
  const problems: string[] = [];
  const headings = new Set([...output.matchAll(/^#{1,3}\s+(.+?)\s*$/gm)].map((m) => m[1]!.toLowerCase()));
  for (const h of meta.requiredHeadings ?? []) if (!headings.has(h.toLowerCase())) problems.push(`missing heading "${h}"`);
  const ids = output.split("\n").flatMap(citedIds);
  if (ids.length < (meta.minCitations ?? 0)) problems.push(`only ${ids.length} citations, need ${meta.minCitations}`);
  if (validIds) {
    const bad = [...new Set(ids.filter((i) => !validIds.has(i)))];
    if (bad.length) problems.push(`cites unknown sources: ${bad.join(", ")}`);
  }
  return { ok: problems.length === 0, problems, citations: ids.length };
}

/** Source IDs present in a task snapshot or fixture, e.g. `[T1]`, `id="S4"`. */
export function idsIn(text: string): Set<string> {
  const ids = new Set<string>();
  for (const m of text.matchAll(/\[([A-Z]\d+)\]|id="([A-Z]\d+)"/g)) ids.add((m[1] ?? m[2])!);
  return ids;
}

export interface SizeRubric {
  /** The per-category table: category → size → the cell's text. */
  cells: Record<string, Record<Size, string>>;
  /** Source-count ranges where a category's cells are countable: [min, max or null]. */
  ranges: Record<string, Partial<Record<Size, [number, number | null]>>>;
  /** The general rule per size, from the first table. */
  general: Record<Size, { run: string; rule: string }>;
}

/** Reads the `pmx-size` rubric, so sizes can be checked and explained (`pmx explain`). */
export function parseRubric(skillText: string): SizeRubric {
  const parts = skillText.split(/^## /m);
  const rows = (part = "") =>
    part.split("\n").filter((l) => l.startsWith("|") && !/^\|\s*-/.test(l)).slice(1).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
  const cells: SizeRubric["cells"] = {};
  for (const r of rows(parts.find((p) => p.startsWith("Per category")))) if (r.length === 5) cells[r[0]!] = Object.fromEntries(SIZES.map((s, i) => [s, r[i + 1]!])) as Record<Size, string>;
  const general = {} as SizeRubric["general"];
  for (const r of rows(parts[0])) if (r.length === 3 && (SIZES as readonly string[]).includes(r[0]!)) general[r[0] as Size] = { run: r[1]!, rule: r[2]! };
  const meta = skillMeta(skillText) as SkillMeta & { sourceRanges?: SizeRubric["ranges"] };
  return { cells, ranges: meta.sourceRanges ?? {}, general };
}
