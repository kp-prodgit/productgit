import { exec } from "./exec.js";

/** A macOS notification. Silent in tests (PMX_NO_NOTIFY). */
export async function notify(title: string, message: string): Promise<void> {
  if (process.env.PMX_NO_NOTIFY) return;
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  await exec("osascript", ["-e", `display notification "${esc(message)}" with title "${esc(title)}"`]);
}
