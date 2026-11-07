# Product Git

**Max out your product team's performance.** Product Git turns every customer call, Slack thread and ticket into sized work in Linear and puts each PM's AI agent on the highest-value task it can finish. You review. *PMX (product maxxing)* is the practice: keep your team's agent budget working on the backlog, paced by human review.

This repo is the product: the `pmx` CLI and engine, the skills and the PMX repo conventions. The website lives in `productgit-website`, and the hosted app is a separate, closed-source service.

## Install (macOS)

The easy way: open Claude Code and say *"Install PMX following https://github.com/kp-prodgit/productgit/blob/main/INSTALL.md"*. Claude checks your Mac, installs the release package, walks you through `pmx init` and checks the result. Switch auto mode off first; the guide asks you to.

By hand, with Node 22.12 or later (24 recommended: `brew install node`):

```bash
curl -fsSLO https://github.com/kp-prodgit/productgit/releases/download/v0.10.0/productgit-0.10.0.tgz
curl -fsSLO https://github.com/kp-prodgit/productgit/releases/download/v0.10.0/SHA256SUMS
shasum -a 256 -c SHA256SUMS
npm install -g ./productgit-0.10.0.tgz
pmx init
```

The release package is prebuilt and has no dependencies, so installing it downloads and builds nothing. Joining a team that already uses PMX? Clone its PMX repo and install the team's copy instead: `npm install -g <repo>/.pmx/cli/productgit.tgz`. Use Homebrew's Node rather than nvm: the background job remembers Node's path, and nvm switching or removing a version breaks it.

`pmx init` explains the PMX repo, checks every answer (and asks again if one is wrong), shows a summary, and saves nothing until you confirm. Then it sets up or joins your team's PMX repo, stores tokens in the keychain, writes a clean run profile and registers one background job. Then:

```bash
pmx doctor        # green/red checklist, including every clean-profile check (--json for scripts)
pmx claude login  # sign in PMX's own Claude profile, which agent runs use
pmx digest        # this week's digest from your transcripts, approved before it's committed
```

The skills also install as a Claude Code plugin: `/plugin marketplace add kp-prodgit/productgit`.

## Commands

| Command | What it does |
|---|---|
| `init` | Set up this Mac: PMX repo, clean profile, skills, keychain, background job |
| `doctor` | Checklist; fails if any clean-profile check is missing; `--json` for install scripts and Claude |
| `digest` | Weekly digest from allowlisted sources, every claim cited, approved before commit |
| `status` | Config, kill switch, spend and recent runs |
| `flow` | Where data went: meetings read and held, tasks, Linear issues, agent runs, skills and spend, with the privacy audit. `--web` opens it on this Mac; `--team` shows the shared run log; `--install-skill` adds `/pmx-flow`, which publishes it as a live Claude artifact |
| `whats-new` | What changed in this pmx, or `--since <version>`; PMX also shows it once after every update (`--json` for Claude) |
| `never-ingest` | Your do-not-read list; `add --title`, `--person` or `--channel` adds an entry and says what it would have held |
| `mcp` | The read-only local server the `/pmx-flow` artifact reads through; `--install` registers it with the Claude desktop app |
| `claude` | PMX's own Claude profile, which agent runs use: `login` signs it in |
| `explain` | How a run decided: what was found, used, left out, cut and masked, which skills and model ran, why each task got its size, and the cost. `--web` opens a local page |
| `skills` | The Claude skills PMX can use, what each does, when it runs, and whether your team's copy differs from the built-in one |
| `linear` | How PMX reaches Linear: through your Claude app's Linear connector by default (`status`); `key` stores an API key instead (advanced) |
| `board` | The team board as a live Claude artifact (only when you use Claude and Linear): the link, `--open`, and `--install-skill` for `/pmx-board`, which publishes it from inside the Claude app |
| `schedule` | The scheduled tasks PMX needs in your Claude app and whether each is set up and current; `--install-skill` adds `/pmx-schedule`, which creates or updates them from inside the Claude app; `--allow` lets them run `pmx` without stopping for permission |
| `collect` | Meeting transcripts from your Claude connectors (Granola, Fireflies…): `--prompt` prints the scheduled task's instructions, `--check` validates what it saved |
| `todo` | Your own to-dos from your meetings, including 1:1s; never leaves your Mac. `--refresh` reads today's unread meetings, `done <id>` checks one off |
| `synthesize` | Today's unprocessed team meetings (and Slack) → sized tasks in the Linear PMX inbox; each meeting is lodged in Linear and marked done so it's never processed twice |
| `company` | Roll teams' PMX tasks up into company-level themes; reads tasks, never transcripts |
| `pull` | Claim the best ready task that fits budget, hours and the review cap, and run it (dry run in week one) |
| `claim` / `release` | Claim a specific task; give one back; `--stale` releases expired claims |
| `verify-record` | CI check: every output PR carries a clean run record |
| `vendor` | Put this CLI's package in the PMX repo, so teammates and CI install the same version; `--require` makes it the team minimum, `--auto-update` installs it on every machine by itself |
| `update` | Install your team's version from the PMX repo; `--check` only compares; `--latest` installs the newest public release (for the team lead) |
| `neutrality` | Run skill fixtures in a clean profile; `--compare` two machines' reports |
| `review` | Accept, reject or redo-with-note in the terminal, or `--web` for a local review page; `--stats` for accept rates |
| `login` | Sign in to the free hosted app; creates your team's free org if there isn't one |
| `canvas` | Open the team board: the Claude board if there is one, else the hosted app (free) |
| `analytics` | What this machine sends to your hosted org; `--show` prints the pending events, `on` / `off` |
| `brain` | Team plan: assess the board and suggest, queue or (on autopilot) take the next actions, each with a reason; `--review` approves what's waiting, `--why` explains the last pass |
| `policy` / `license` | Team plan (`ee/`): show the applied admin policy, show or refresh the license |
| `tick` | One scheduler pass (launchd runs it every 30 minutes) |
| `uninstall` | Remove the job, profile, keychain items and `~/.pmx` |

