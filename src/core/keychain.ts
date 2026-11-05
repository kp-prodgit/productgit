import { exec as defaultExec, type Exec } from "./exec.js";
import { KEYCHAIN_SERVICE } from "./paths.js";

/** Secret names Product Git stores. Values live only in the macOS keychain (SEC-10). */
export type SecretName = "slack-token" | "linear-token" | "github-token" | "machine-token" | "anthropic-api-key";

export interface Keychain {
  get(name: SecretName): Promise<string | null>;
  set(name: SecretName, value: string): Promise<void>;
  delete(name: SecretName): Promise<void>;
  list(): Promise<SecretName[]>;
}

const ALL: SecretName[] = ["slack-token", "linear-token", "github-token", "machine-token", "anthropic-api-key"];

export function macKeychain(exec: Exec = defaultExec): Keychain {
  return {
    async get(name) {
      const r = await exec("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"]);
      return r.code === 0 ? r.stdout.replace(/\n$/, "") : null;
    },
    async set(name, value) {
      // -U updates in place. The value is passed as an argument to `security`, never written to disk.
      const r = await exec("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", name, "-w", value]);
      if (r.code !== 0) throw new Error(`keychain: could not store ${name}: ${r.stderr.trim()}`);
    },
    async delete(name) {
      await exec("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name]);
    },
    async list() {
      const found: SecretName[] = [];
      for (const n of ALL) if ((await this.get(n)) !== null) found.push(n);
      return found;
    },
  };
}

/** In-memory keychain for tests. */
export function memoryKeychain(initial: Partial<Record<SecretName, string>> = {}): Keychain {
  const m = new Map<SecretName, string>(Object.entries(initial) as [SecretName, string][]);
  return {
    async get(n) { return m.get(n) ?? null; },
    async set(n, v) { m.set(n, v); },
    async delete(n) { m.delete(n); },
    async list() { return [...m.keys()]; },
  };
}
