import type { Keychain } from "../core/keychain.js";
import { updateState } from "../core/state.js";
import { currentVersion, UPDATE_HINT } from "../core/version.js";
import type { Fetch } from "../sources/slack.js";

export const DEFAULT_CONTROL_PLANE = "https://api.productgit.com/v1";

export class CloudError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly body: any = null) {
    super(message);
  }
}

/** Client for the hosted app's API (docs/05-control-plane-api.md). Free and paid plans share it. Sends IDs and counts only (SCOPE-8). */
export class Cloud {
  constructor(readonly url: string, private readonly keychain: Keychain, private readonly f: Fetch = fetch) {}

  async call<T = any>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    // The version handshake (COMPAT-5): the server may refuse a CLI below its minimum with 426.
    const headers: Record<string, string> = { accept: "application/json", "x-pmx-version": currentVersion() };
    if (auth) {
      const token = await this.keychain.get("machine-token");
      if (!token) throw new CloudError(401, "unauthorized", "Not signed in to Product Git. Run `pmx login`.");
      headers.authorization = `Bearer ${token}`;
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await this.f(`${this.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    const latest = res.headers?.get?.("x-pmx-latest-version") ?? null;
    const min = res.headers?.get?.("x-pmx-min-version") ?? null;
    if (latest || min) await updateState((st) => (st.cloudVersions = { latest, min, seenAt: new Date().toISOString() })).catch(() => {});
    if (res.status === 426)
      throw new CloudError(426, "cli_too_old", `Product Git needs pmx ${data?.min ?? "a newer version"} or newer; this is ${currentVersion()}. ${UPDATE_HINT}`, data);
    if (!res.ok) throw new CloudError(res.status, data?.error ?? "error", `${method} ${path}: ${data?.message ?? data?.error ?? res.status}`, data);
    return data as T;
  }
}
