import type { TeamConfig } from "../core/config.js";
import type { Keychain } from "../core/keychain.js";

/**
 * How this machine reaches Linear, in the order PMX tries them (LINEAR-1, LINEAR-2). The Claude relay is
 * the default: no key or sign-in. A key is an advanced option (the company roll-up needs one); Linear
 * sign-in stays for the few who already signed in, but isn't offered while Product Git's Linear app isn't registered.
 */
export type LinearAccess = "none" | "key" | "signed-in" | "hosted" | "relay";

export async function linearAccess(team: TeamConfig | null, keychain: Keychain): Promise<LinearAccess> {
  if (team?.tracker.kind !== "linear") return "none";
  if (await keychain.get("linear-token")) return "key";
  if (await keychain.get("linear-oauth")) return "signed-in";
  if (team.controlPlane) return "hosted";
  return "relay";
}
