import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { SignalItem } from "../core/types.js";

/** Text transcripts only. Audio recordings are never ingested (SEC-8: recording ingestion off). */
const TEXT_EXT = new Set([".md", ".txt", ".vtt", ".srt"]);

export interface ParsedTranscript {
  title: string;
  date: string | null;
  participants: string[];
  body: string;
}

const splitList = (s: string) =>
  s.replace(/^\[|\]$/g, "").split(/[,;]/).map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);

export function parseTranscript(raw: string, fallbackTitle: string): ParsedTranscript {
  let title = fallbackTitle;
  let date: string | null = null;
  let participants: string[] = [];
  let body = raw.replace(/^﻿/, "");

  const fm = body.match(/^---\n([\s\S]*?)\n---\n?/);
  const header = fm ? fm[1]! : body.split(/\n\s*\n/, 1)[0] ?? "";
  const fields = new Map<string, string>();
  for (const line of header.split("\n")) {
    const m = line.match(/^\s*(title|date|participants|attendees)\s*:\s*(.+)$/i);
    if (m) fields.set(m[1]!.toLowerCase(), m[2]!.trim());
  }
  if (fields.size) {
    title = fields.get("title") ?? title;
    date = fields.get("date") ?? null;
    participants = splitList(fields.get("participants") ?? fields.get("attendees") ?? "");
    body = fm ? body.slice(fm[0].length) : body.slice(header.length);
  }
  // WebVTT/SRT cue numbers and timestamps carry no meaning for synthesis.
  body = body
    .replace(/^WEBVTT.*$/m, "")
    .replace(/^\d+\s*$/gm, "")
    .replace(/^\d{2}:\d{2}:\d{2}[.,]\d{3} --> .*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title: title.replace(/^["']|["']$/g, ""), date, participants, body };
}

export interface TranscriptOpts {
  dirs: string[];
  sinceMs: number;
  idPrefix?: string;
}

/** Reads transcript files from the PM's allowlisted folders only (SIG-1, B2). No recursion into other folders. */
export async function readTranscripts(o: TranscriptOpts): Promise<SignalItem[]> {
  const items: SignalItem[] = [];
  let n = 0;
  for (const dir of o.dirs.map((d) => resolve(d))) {
    let names: string[] = [];
    try {
      names = (await readdir(dir)).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (!TEXT_EXT.has(extname(name).toLowerCase()) || name.startsWith(".")) continue;
      const path = join(dir, name);
      const s = await stat(path);
      if (!s.isFile() || s.mtimeMs < o.sinceMs) continue;
      const p = parseTranscript(await readFile(path, "utf8"), basename(name, extname(name)));
      items.push({
        id: `${o.idPrefix ?? "T"}${++n}`,
        kind: "transcript",
        ref: path,
        title: p.title,
        at: p.date ?? new Date(s.mtimeMs).toISOString().slice(0, 10),
        participants: p.participants,
        text: p.body,
      });
    }
  }
  return items;
}
