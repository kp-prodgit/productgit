# Changelog

Versions follow [semantic versioning](https://semver.org): new features raise the minor number, fixes the patch number, and anything that breaks an older CLI, file or team the major number. See "Updating" in the README.

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
