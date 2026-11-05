import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { exec as defaultExec, type Exec } from "./exec.js";
import { writeText } from "./fsutil.js";
import { LAUNCHD_LABEL, paths } from "./paths.js";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * One launchd job that runs `pmx tick` every 30 minutes (CLI-2). launchd doesn't read the shell
 * profile, so PATH must include ~/.local/bin, where the Claude Code installer puts `claude`.
 */
export function plist(opts: { node: string; cli: string; intervalSeconds?: number; pmxHome: string; home?: string }): string {
  const path = [join(opts.home ?? homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  const args = [opts.node, opts.cli, "tick"].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartInterval</key>
  <integer>${opts.intervalSeconds ?? 1800}</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PMX_HOME</key>
    <string>${xml(opts.pmxHome)}</string>
    <key>PATH</key>
    <string>${xml(path)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(join(opts.pmxHome, "logs", "tick.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(opts.pmxHome, "logs", "tick.err.log"))}</string>
</dict>
</plist>
`;
}

export interface Launchd {
  install(p: string): Promise<void>;
  uninstall(): Promise<void>;
  isLoaded(): Promise<boolean>;
}

export function macLaunchd(exec: Exec = defaultExec): Launchd {
  const domain = `gui/${process.getuid?.() ?? 501}`;
  return {
    async install(p) {
      await writeText(paths.launchAgent(), p);
      await exec("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
      const r = await exec("launchctl", ["bootstrap", domain, paths.launchAgent()]);
      if (r.code !== 0) throw new Error(`launchctl bootstrap failed: ${r.stderr.trim()}`);
    },
    async uninstall() {
      await exec("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
      await rm(paths.launchAgent(), { force: true });
    },
    async isLoaded() {
      return (await exec("launchctl", ["print", `${domain}/${LAUNCHD_LABEL}`])).code === 0;
    },
  };
}

export function fakeLaunchd(): Launchd & { plist: string | null } {
  const f = {
    plist: null as string | null,
    async install(p: string) { f.plist = p; },
    async uninstall() { f.plist = null; },
    async isLoaded() { return f.plist !== null; },
  };
  return f;
}
