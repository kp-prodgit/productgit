# Product Git

**Max out your product team's performance.** Product Git turns every customer call, Slack thread and ticket into sized work in Linear and puts each PM's AI agent on the highest-value task it can finish. You review. *PMX (product maxxing)* is the practice: keep your team's agent budget working on the backlog, paced by human review.

This repo is the product: the `pmx` CLI and engine, the skills and the PMX repo conventions. The website lives in `productgit-website`, and the hosted app is a separate, closed-source service.

## Install (macOS)

Until the package is on npm, install from a packaged build:

```bash
npm pack                                # in this repo: builds and writes productgit-<version>.tgz
npm install -g ./productgit-*.tgz
pmx init
```

`pmx init` puts the same package in a new team's PMX repo at `.pmx/cli/productgit.tgz`, so teammates install it from their checkout (`npm install -g ./.pmx/cli/productgit.tgz`) without access to this repo, and the run-record CI check uses the same build. After upgrading, run `pmx vendor` and commit the new package in a PR of its own.

`pmx init` detects Claude Code, sets up or joins your team's PMX repo, stores tokens in the keychain, writes a clean run profile and registers one background job. Then:

```bash
pmx doctor        # green/red checklist, including every clean-profile check
pmx digest        # this week's digest from your transcripts, approved before it's committed
```

The skills also install as a Claude Code plugin: `/plugin marketplace add kp-prodgit/productgit`.

## Commands

| Command | What it does |
|---|---|
| `init` | Set up this Mac: PMX repo, clean profile, skills, keychain, background job |
| `doctor` | Checklist; fails if any clean-profile check is missing |
| `digest` | Weekly digest from allowlisted sources, every claim cited, approved before commit |
| `status` | Config, kill switch, spend and recent runs |
| `explain` | How a run decided: what was found, used, left out, cut and masked, which skills and model ran, why each task got its size, and the cost. `--web` opens a local page |
| `skills` | The Claude skills PMX can use, what each does, when it runs, and whether your team's copy differs from the built-in one |
| `collect` | Meeting transcripts from your Claude connectors (Granola, Fireflies…): `--prompt` prints the scheduled task's instructions, `--check` validates what it saved |
| `todo` | Your own to-dos from your meetings, including 1:1s; never leaves your Mac. `--refresh` reads today's unread meetings, `done <id>` checks one off |
| `synthesize` | Today's unprocessed team meetings (and Slack) → sized tasks in the Linear PMX inbox; each meeting is lodged in Linear and marked done so it's never processed twice |
| `company` | Roll teams' PMX tasks up into company-level themes; reads tasks, never transcripts |
| `pull` | Claim the best ready task that fits budget, hours and the review cap, and run it (dry run in week one) |
| `claim` / `release` | Claim a specific task; give one back; `--stale` releases expired claims |
| `verify-record` | CI check: every output PR carries a clean run record |
| `vendor` | Put this CLI's package in the PMX repo, so teammates and CI install the same version; `--require` makes it the team minimum, `--auto-update` installs it on every machine by itself |
| `update` | Install your team's version from the PMX repo; `--check` only compares |
| `neutrality` | Run skill fixtures in a clean profile; `--compare` two machines' reports |
| `review` | Accept, reject or redo-with-note in the terminal, or `--web` for a local review page; `--stats` for accept rates |
| `login` | Sign in to the free hosted app; creates your team's free org if there isn't one |
| `canvas` | Open the team board in the browser (free) |
| `analytics` | What this machine sends to your hosted org; `--show` prints the pending events, `on` / `off` |
| `brain` | Team plan: assess the board and suggest, queue or (on autopilot) take the next actions, each with a reason; `--review` approves what's waiting, `--why` explains the last pass |
| `policy` / `license` | Team plan (`ee/`): show the applied admin policy, show or refresh the license |
| `tick` | One scheduler pass (launchd runs it every 30 minutes) |
| `uninstall` | Remove the job, profile, keychain items and `~/.pmx` |

## Updating

Your team's PMX repo holds the CLI package everyone installs (`.pmx/cli/productgit.tgz`), so a team moves to a new version together.

- **The team lead:** after installing a new release, run `pmx vendor --require` and merge that PR. It stores the new package and makes it the team's minimum version.
- **Automatically:** add `--auto-update` (`pmx vendor --require --auto-update`) and every machine's background job installs the team's version within the hour, with no Claude usage and even when the Claude app is closed. It never downgrades. Where npm's global folder needs `sudo` (Node installed as root), PMX can't type the password, so it tells the PM once to run `pmx update`; installing Node with Homebrew or nvm avoids that.
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
- **Explainable runs (PRIV-4).** Every digest and synthesis run leaves a receipt in `~/.pmx/receipts` (owner-only, 14 days, never in git). `pmx explain` shows it; left-out text is never stored, and file names and lines are found again in your own folders on screen.
- **Meetings, once.** A scheduled task in your Claude app copies transcripts from your meeting connectors; PMX's own runs never get connectors. Team meetings are claimed and lodged in Linear, then marked done with the tasks they produced, so no meeting is processed twice. Your own to-dos may come from 1:1s, but stay on your Mac.
- **Content-free analytics (PRIV-5).** Only after `pmx login`, and only IDs, sizes, outcomes, counts and cost. `pmx analytics --show` prints exactly what's waiting; `pmx analytics off` stops it.
- **Audit.** The run log is `runs/YYYY-MM.jsonl` on the `pmx/runlog` branch, hash-chained per agent and checked by `pmx doctor`.

## Develop

```bash
npm install
npm test
npm run build && node dist/src/cli.js --help
```

## Contributing

Issues and pull requests are welcome. Run `npm test` before opening a PR. Requirement IDs in comments
(for example `PRIV-4` or `BRAIN-3`) name the product rule a piece of code implements.

The CLI ↔ hosted app contract is in [docs/control-plane-api.md](docs/control-plane-api.md).

## License

Everything outside `ee/` is [Apache-2.0](LICENSE). `ee/` is source-visible under the
[Product Git Commercial License](ee/LICENSE) and needs a Team plan to use.
