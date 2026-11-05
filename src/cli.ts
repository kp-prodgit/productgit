#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ttyAsker } from "./core/ask.js";
import { loadPersonalConfig, loadTeamConfig, type PersonalConfig, type TeamConfig } from "./core/config.js";
import { consoleOut, makeCtx, type Ctx } from "./core/context.js";
import { exec } from "./core/exec.js";
import { macKeychain } from "./core/keychain.js";
import { macLaunchd } from "./core/launchd.js";
import { packageRoot } from "./core/skills.js";
import { claudeCode } from "./runtime/claude-code.js";
import { refusingRuntime } from "./runtime/refusing.js";
import { effectiveTeam } from "./core/services.js";
import { writeProfile } from "./core/profile.js";
import { commands as core } from "./commands/index.js";
import { registerEe } from "../ee/src/index.js";

const commands = [...core, ...registerEe()];

const HELP = `pmx: Product Git

Usage: pmx <command> [options]

Commands:
${commands.map((c) => `  ${c.name.padEnd(14)} ${c.summary}`).join("\n")}

Run \`pmx <command> --help\` for options. Docs: https://productgit.com`;

export async function realCtx(): Promise<Ctx> {
  const personal: PersonalConfig = await loadPersonalConfig();
  const eff = await effectiveTeam(await loadTeamConfig(personal.repoPath), personal);
  const team: TeamConfig = eff.team;
  // Keep the clean profile in step with team config and admin policy (model, egress).
  await writeProfile(team);
  return makeCtx({
    team, personal, runtime: eff.blockRuns ? refusingRuntime(eff.blockRuns) : claudeCode(), keychain: macKeychain(), launchd: macLaunchd(),
    fetch, exec, now: () => new Date(), out: consoleOut,
  });
}

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "-h" || name === "help") {
    console.log(HELP);
    return 0;
  }
  if (name === "--version" || name === "-v") {
    const pkg = JSON.parse(await readFile(`${packageRoot()}/package.json`, "utf8"));
    console.log(pkg.version);
    return 0;
  }
  const cmd = commands.find((c) => c.name === name);
  if (!cmd) {
    console.error(`Unknown command "${name}".\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parseArgs({ args: rest, options: { ...cmd.options, help: { type: "boolean", short: "h" } }, allowPositionals: true, strict: true });
  if (values.help) {
    console.log(`pmx ${cmd.name}: ${cmd.summary}\n\n${cmd.usage ?? ""}`);
    return 0;
  }
  return cmd.run({
    values: values as Record<string, any>,
    positionals,
    ask: ttyAsker((values as Record<string, unknown>).yes === true ? true : undefined),
    ctx: realCtx,
    cliPath: fileURLToPath(import.meta.url),
  });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`pmx: ${e?.message ?? e}`);
    process.exit(1);
  },
);
