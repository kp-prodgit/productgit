// Product Git Commercial License. See ee/LICENSE.
import { createPublicKey, verify, type JsonWebKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readJson, writeJson, writeText } from "../../src/core/fsutil.js";
import { paths } from "../../src/core/paths.js";
import type { Cloud } from "../../src/cloud/client.js";
import { join } from "node:path";
import { packageRoot } from "../../src/core/skills.js";

export interface LicenseClaims {
  iss: string;
  sub: string;
  aud: string;
  plan: "team" | "enterprise" | "pilot";
  seats: number;
  features: string[];
  iat: number;
  exp: number;
}

export const ISSUER = "https://api.productgit.com";
const jwksPath = () => join(paths.home(), "jwks.json");

/**
 * The production signing key, pinned in the package at release (`make license-pubkey` in
 * productgit-cloud prints it). When present it is used instead of a fetched JWKS, so a license
 * can't be forged by whoever controls the network.
 */
async function pinnedJwks(): Promise<{ keys: JsonWebKey[] } | null> {
  return readJson(join(packageRoot(), "ee", "keys", "jwks.json"));
}

/**
 * Verifies an ES256 license JWT offline against a JWKS (header `kid` picks the key).
 * Throws with a plain reason on any problem.
 */
export function verifyLicense(jwt: string, jwks: { keys: (JsonWebKey & { kid?: string })[] }, now: Date, orgId?: string): LicenseClaims {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("license is not a JWT");
  const [h, p, s] = parts as [string, string, string];
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  if (header.alg !== "ES256") throw new Error(`license uses ${header.alg}, expected ES256`);
  const jwk = jwks.keys.find((k) => k.kid === header.kid) ?? (jwks.keys.length === 1 ? jwks.keys[0] : undefined);
  if (!jwk) throw new Error("license was signed by an unknown key");
  const key = createPublicKey({ key: jwk, format: "jwk" });
  const ok = verify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  if (!ok) throw new Error("license signature is invalid");
  const c = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as LicenseClaims;
  if (c.iss !== ISSUER) throw new Error(`license issuer ${c.iss} is not ${ISSUER}`);
  if (c.aud !== "pmx-cli") throw new Error("license audience is not pmx-cli");
  if (orgId && c.sub !== orgId) throw new Error(`license is for ${c.sub}, not ${orgId}`);
  if (c.exp * 1000 <= now.getTime()) throw new Error(`license expired on ${new Date(c.exp * 1000).toISOString().slice(0, 10)}`);
  return c;
}

/** Fetches a fresh license when there's none or it expires within 7 days. Keeps the cached JWKS current. */
export async function refreshLicense(cloud: Cloud, orgId: string, now: Date): Promise<LicenseClaims> {
  const pinned = await pinnedJwks();
  let jwks = pinned ?? (await readJson<{ keys: JsonWebKey[] }>(jwksPath()));
  const cached = await readFile(paths.license(), "utf8").catch(() => null);
  if (cached && jwks) {
    try {
      const c = verifyLicense(cached.trim(), jwks, now, orgId);
      if (c.exp * 1000 - now.getTime() > 7 * 86400000) return c;
    } catch {}
  }
  if (!pinned) {
    jwks = await cloud.call("GET", "/.well-known/jwks.json", undefined, false);
    await writeJson(jwksPath(), jwks, 0o644);
  }
  const { jwt } = await cloud.call<{ jwt: string }>("GET", `/orgs/${orgId}/license`);
  const claims = verifyLicense(jwt, jwks!, now, orgId);
  await writeText(paths.license(), jwt + "\n", 0o600);
  return claims;
}

/** The current license from disk, without network. Null if missing or invalid. */
export async function currentLicense(now: Date, orgId?: string): Promise<{ claims: LicenseClaims | null; problem: string | null }> {
  const jwt = await readFile(paths.license(), "utf8").catch(() => null);
  const jwks = (await pinnedJwks()) ?? (await readJson<{ keys: JsonWebKey[] }>(jwksPath()));
  if (!jwt || !jwks) return { claims: null, problem: "no license on this machine (run `pmx login`)" };
  try {
    return { claims: verifyLicense(jwt.trim(), jwks, now, orgId), problem: null };
  } catch (e: any) {
    return { claims: null, problem: e.message };
  }
}
