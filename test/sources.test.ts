import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSlack } from "../src/sources/slack.js";
import { parseTranscript, readTranscripts } from "../src/sources/transcripts.js";
import { tmp, writeTranscript } from "./helpers.js";

describe("transcripts (SIG-1)", () => {
  it("parses frontmatter and header styles and strips VTT cues", () => {
    const a = parseTranscript("---\ntitle: Acme call\ndate: 2026-11-02\nparticipants: [jane@acme.com, kp@us.com]\n---\nJane: hi", "f");
    expect(a).toMatchObject({ title: "Acme call", date: "2026-11-02", participants: ["jane@acme.com", "kp@us.com"], body: "Jane: hi" });
    const b = parseTranscript("Title: Globex\nAttendees: a@g.com; b@us.com\n\nWEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nA: hello", "f");
    expect(b).toMatchObject({ title: "Globex", participants: ["a@g.com", "b@us.com"], body: "A: hello" });
    expect(parseTranscript("just text", "fallback").title).toBe("fallback");
  });

  it("reads only text files in allowlisted folders, newer than the window, never audio", async () => {
    const d = await tmp();
    await writeTranscript(d, "a.md", "Title: A\n\nx");
    await writeTranscript(d, "b.m4a", "audio");
    const old = await writeTranscript(d, "old.txt", "Title: Old\n\ny");
    await utimes(old, new Date("2020-01-01"), new Date("2020-01-01"));
    await writeTranscript(join(d, "sub"), "nested.md", "Title: N\n\nz");
    const items = await readTranscripts({ dirs: [d], sinceMs: Date.now() - 86400000 });
    expect(items.map((i) => i.title)).toEqual(["A"]);
    expect(items[0]!.id).toBe("T1");
  });
});

function fakeSlack(info: object, pages: object[][]): typeof fetch {
  let page = 0;
  return (async (url: string) => {
    const u = new URL(url);
    const body =
      u.pathname.endsWith("conversations.info")
        ? { ok: true, channel: { name: "feedback", ...info } }
        : { ok: true, messages: pages[page], response_metadata: { next_cursor: ++page < pages.length ? "c" : "" } };
    return new Response(JSON.stringify(body));
  }) as any;
}

describe("slack (SIG-1, B2)", () => {
  const base = { token: "t", allowedChannels: ["C1"], allowPrivate: false, sinceMs: 0 };

  it("refuses DMs, unlisted channels and private channels without opt-in", async () => {
    await expect(readSlack({ ...base, channel: "D1" })).rejects.toThrow(/DMs are never ingested/);
    await expect(readSlack({ ...base, channel: "C2", fetch: fakeSlack({}, [[]]) })).rejects.toThrow(/not on the team allowlist/);
    await expect(readSlack({ ...base, channel: "C1", fetch: fakeSlack({ is_im: true }, [[]]) })).rejects.toThrow(/DMs/);
    await expect(readSlack({ ...base, channel: "C1", fetch: fakeSlack({ is_private: true }, [[]]) })).rejects.toThrow(/private/);
  });

  it("pages through history oldest first and skips joins", async () => {
    const f = fakeSlack({}, [
      [{ ts: "1700000003.0001", user: "U1", text: "third" }, { ts: "1700000002.0001", subtype: "channel_join", text: "joined" }],
      [{ ts: "1700000001.0001", user: "U2", text: "first" }],
    ]);
    const items = await readSlack({ ...base, channel: "C1", fetch: f });
    expect(items.map((i) => [i.id, i.text])).toEqual([["S1", "first"], ["S2", "third"]]);
    expect(items[0]!.ref).toBe("https://slack.com/archives/C1/p17000000010001");
  });
});
