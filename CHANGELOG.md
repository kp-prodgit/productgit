# Changelog

Versions follow [semantic versioning](https://semver.org): new features raise the minor number, fixes the patch number, and anything that breaks an older CLI, file or team the major number. See "Updating" in the README.

## 0.11.0: see where your data went

A flow view of everything PMX does, built from records it keeps. The goal is that you can check, rather than trust, that no confidential meeting reached Linear.

- **`pmx flow --web` (FLOW-1, FLOW-2).** A page on this Mac with six columns:
  - Arrivals: meetings and Slack threads, with their connector.
  - Checkpoint: what your rules held, and why.
  - Workshop: the runs, with the skill and version each used.
  - Tasks: proposed tasks, with size and reason.
  - Linear: the issues they became, and the meeting ledger.
  - Departures: agent runs, review verdicts, time and cost.

  The page also has:
  - **Trace:** click anything to light its path both ways.
  - **Lenses:** recolor by privacy, skills, cost or time.
  - **Run filter:** pick one run to see only its path.
  - **3D days:** stacks each day as a layer; turn the stack and pick a day.
  - **Spend:** shown against your daily cap, in USD. PMX can't read your Claude plan's usage.
  - **Held meetings:** shown by the file and title found again in your folders, on your screen only.

  `pmx flow` prints the same claims in Terminal.
- **The audit and its seal (FLOW-3).** "N held · 0 reached Linear", backed by checks you can open:
  - every held meeting's identity is compared against Linear's meeting ledger;
  - every task cites only sources that passed;
  - nothing queued for Linear carries a canary;
  - the run log's hash chain is intact.
- **Canaries (FLOW-3).** Every run tests fake confidential meetings against its own rules in memory: a 1:1, an internal-only meeting, pay, performance and health passages, and your own do-not-read entries. Each run records the result. `pmx doctor` fails if one gets through. Both Linear paths refuse anything carrying a canary.
- **A live Claude artifact (FLOW-4, FLOW-5).**
  - `pmx mcp` is a read-only local server; `pmx mcp --install` registers it with the Claude desktop app.
  - `/pmx-flow` publishes the same view as an artifact that reads PMX on the viewer's own Mac.
  - The server gives the artifact held meetings by rule and number only. Titles, files, hashes, details and to-do text stay on the Mac.
- **The team view (FLOW-7).** Pick "Team" to see the shared run log's runs, agent runs and verdicts, with no meeting content.
- **Edits that only tighten (FLOW-6).**
  - `pmx never-ingest add --title|--person|--channel`, and the artifact's "Stop reading meetings like this", add to your do-not-read list.
  - Before saving, they preview what the rule would have held in the last 14 days.
  - The edit log records only that a rule was added, never the entry.
  - Loosening a rule stays in Terminal.
- **Records that make the links real.**
  - Each task records the Linear issue it became, or the one it duplicated. Through the Claude relay, `PENDING-…` identifiers resolve after the next sync.
  - Receipts keep each source's connector and Slack channel, and held meetings' identity hashes.
  - The run log's synthesis and digest entries name their receipt.
  - Each day's cap is kept.
  - The collection task reports how many meetings it skipped before saving, as counts only.
  - Receipts are kept for the full 14 days at hourly runs.
- **The Linear sync and meeting collection write files with Claude's file tool**, not a shell command. A shell command stopped for an approval nobody saw.
- **Fix: `pmx login` signs in to the hosted app again.** In 0.10.1 the new profile sign-in took that name and hid it. PMX's own Claude profile now signs in with `pmx claude login`, and `pmx claude` shows whether it's signed in. A test now fails if two commands share a name.

## 0.10.1: runs that fail say so

Fixes from a tester's install on Node 22.2 with Claude Code installed by npm under nvm. Their background job failed every 30 minutes for over a day, and nothing showed it.

- **A failed run shows Claude's own error (RUN-ERR-1).** A run that wasn't signed in printed `Synthesis run failed: success`. Claude Code marks such a run as an error but its type stays "success", so PMX now shows Claude's message ("Not logged in · Please run /login") and the fix.
- **`pmx login` signs in PMX's own Claude profile.** Runs use their own profile in `~/.pmx/claude`, so your personal setup never loads, and that profile needs its own sign-in. `pmx init` offers it, doctor fails while the profile isn't signed in, and runs stop before they start instead of failing.
- **The background job finds Claude Code wherever your shell does.** `pmx init` saves the full path to Claude Code in the job and puts its folder on the job's PATH, so an npm install under nvm no longer fails with `spawn claude ENOENT`. Doctor fails when the job can't find Claude Code. Run `pmx init` again to fix a job registered by an older pmx.
- **A job that keeps failing shows (OBS-2).** `pmx status` shows the job's last pass, and doctor warns after three failed passes in a row, with the first error and the log's path.
- **"Set up" tasks that don't run show (CLAUDE-4).** `pmx schedule` and doctor show each task's last run. They warn when a run started and didn't finish, which usually means it waits for an approval nobody saw (the app skips later runs meanwhile), and when a task's scheduled time passed with no run. Runs from before this version left no record, so that clock starts at the update. `pmx schedule` also says where the task files are.
- **An unsupported Node stops the install,** with the steps in order: install Node 24 (Homebrew, or `nvm install 24 && nvm alias default 24`), open a new Terminal, install pmx again, run `pmx init`. Doctor gives the same steps.

## 0.10.0: a solo install that works

Fixes from a first-time install, so one PM can install PMX on a fresh Mac without help.

- **A prebuilt release package (INSTALL-1).** Each version tag publishes `productgit-<version>.tgz` and `SHA256SUMS` as a GitHub release on the public repo. The package has no dependencies, so installing it builds and downloads nothing: no `tsc: command not found`, no Node range warnings, no audit warnings.
- **`INSTALL.md`, written for Claude Code (INSTALL-2).** Say "Install PMX following …/INSTALL.md" and Claude asks you to switch auto mode off, checks the Mac, installs the package after checking its checksum, walks you through `pmx init`, reads `pmx doctor --json` and sets up the scheduled tasks.
- **`pmx init` checks every answer (INIT-1).** It explains what the PMX repo is. A command pasted into the wrong prompt, an invalid folder, URL, handle, category, time or amount is asked again, up to three times. A new working-days question accepts `Mon-Fri` or `Mon,Wed,Fri`. Working hours must be `HH:MM-HH:MM`, and the spend question says that 0 pauses the agent. A summary of every answer comes before anything is saved, and saying no saves nothing.
- **Security fix:** `pmx init` passes a git URL to `git clone` after `--`, so an answer like `--upload-pack=…` can't run a command.
- **`pmx doctor --json`** lists failed checks and warnings by id, for install scripts and Claude.
- **Doctor and runs find Claude Code in `~/.local/bin`** (and other installer folders) when it isn't on your shell's PATH.
- **Node 22.12 or later, or 24 or later** (`engines`, doctor, README). Node 24 from Homebrew is recommended. Doctor warns when Node runs from nvm or another version manager, because the background job breaks when that version is switched or removed.
- **`pmx update --latest`** installs the newest public release after checking its SHA256SUMS, so a team lead can update without building from source, then share it with `pmx vendor --require`.
- New PMX repos' run-record workflow falls back to the release package instead of npm, where PMX isn't published.
- Contributors: vitest 5 (no audit findings), `.nvmrc`, `npm ci`, and CI checks the oldest supported Node.

## 0.9.1: no false alarms, and scheduled runs that don't stall

Fixes from a first-time install.

- **`pmx doctor` checks Linear the way this Mac reaches it.** Going through Claude (the default) no longer fails "Linear token in the keychain". Doctor instead warns when the Claude sync is stale, is for the wrong project, or has changes failing. A Claude Pro or Max plan no longer warns either: PMX runs on your Claude subscription.
- **Doctor warns when the team package is older than this Mac.** Teammates who install or update would get the older version, so it tells the team lead to run `pmx vendor --require`.
- **Linear sign-in is hidden (LINEAR-1 deferred).** Product Git's Linear app isn't registered, so `pmx linear login` couldn't work. PMX reaches Linear through your Claude app by default. `pmx init` no longer asks for a Linear key, and `pmx linear key` stores one for advanced use (the company roll-up needs one). Anyone already signed in keeps working, and `pmx uninstall` now removes that sign-in too.
- **Scheduled runs don't stall (CLAUDE-3).** A run waiting on a permission prompt nobody answers blocked every later run. With your OK, `pmx init` and `pmx schedule --allow` add always-allow rules for PMX's own command and folder to your Claude settings. Doctor warns while they're missing.
- **`/pmx-schedule` updates tasks with an older prompt**, not just missing ones. It stops when run by a schedule, and asks you to turn auto mode off first. Task prompts now say never to create or change scheduled tasks. `pmx schedule` says the tasks run on this Mac only, in local time, while the Claude app is open, and where to see their runs.
- **`pmx init` ends with one "Next step" block**, printed after the doctor checklist.
- **The background job's logs are capped (OBS-1)** at 1 MB each, keeping one previous file.
- The lockfile matches `package.json` again, and CI checks that it stays that way, so `npm install` no longer blocks the next `git pull`.

## 0.9.0: the team board inside Claude

- **`/pmx-board` (BOARD-1).** The team board as a live Claude artifact: pool → ready → in flight → review → done, read from your Linear project through each viewer's own Linear connector, so it needs no hosted app, API key or sign-in. It moves cards between the pool and Ready (with category and size) when someone clicks; agents, runs and reviews stay in PMX. Offered only when PMX is used with Claude: `pmx init` adds `/pmx-board` beside `/pmx-schedule` when Claude is set up and the team uses Linear (or run `pmx board --install-skill`). Type it in the Claude app and Claude publishes the page PMX prepared, with exactly the Linear tools it needs.
- `pmx board` shows the board's link, `--open` opens it, `--json` / `--html` prepare the page, `--set-url` saves the link. A board committed in `pmx.config.json` (`board.url`) is the team's, so teammates open it instead of publishing their own.
- `pmx canvas` opens the Claude board when there is one. `pmx doctor` warns when it's missing or was published by an older pmx.
- Installed Claude commands (`/pmx-schedule`, `/pmx-board`) refresh themselves after a PMX update.

## 0.8.0: /pmx-schedule in your Claude app

- **`/pmx-schedule` (CLAUDE-2).** PMX can't reach the Claude app's scheduling tool, but Claude can from inside an app session. `pmx init` offers to add a `/pmx-schedule` skill to your personal Claude skills (or run `pmx schedule --install-skill`). Type it in the Claude app and Claude creates each scheduled task this machine is missing, exactly as PMX lists them (`pmx schedule --json`), with one approval. PMX refreshes its own copy and never overwrites a skill you wrote.
- `pmx schedule`, `pmx init` and `pmx doctor` point to `/pmx-schedule` once it's installed; the paste-in text stays as a fallback.
- Tests no longer touch the real `~/.claude` (`PMX_CLAUDE_HOME`).
- The Claude plugin's version now matches the CLI.
- Compatibility fixtures for relay files as 0.7.0 wrote them (COMPAT-4).

## 0.7.0: Linear without an API key, and Claude tasks you can see

- **`pmx linear login` (LINEAR-1).** Sign in to Linear in the browser (OAuth with PKCE, no client secret). The access lives in the keychain and renews itself every 24 hours. `pmx linear logout` revokes it; `pmx linear status` shows how this machine reaches Linear.
- **Claude relays Linear when there's no key or sign-in (LINEAR-2).** A scheduled task in the PM's Claude app uses their Linear connector: it applies the exact changes PMX queued (`~/.pmx/linear/outbox.json`), reports each result, and exports the PMX project as a snapshot PMX reads. PMX checks every result and snapshot, keeps every rule in its own code, and holds meeting claims for a day so the ledger stays safe between syncs.
- **`pmx schedule` (CLAUDE-1).** PMX can't create Claude tasks itself, so it lists the ones this machine needs, says whether each exists, and prints a request to paste into the Claude app. `pmx init` points to it, and `pmx doctor` warns about missing tasks.
- Compatibility fixtures for files as 0.6.0 wrote them (COMPAT-4).

## 0.6.0: automatic updates

- **Background auto-update (COMPAT-6).** When a team turns it on (`pmx vendor --require --auto-update`), every machine's background job checks hourly and installs the team's version from the PMX repo when it's newer. It never downgrades, and never replaces a source checkout. If npm needs `sudo`, PMX can't type a password, so it says so once per version, in a notification and in `pmx doctor`.
- `pmx update` and the background job share one installer.
- Compatibility fixtures for files as 0.5.0 wrote them (COMPAT-4).

## 0.5.0: explainable runs, free hosted app, brain, meetings from connectors, safe updates

Everything since 0.4.0, which shipped several times under that number:

- **Explainable runs (PRIV-4):** `pmx explain [--web]` and `pmx skills`: what each run read, left out, cut and masked, which skills ran, and why each task got its size.
- **Free hosted app (PLAN-1 to PLAN-4, PRIV-5):** `pmx login` signs in for free and creates the team's org; the board is free; content-free analytics start only after sign-in (`pmx analytics`).
- **The brain (BRAIN-1 to BRAIN-5, Team plan):** `pmx brain` proposes actions; fixed rules decide what's done, queued or only suggested; every action is commented and explained.
- **Meetings from Claude connectors (COLLECT, MEET, TODO, COMPANY):** `pmx collect`, a meeting ledger in Linear so no meeting is processed twice, private `pmx todo`, and `pmx company` roll-ups.
- **Safe updates (COMPAT-1 to COMPAT-5):** `pmx update`, `pmx vendor --require` for a team minimum version, files from a newer pmx are refused instead of misread, compatibility tests against what 0.4.0 wrote, and a version handshake with the hosted app.

## 0.4.0 (M5): control plane client, canvas and managed settings

Team-plan features in `ee/` (commercial license), against the API in `docs/control-plane-api.md`:

- `pmx login`: browser sign-in through the control plane; the machine token goes to the keychain. `init --invite` joins the org in the same browser trip.
- Admin policy (ADMIN-2): applied as an intersection with team config (categories, sources, egress, model, review cap). Runs stop on a disallowed model plan. Cached for an hour; fails closed after 7 days without the server.
- License (ADMIN-4): ES256 JWT verified offline, against a pinned production key once one ships.
- Cloud lease (`"lease": "cloud"`): DynamoDB conditional writes with fencing tokens.
- Linear OAuth broker (ADMIN-3): short-lived brokered token, so no personal Linear key.
- Content-free event sync (P7): run and verdict metadata only, checked against the server's strict schema.
- `pmx canvas` opens the hosted canvas (CANVAS-1..4, in `productgit-cloud`).
- Managed-settings template for device management (B7, ADMIN-5).

## 0.3.0 (M4): design-partner beta

- `pmx review`: terminal review queue with accept, reject and redo-with-note (REV-2). Accept merges the PR and marks the task done; reject blocks it with the reason; redo closes the PR, adds the note to the task and returns it to ready.
- `pmx review --web`: a review page on 127.0.0.1 with the rendered draft, citation hovercards showing the approved source quote, and the run record. Token-guarded, loopback Host only, strict CSP, all draft HTML escaped. Works at phone width.
- Verdicts go to the run log; `pmx review --stats` shows accept rate per category (MET-1).
- Auto-pause (REV-3, `ee/`): a category under 30% acceptance with at least 5 reviews in 30 days stops being pulled until `pmx review --unpause <category>`.
- `pmx doctor` suggests new size estimates from the run log (PULL-10).

## 0.2.0 (M3): team pull and atomic lease

- Linear adapter scoped to one PMX project, with label groups (`pmx-status`, `pmx-category`, `pmx-size`, `pmx-agent`) instead of custom fields. Writes outside the project are refused (SEC-4).
- `pmx synthesize`: team sources → candidate tasks with category, size, rationale and cited quotes, posted to the inbox only. No tools in the run (SEC-1). Triage stays human (SEC-2).
- `pmx pull`: budget provider (declared cap, ledger, override; team per-machine cap wins), working hours, review-queue cap (default 3), L/XL guard near the reset, dry-run explanations (default in week one).
- Git-ref lease (`refs/pmx/claims/<id>`): exactly one push wins; stale claims are released with the current token only.
- Run envelope: worktree per task, clean profile, file tools only, per-run spend cap, checklist, run record, PR, tracker comment and status.
- `pmx verify-record` + PMX repo workflow: PRs with outputs and no clean run record fail CI (B5).
- `pmx neutrality`: fixtures in a clean copy, reports comparable across machines (B6).
- Kill switch (`pmx.stop`) checked by every puller and every tick.

## 0.1.0 (M2): single-player digest and open-source skills

- `pmx init`: macOS setup. Detects Claude Code, sets up or joins a PMX repo, stores secrets in the keychain, writes the clean run profile and registers one launchd job.
- `pmx digest`: weekly digest from allowlisted transcript folders and one Slack channel. Personal content is held back (B2), PII is redacted (SEC-8), every claim is cited (SIG-3), and nothing is committed until the PM approves it (PRIV-3). Optional Slack DM.
- Clean run profile (B1): `~/.pmx/claude`, project-only settings, auto memory off, strict MCP config, claude.ai connectors and sync off, reads and writes limited to the repo, sandbox on, permissions never skipped.
- Shared team memory (B4): `memory/` in the PMX repo, loaded through the project `CLAUDE.md`, protected by CODEOWNERS.
- `pmx doctor`: green/red checklist with every clean-profile check and a model-plan warning.
- Run log: `runs/YYYY-MM.jsonl` on the `pmx/runlog` branch, hash-chained per agent.
- Skills pack: pmx-digest, pmx-synthesize, pmx-size, pmx-pull, pmx-research, pmx-competitive, pmx-hygiene, pmx-spec, each with fixtures and smoke tests. Installable as a Claude Code plugin.
- License: Apache-2.0, with team features under `ee/` (commercial).
