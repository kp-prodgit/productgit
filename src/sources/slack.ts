import type { SignalItem } from "../core/types.js";

export type Fetch = typeof fetch;

export interface SlackOpts {
  token: string;
  channel: string;
  /** Team-approved channels (default-deny, B2). */
  allowedChannels: string[];
  allowPrivate: boolean;
  sinceMs: number;
  idPrefix?: string;
  fetch?: Fetch;
}

async function call(f: Fetch, token: string, method: string, params: Record<string, string>): Promise<any> {
  const res = await f(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body: any = await res.json();
  if (!body.ok) throw new Error(`Slack ${method}: ${body.error ?? res.status}`);
  return body;
}

/**
 * Reads one allowlisted Slack channel with a read-only token (SEC-4).
 * DMs and group DMs are always refused. Private channels only if the team opted in (B2).
 */
export async function readSlack(o: SlackOpts): Promise<SignalItem[]> {
  const f = o.fetch ?? fetch;
  if (/^D/.test(o.channel)) throw new Error("Slack DMs are never ingested (PRIV-2).");
  if (!o.allowedChannels.includes(o.channel)) throw new Error(`Slack channel ${o.channel} is not on the team allowlist.`);

  const info = (await call(f, o.token, "conversations.info", { channel: o.channel })).channel;
  if (info.is_im || info.is_mpim) throw new Error("Slack DMs are never ingested (PRIV-2).");
  if (info.is_private && !o.allowPrivate) throw new Error(`#${info.name} is private and the team has not opted in to private channels.`);

  const items: SignalItem[] = [];
  let cursor: string | undefined;
  let n = 0;
  do {
    const params: Record<string, string> = { channel: o.channel, oldest: String(o.sinceMs / 1000), limit: "200" };
    if (cursor) params.cursor = cursor;
    const page = await call(f, o.token, "conversations.history", params);
    for (const m of page.messages ?? []) {
      if (m.subtype && m.subtype !== "thread_broadcast") continue;
      if (!m.text?.trim()) continue;
      items.push({
        id: `${o.idPrefix ?? "S"}${++n}`,
        kind: "slack",
        ref: `https://slack.com/archives/${o.channel}/p${String(m.ts).replace(".", "")}`,
        title: `#${info.name}`,
        at: new Date(Number(m.ts) * 1000).toISOString(),
        participants: m.user ? [m.user] : [],
        text: m.text,
      });
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return items.reverse().map((it, i) => ({ ...it, id: `${o.idPrefix ?? "S"}${i + 1}` }));
}

/** Sends the PM their own digest as a DM (DIG-2, optional). Needs `chat:write`. */
export async function sendSlackDm(o: { token: string; userId: string; text: string; fetch?: Fetch }): Promise<void> {
  const f = o.fetch ?? fetch;
  const res = await f("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: o.userId, text: o.text, unfurl_links: false }),
  });
  const body: any = await res.json();
  if (!body.ok) throw new Error(`Slack chat.postMessage: ${body.error}`);
}
