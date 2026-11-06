import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Keychain } from "../core/keychain.js";
import type { Fetch } from "../sources/slack.js";

/**
 * `pmx linear login` (LINEAR-1): Linear's OAuth with PKCE, as a public client, so there's no API key to
 * create and no client secret to ship. Product Git's Linear app is registered once by Product Git; its
 * client ID is public. A team can use its own app with `PMX_LINEAR_CLIENT_ID`.
 */
export const LINEAR_CLIENT_ID = "";
export const LINEAR_REDIRECT_PORT = 47621;
export const LINEAR_REDIRECT = `http://localhost:${LINEAR_REDIRECT_PORT}/callback`;
export const LINEAR_SCOPES = "read,write";
const AUTHORIZE = "https://linear.app/oauth/authorize";
const TOKEN = "https://api.linear.app/oauth/token";
const REVOKE = "https://api.linear.app/oauth/revoke";

/** What the keychain holds under `linear-oauth`. Access lasts 24 hours; each refresh returns a new refresh token. */
export interface LinearGrant {
  access: string;
  refresh: string;
  expiresAt: string;
  clientId: string;
  /** Who signed in, for `pmx linear status`. */
  user: string | null;
}

export function linearClientId(): string | null {
  return process.env.PMX_LINEAR_CLIENT_ID || LINEAR_CLIENT_ID || null;
}

const b64url = (b: Buffer) => b.toString("base64url");

async function tokenRequest(f: Fetch, body: Record<string, string>): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const res = await f(TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
  const data: any = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) throw new Error(`Linear sign-in failed: ${data?.error_description ?? data?.error ?? `HTTP ${res.status}`}`);
  return data;
}

function grantFrom(t: { access_token: string; refresh_token: string; expires_in: number }, clientId: string, user: string | null, now: Date): LinearGrant {
  return { access: t.access_token, refresh: t.refresh_token, expiresAt: new Date(now.getTime() + t.expires_in * 1000).toISOString(), clientId, user };
}

export async function readGrant(kc: Keychain): Promise<LinearGrant | null> {
  const raw = await kc.get("linear-oauth");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LinearGrant;
  } catch {
    return null;
  }
}

/** A valid access token, refreshed when under 5 minutes remain. Null if this PM never signed in. */
export async function linearAccessToken(kc: Keychain, f: Fetch, now = new Date()): Promise<string | null> {
  const g = await readGrant(kc);
  if (!g) return null;
  if (Date.parse(g.expiresAt) - now.getTime() > 5 * 60000) return g.access;
  const t = await tokenRequest(f, { grant_type: "refresh_token", refresh_token: g.refresh, client_id: g.clientId });
  const fresh = grantFrom(t, g.clientId, g.user, now);
  await kc.set("linear-oauth", JSON.stringify(fresh));
  return fresh.access;
}

/** Listens on both loopback addresses, never on the network, for exactly one callback. */
async function listen(port: number, onRequest: Parameters<typeof createServer>[1]): Promise<Server[]> {
  const servers: Server[] = [];
  for (const host of ["127.0.0.1", "::1"]) {
    const s = createServer(onRequest!);
    const ok = await new Promise<boolean>((resolve) => {
      s.once("error", () => resolve(false));
      s.listen(port, host, () => resolve(true));
    });
    if (ok) servers.push(s);
  }
  if (!servers.length) throw new Error(`Port ${port} is in use, so the Linear sign-in can't receive its callback. Close what's using it and try again.`);
  return servers;
}

export interface LinearLoginOpts {
  keychain: Keychain;
  open: (url: string) => Promise<void>;
  fetch?: Fetch;
  clientId?: string;
  port?: number;
  now?: () => Date;
  timeoutMs?: number;
}

/** The browser flow: authorize on linear.app, the code comes back to localhost, the grant goes to the keychain. */
export async function linearLogin(o: LinearLoginOpts): Promise<LinearGrant> {
  const clientId = o.clientId ?? linearClientId();
  if (!clientId) throw new Error("Linear sign-in isn't available. PMX reaches Linear through your Claude app by default (`pmx linear status`); for a direct connection, store an API key with `pmx linear key`.");
  const f = o.fetch ?? fetch;
  const port = o.port ?? LINEAR_REDIRECT_PORT;
  const redirect = `http://localhost:${port}/callback`;
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(24));

  let finish!: (r: { code: string } | Error) => void;
  const done = new Promise<{ code: string } | Error>((resolve) => (finish = resolve));
  const servers = await listen(port, (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/callback") return void res.writeHead(404).end();
    const given = Buffer.from(url.searchParams.get("state") ?? "");
    const okState = given.length === state.length && timingSafeEqual(given, Buffer.from(state));
    const code = url.searchParams.get("code");
    if (!okState || !code) {
      res.writeHead(400, { "content-type": "text/plain" }).end("Linear sign-in failed. Run `pmx linear login` again.");
      return finish(new Error(url.searchParams.get("error_description") ?? "Linear sign-in failed: the browser returned an unexpected state."));
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end('<!doctype html><title>Linear connected</title><body style="font:16px system-ui;padding:48px">Product Git can now use Linear. You can close this tab.</body>');
    finish({ code });
  });
  const timer = setTimeout(() => finish(new Error("Timed out waiting for the Linear sign-in.")), o.timeoutMs ?? 5 * 60000);
  try {
    const params = new URLSearchParams({
      client_id: clientId, redirect_uri: redirect, response_type: "code", scope: LINEAR_SCOPES, state,
      code_challenge: challenge, code_challenge_method: "S256", prompt: "consent",
    });
    await o.open(`${AUTHORIZE}?${params}`);
    const r = await done;
    if (r instanceof Error) throw r;
    const t = await tokenRequest(f, { grant_type: "authorization_code", code: r.code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier });
    const me = await f("https://api.linear.app/graphql", {
      method: "POST", headers: { authorization: `Bearer ${t.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: "{ viewer { name email } }" }),
    }).then((x) => x.json()).catch(() => null) as any;
    const user = me?.data?.viewer ? `${me.data.viewer.name} <${me.data.viewer.email}>` : null;
    const grant = grantFrom(t, clientId, user, (o.now ?? (() => new Date()))());
    await o.keychain.set("linear-oauth", JSON.stringify(grant));
    return grant;
  } finally {
    clearTimeout(timer);
    for (const s of servers) s.close();
  }
}

/** `pmx linear logout`: revokes the grant at Linear, then forgets it. */
export async function linearLogout(kc: Keychain, f: Fetch = fetch): Promise<boolean> {
  const g = await readGrant(kc);
  if (!g) return false;
  await f(REVOKE, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: g.refresh, token_type_hint: "refresh_token" }).toString() }).catch(() => null);
  await kc.delete("linear-oauth");
  return true;
}
