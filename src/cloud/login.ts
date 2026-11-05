import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Keychain } from "../core/keychain.js";

const APP = "https://app.productgit.com";

export interface LoginOpts {
  keychain: Keychain;
  label: string;
  /** Joins the org first when set (CLI-1 invite file). */
  inviteCode?: string;
  appUrl?: string;
  open: (url: string) => Promise<void>;
  timeoutMs?: number;
}

/**
 * `pmx login`: the browser signs in through Cognito and redirects a machine token back to a
 * one-shot listener on 127.0.0.1. The token goes straight to the keychain (SEC-10).
 */
export async function login(o: LoginOpts): Promise<void> {
  const state = randomBytes(24).toString("base64url");
  let finish!: (err?: Error) => void;
  const done = new Promise<void>((resolve, reject) => (finish = (e) => (e ? reject(e) : resolve())));
  // The callback can fail while the browser opener is still running; it's awaited below.
  done.catch(() => {});

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const given = Buffer.from(url.searchParams.get("state") ?? "");
    const token = url.searchParams.get("token") ?? "";
    const okState = given.length === state.length && timingSafeEqual(given, Buffer.from(state));
    if (!okState || !/^pmxm_[0-9A-Za-z]{40}$/.test(token)) {
      res.writeHead(400, { "content-type": "text/plain" }).end("Sign-in failed: state mismatch. Run `pmx login` again.");
      return finish(new Error("Sign-in failed: the browser returned an unexpected state or token."));
    }
    try {
      await o.keychain.set("machine-token", token);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>Signed in</title><body style=\"font:16px system-ui;padding:48px\">Signed in to Product Git. You can close this tab.</body>");
      finish();
    } catch (e: any) {
      res.writeHead(500).end();
      finish(e);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const params = new URLSearchParams({ port: String(port), state, label: o.label });
  if (o.inviteCode) params.set("invite", o.inviteCode);
  const timer = setTimeout(() => finish(new Error("Timed out waiting for the browser sign-in.")), o.timeoutMs ?? 5 * 60000);
  try {
    await o.open(`${o.appUrl ?? APP}/cli-login?${params}`);
    await done;
  } finally {
    clearTimeout(timer);
    server.close();
  }
}