## Linear and your Claude app

PMX reaches Linear **through your Claude app** by default, with no API key or sign-in: a scheduled task uses the Linear connector in your Claude app to apply the exact changes PMX queued and bring back the PMX project. PMX checks every result and keeps all the rules in its own code; Claude only carries the changes. Changes reach Linear at the next sync (hourly on weekdays), not instantly. `pmx linear status` shows when it last synced.

Advanced: `pmx linear key` stores a Linear API key in the keychain, and PMX then talks to Linear directly. The company roll-up needs one, because it reads several projects. Teams on the hosted app use its Linear connection.

### PMX's scheduled tasks

PMX can't create tasks in your Claude app itself, but Claude can. `pmx init` offers to add a `/pmx-schedule` command to your Claude app (or run `pmx schedule --install-skill`). Open the Claude desktop app (Code tab), start a session **with auto mode off** (auto mode can deny the scheduled-tasks tool without saying why), and type `/pmx-schedule`. Claude creates the tasks this machine needs (meeting collection, and the Linear sync), or updates ones with an older prompt. Then click "Run now" on each task once and approve what it asks.

- **Permissions.** A scheduled run stops at any permission prompt nobody answers, and blocks that task's later runs. `pmx init` offers, and `pmx schedule --allow` adds, always-allow rules for PMX's own command and folder (`Bash(pmx *)`, `Read(~/.pmx/**)`, `Edit(~/.pmx/**)`) to your Claude settings. Connectors still ask once, on the first "Run now".
- **This Mac only.** The tasks call `pmx` and write to `~/.pmx`, so they can't run in the cloud.
- **When they run.** Times are your Mac's local time. Tasks run while the Claude app is open and the Mac is awake; a run missed while the app was closed happens once when it opens again.
- **Where to see them.** Claude app → Code tab → Scheduled → the task → Runs. `pmx schedule` and `pmx doctor` say which tasks are missing or out of date, when each last ran, and which ones haven't run or didn't finish. A run that waits for an approval blocks that task's later runs: open it and choose "Always allow".

### The board inside Claude

When your team uses Linear and Claude, `pmx init` also adds `/pmx-board` (or run `pmx board --install-skill`). Type it in the Claude desktop app and Claude publishes the team board as a live artifact in your Claude account: pool → ready → in flight → review → done, read from the PMX project through each viewer's own Linear connector. Everyone works inside Claude, with no hosted app or API key. The board moves cards between the pool and Ready when someone clicks; everything else stays in PMX.

Share it from the artifact's Share menu, then add `"board": { "url": "<link>" }` to `pmx.config.json` in a PR, so every teammate's `pmx canvas` opens the same board. Each viewer allows Linear for the board once.

## Updating

Your team's PMX repo holds the CLI package everyone installs (`.pmx/cli/productgit.tgz`), so a team moves to a new version together.

