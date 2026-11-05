/**
 * Every claim links to its evidence (SIG-3). A claim line is a bullet or numbered item.
 * Lines whose citations are missing or point at sources that don't exist are removed,
 * and the count is reported, so a reviewer never sees an unsupported claim.
 */

const CITE = /\[((?:[A-Z]\d+)(?:\s*,\s*[A-Z]\d+)*)\]/g;
const CLAIM = /^\s*(?:[-*+]|\d+[.)])\s+/;

export function citedIds(line: string): string[] {
  const ids: string[] = [];
  for (const m of line.matchAll(CITE)) ids.push(...m[1]!.split(/\s*,\s*/));
  return ids;
}

export interface CitationCheck {
  text: string;
  claims: number;
  removed: number;
  used: string[];
}

export function enforceCitations(markdown: string, validIds: Set<string>): CitationCheck {
  const out: string[] = [];
  const used = new Set<string>();
  let claims = 0;
  let removed = 0;
  for (const line of markdown.split("\n")) {
    if (!CLAIM.test(line)) {
      out.push(line);
      continue;
    }
    claims++;
    const ids = citedIds(line);
    if (ids.length === 0 || ids.some((id) => !validIds.has(id))) {
      removed++;
      continue;
    }
    ids.forEach((id) => used.add(id));
    out.push(line);
  }
  return { text: out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n", claims, removed, used: [...used].sort(natural) };
}

export function natural(a: string, b: string): number {
  return a[0] === b[0] ? Number(a.slice(1)) - Number(b.slice(1)) : a.localeCompare(b);
}
