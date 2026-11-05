import { readFile } from "node:fs/promises";
import type { Ctx } from "../core/context.js";
import { filterItems, type FilterResult } from "../core/filter.js";
import { makeRedactor } from "../core/redact.js";
import { sourceReceipts, topicRulesHash, type RunReceipt } from "../core/receipt.js";
import type { SignalItem } from "../core/types.js";
import { readSlack } from "../sources/slack.js";
import { readTranscripts } from "../sources/transcripts.js";
import { meetingKeys } from "../meetings/ledger.js";

export interface Gathered {
  items: SignalItem[];
  held: FilterResult["held"];
  heldItems: number;
  read: number;
  /** The parts of the run receipt that gathering decides (PRIV-4). */
  receipt: Pick<RunReceipt, "window" | "rules" | "skippedSources" | "sources" | "masked">;
}

/**
 * Reads allowlisted sources, screens out personal content (B2) and redacts PII (SEC-8).
 * Nothing here is written to disk: held material is dropped in memory.
 *
 * `scope` "personal" reads the PM's own folders (digest). "team" adds team-approved channels (synthesis, M3).
 * "individual" reads the PM's own folders for their private to-dos (TODO-2): internal meetings and 1:1s
 * are allowed there, because nothing it produces leaves the Mac.
 */
export async function gather(ctx: Ctx, o: { days: number; scope: "personal" | "team" | "individual" }): Promise<Gathered> {
  const { team, personal } = ctx;
  const sinceMs = ctx.now().getTime() - o.days * 86400000;
  const raw: SignalItem[] = [];
  const skippedSources: string[] = [];

  if (!team.allowedSources.includes("transcripts")) skippedSources.push("Transcripts: not allowed in team config (allowedSources)");
  else if (!personal.sources.transcriptDirs.length) skippedSources.push("Transcripts: no folder set up (run `pmx init`)");
  if (team.allowedSources.includes("transcripts") && personal.sources.transcriptDirs.length) {
    raw.push(...(await readTranscripts({ dirs: personal.sources.transcriptDirs, sinceMs, idPrefix: "T" })));
  }

  if (team.allowedSources.includes("slack")) {
    const channels = o.scope === "team" ? team.slackChannels : personal.sources.slackChannel ? [personal.sources.slackChannel] : [];
    const token = channels.length ? await ctx.keychain.get("slack-token") : null;
    if (channels.length && !token) {
      ctx.out.warn("Slack is configured but no Slack token is in the keychain. Skipping Slack.");
      skippedSources.push("Slack: no token in the keychain");
    }
    let n = 0;
    for (const channel of token ? channels : []) {
      const items = await readSlack({
        token: token!, channel, allowedChannels: team.slackChannels, allowPrivate: team.allowPrivateChannels,
        sinceMs, fetch: ctx.fetch, idPrefix: "S",
      });
      raw.push(...items.map((it) => ({ ...it, id: `S${++n}` })));
    }
  }

  // Meeting identities come from participants and IDs, so they're worked out before redaction (MEET-1).
  for (const it of raw) if (it.kind === "transcript") it.keys = meetingKeys(it);
  const individual = o.scope === "individual";
  const rules = { internalDomains: team.internalDomains, requireExternalParticipant: !individual, neverIngest: personal.neverIngest, allowOneOnOne: individual };
  const filtered = filterItems(raw, rules);

  const names = personal.crmNamesFile ? (await readFile(personal.crmNamesFile, "utf8").catch(() => "")).split("\n") : [];
  const r = makeRedactor(names);
  const items = filtered.kept.map((it) => ({ ...it, title: r.redact(it.title), text: r.redact(it.text), participants: [] }));
  // Titles of used sources are redacted with a separate redactor, so the masking counts cover only what the model saw.
  const titles = makeRedactor(names);
  return {
    items, held: filtered.held, heldItems: filtered.heldItems, read: raw.length,
    receipt: {
      window: { days: o.days, since: new Date(sinceMs).toISOString(), scope: o.scope },
      rules: {
        internalDomains: team.internalDomains, requireExternalParticipant: !individual, ...(individual ? { allowOneOnOne: true } : {}), topicRulesHash: topicRulesHash(),
        neverIngest: { people: personal.neverIngest.people.length, channels: personal.neverIngest.channels.length, meetingTitles: personal.neverIngest.meetingTitles.length },
        folders: team.allowedSources.includes("transcripts") ? personal.sources.transcriptDirs : [],
      },
      skippedSources,
      sources: sourceReceipts(filtered.decisions, (t) => titles.redact(t)),
      masked: { ...r.counts },
    },
  };
}
