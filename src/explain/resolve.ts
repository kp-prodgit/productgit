import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { passageHash, segments, TOPICS, type HoldReason } from "../core/filter.js";
import { refHash, type RunReceipt } from "../core/receipt.js";
import { parseTranscript } from "../sources/transcripts.js";

export interface LiveSource {
  /** File name and title, found again on this Mac. Shown on screen, never written anywhere. */
  file: string | null;
  title: string | null;
  cuts: { rule: HoldReason; line: number | null; matched: string | null }[];
}

const TEXT_EXT = new Set([".md", ".txt", ".vtt", ".srt"]);

/**
 * Finds a receipt's sources again in the PM's own transcript folders (PRIV-4). A receipt stores
 * only hashes for what was left out; this matches them against the files as they are now, so the
 * PM can see which file and which line a rule hit. Nothing it finds is stored.
 */
export async function resolveLive(r: RunReceipt, folders: string[]): Promise<LiveSource[]> {
  const byHash = new Map<string, string>();
  for (const dir of new Set([...r.rules.folders, ...folders])) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const n of names) {
      if (!TEXT_EXT.has(extname(n).toLowerCase()) || n.startsWith(".")) continue;
      const p = join(dir, n);
      if ((await stat(p).catch(() => null))?.isFile()) byHash.set(refHash(p), p);
    }
  }
  const out: LiveSource[] = [];
  for (const s of r.sources) {
    const path = s.kind === "transcript" ? byHash.get(s.refHash) : undefined;
    if (!path) {
      out.push({ file: null, title: null, cuts: s.passagesCut.map((c) => ({ rule: c.rule, line: null, matched: null })) });
      continue;
    }
    const raw = await readFile(path, "utf8").catch(() => "");
    const parsed = parseTranscript(raw, basename(path, extname(path)));
    const segs = new Map(segments(parsed.body).map((seg) => [passageHash(seg), seg]));
    const cuts = s.passagesCut.map((c) => {
      const seg = segs.get(c.hash);
      if (!seg) return { rule: c.rule, line: null, matched: null };
      const first = seg.trim().split("\n")[0]!;
      const at = raw.indexOf(first);
      const matched = c.rule in TOPICS ? (TOPICS[c.rule as keyof typeof TOPICS].exec(seg)?.[0] ?? null) : null;
      return { rule: c.rule, line: at < 0 ? null : raw.slice(0, at).split("\n").length, matched };
    });
    out.push({ file: basename(path), title: parsed.title, cuts });
  }
  return out;
}
