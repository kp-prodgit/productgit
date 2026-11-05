import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Ctx } from "../core/context.js";
import type { Services } from "../core/services.js";
import { renderMarkdown } from "./markdown.js";
import { decide, loadQueue, type ReviewItem, type Verdict } from "./queue.js";
import { PAGE } from "./page.js";

export interface ReviewServer {
  url: string;
  port: number;
  close(): Promise<void>;
  server: Server;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

async function body(req: IncomingMessage): Promise<any> {
  let s = "";
  for await (const c of req) {
    s += c;
    if (s.length > 64 * 1024) throw new Error("body too large");
  }
  return s ? JSON.parse(s) : {};
}

function view(item: ReviewItem) {
  return {
    id: item.task.id,
    identifier: item.task.identifier,
    title: item.task.title,
    url: item.task.url,
    category: item.task.category,
    size: item.task.size,
    prUrl: item.prUrl,
    record: item.record && {
      agent: item.record.agent, model: item.record.model, skill: `${item.record.skill.name}@${item.record.skill.version}`,
      minutes: Math.round(item.record.durationMs / 6000) / 10, costUsd: item.record.costUsd,
      cleanProfile: item.record.profile.checksFailed.length === 0, failedChecks: item.record.profile.checksFailed,
      checklistOk: item.record.checklist.ok, checklistProblems: item.record.checklist.problems,
    },
    files: item.files.map((f) => ({ path: f.path, html: f.path.endsWith(".md") ? renderMarkdown(f.content, item.citations) : `<pre><code>${f.content.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</code></pre>` })),
  };
}

/**
 * `pmx review --web`: a review page on 127.0.0.1 only (REV-2, P5). Every request needs the random
 * session token, and the Host header must be the loopback address, which blocks DNS-rebinding and
 * cross-site requests. Drafts are rendered with HTML escaped.
 */
export async function startReviewServer(ctx: Ctx, svc: Services, o: { all?: boolean; port?: number } = {}): Promise<ReviewServer> {
  const token = randomBytes(24).toString("base64url");
  let cache: Awaited<ReturnType<typeof loadQueue>> | null = null;
  const shownAt = new Map<string, number>();

  const authed = (req: IncomingMessage, port: number) => {
    if (req.headers.host !== `127.0.0.1:${port}`) return false;
    const given = String(req.headers["x-pmx-token"] ?? new URL(req.url ?? "/", "http://x").searchParams.get("t") ?? "");
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const server = createServer(async (req, res) => {
    const port = (server.address() as AddressInfo).port;
    try {
      if (!authed(req, port)) return json(res, 403, { error: "forbidden" });
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
          "referrer-policy": "no-referrer",
        });
        return res.end(PAGE.replace("__TOKEN__", token));
      }
      if (req.method === "GET" && url.pathname === "/api/queue") {
        cache = await loadQueue(ctx, svc, { all: o.all });
        for (const i of cache.items) if (!shownAt.has(i.task.id)) shownAt.set(i.task.id, Date.now());
        return json(res, 200, { reviewer: ctx.personal.handle, items: cache.items.map(view) });
      }
      const m = url.pathname.match(/^\/api\/items\/([^/]+)\/(accept|reject|redo)$/);
      if (req.method === "POST" && m) {
        if (req.headers["content-type"] !== "application/json") return json(res, 415, { error: "json only" });
        cache ??= await loadQueue(ctx, svc, { all: o.all });
        const item = cache.items.find((i) => i.task.id === decodeURIComponent(m[1]!));
        if (!item) return json(res, 404, { error: "not in your review queue" });
        const verdict: Verdict = m[2] === "accept" ? "accepted" : m[2] === "reject" ? "rejected" : "redo";
        const { note } = await body(req);
        const started = shownAt.get(item.task.id) ?? Date.now();
        const msg = await decide(ctx, svc, cache.host, item, verdict, { note, reviewMinutes: Math.max(1, Math.round((Date.now() - started) / 60000)) });
        cache.items = cache.items.filter((i) => i !== item);
        return json(res, 200, { ok: true, message: msg });
      }
      json(res, 404, { error: "not found" });
    } catch (e: any) {
      json(res, 400, { error: e.message });
    }
  });

  await new Promise<void>((resolve) => server.listen(o.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/?t=${token}`,
    port,
    server,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
