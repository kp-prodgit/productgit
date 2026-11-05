import type { Keychain } from "../core/keychain.js";
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
    const headers: Record<string, string> = { accept: "application/json" };
    if (auth) {
      const token = await this.keychain.get("machine-token");
      if (!token) throw new CloudError(401, "unauthorized", "Not signed in to Product Git. Run `pmx login`.");
      headers.authorization = `Bearer ${token}`;
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await this.f(`${this.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new CloudError(res.status, data?.error ?? "error", `${method} ${path}: ${data?.message ?? data?.error ?? res.status}`, data);
    return data as T;
  }
}