- **The team lead:** run `pmx update --latest` (it installs the newest release after checking its SHA256SUMS), then `pmx vendor --require` and merge that PR. It stores the new package and makes it the team's minimum version.
- **Automatically:** add `--auto-update` (`pmx vendor --require --auto-update`) and every machine's background job installs the team's version within the hour, with no Claude usage and even when the Claude app is closed. It never downgrades. Where npm's global folder needs `sudo` (Node installed as root), PMX can't type the password, so it tells the PM once to run `pmx update`; installing Node with Homebrew avoids that.
- **Everyone else, or by hand:** run `pmx update`. It pulls the PMX repo and installs the team's version. `pmx doctor` says when you're behind.
- **If you don't update:** your digest, to-dos and `pmx explain` keep working, but shared team work (suggesting tasks, pulling, the brain, the company roll-up) stops with a message until you do. That way an old version never writes something the rest of the team's versions would misread.
- **What never breaks within a major version:** shared files and Linear labels only gain things; a file written by a newer pmx is refused, not misread; every release is tested against files older releases wrote; and the hosted API only adds to `/v1`. Details in [docs/control-plane-api.md](docs/control-plane-api.md) ("Versions").

## Free and paid

| Free (Apache-2.0, plus the free hosted app) | Team plan |
|---|---|
| The CLI, digest, task suggestions, pull, review and every local page | Team analytics: accept rates, cycle time, spend, digest and suggestion volume, brain activity |
| The hosted board, invites, admin policy and the Linear broker | The brain: suggests, queues or (on autopilot, within the admin's limits) takes the next actions on the board |
| Content-free analytics events, after you sign in and see what's sent | Cloud leases and the signed license |

The brain runs on one of your team's machines on your own Claude plan, so task text never reaches Product Git. Fixed rules decide what it may do, every action gets a tracker comment saying why, and it can never approve an agent's draft.

## How it keeps work neutral and personal data out

- **Clean run profile (B1).** Every run uses `~/.pmx/claude`, `--setting-sources project`, auto memory off, `--strict-mcp-config` with no servers, claude.ai connectors and sync off, reads and writes limited to the repo, the sandbox on and permissions never skipped.
- **Personal-content filter (B2).** Default-deny sources, no DMs, calls only with an external participant, fixed rules that hold back 1:1, performance, pay and health content, and a personal never-ingest list. Held material is discarded, never stored.
- **Nothing in git until approved (B3).** Digests are staged in `~/.pmx/staging` and committed only after the PM approves.
- **Shared team memory (B4).** `memory/` in the PMX repo, loaded through the project `CLAUDE.md`, changed only by code-owner-reviewed PR.
- **Atomic claims.** A claim is a parentless commit pushed to `refs/pmx/claims/<task>`; only one push can win.
- **Provable runs (B5, NEUT-3).** Each output PR carries `.pmx/runs/<task>.json`. CI recomputes the environment fingerprint from the repo and rejects records that don't match.
- **See where data went (FLOW-1 to FLOW-7).** `pmx flow --web` shows every meeting read or held, the tasks, Linear issues, agent runs, skills and spend, with an audit that checks held meetings against Linear and fake confidential "canary" meetings that every run must hold. The `/pmx-flow` artifact shows the same in Claude, with held meetings by rule only.
- **Explainable runs (PRIV-4).** Every digest and synthesis run leaves a receipt in `~/.pmx/receipts` (owner-only, 14 days, never in git). `pmx explain` shows it; left-out text is never stored, and file names and lines are found again in your own folders on screen.
- **Meetings, once.** A scheduled task in your Claude app copies transcripts from your meeting connectors; PMX's own runs never get connectors. Team meetings are claimed and lodged in Linear, then marked done with the tasks they produced, so no meeting is processed twice. Your own to-dos may come from 1:1s, but stay on your Mac.
- **Content-free analytics (PRIV-5).** Only after `pmx login`, and only IDs, sizes, outcomes, counts and cost. `pmx analytics --show` prints exactly what's waiting; `pmx analytics off` stops it.
- **Audit.** The run log is `runs/YYYY-MM.jsonl` on the `pmx/runlog` branch, hash-chained per agent and checked by `pmx doctor`.

## Develop

Node 24 (`.nvmrc`); CI also checks the oldest supported Node, 22.12.

```bash
git clone https://github.com/kp-prodgit/productgit.git && cd productgit
npm ci            # npm ci, not npm install, so package-lock.json never changes under you
npm test
npm run build && node dist/src/cli.js --help
```

Releases: bump the version in `package.json`, `.claude-plugin/plugin.json` and `INSTALL.md`, then push a `v<version>` tag. The release workflow tests, packs and publishes the package with its SHA256SUMS.

## Contributing

Issues and pull requests are welcome. Run `npm test` before opening a PR. Requirement IDs in comments
(for example `PRIV-4` or `BRAIN-3`) name the product rule a piece of code implements.

The CLI ↔ hosted app contract is in [docs/control-plane-api.md](docs/control-plane-api.md).

## License

Everything outside `ee/` is [Apache-2.0](LICENSE). `ee/` is source-visible under the
[Product Git Commercial License](ee/LICENSE) and needs a Team plan to use.
