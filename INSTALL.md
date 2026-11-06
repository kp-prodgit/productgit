# Install Product Git (pmx) on a Mac

This guide is written for **Claude Code** to follow on a PM's Mac. To use it, open Claude Code (the Claude desktop app's Code tab, or `claude` in Terminal) and say:

> Install PMX following https://github.com/kp-prodgit/productgit/blob/main/INSTALL.md

Version: **0.10.0**. Package: `productgit-0.10.0.tgz` from the [v0.10.0 release](https://github.com/kp-prodgit/productgit/releases/tag/v0.10.0).

---

## Instructions for Claude

Follow these steps in order. Report each step's result to the user in one line. Stop at the first step that fails, tell the user what failed and the fix below, and wait for them.

### Step 0: auto mode off

Before running anything, tell the user:

> Please switch auto mode off for this session (Shift+Tab until it no longer says auto mode, or pick another mode in the app's mode menu). In auto mode, some install steps get denied without a reason: installing a global npm package, writing to the keychain, registering the background job and creating scheduled tasks. I'll ask before each step instead. Tell me when it's off.

Wait until the user confirms. Do nothing else first.

### Step 1: check this Mac

Run each check and report pass or fail:

| Check | Command | Passes when |
|---|---|---|
| macOS | `uname -s` | prints `Darwin` |
| Node | `node -v` | 22.12 or later in the 22 line, or 24 and up |
| npm can install globally | `npm prefix -g`, then `test -w "$(npm prefix -g)/lib/node_modules" && echo ok` | prints `ok` |
| Claude Code | `claude --version`, or `~/.local/bin/claude --version` if `claude` isn't found | prints a version |
| git | `git --version` | prints a version |

Fixes:
- **Node missing, too old, or npm can't install globally:** suggest `brew install node` (Homebrew installs Node 24). If Homebrew isn't installed, point the user to https://brew.sh. Don't suggest `sudo npm` and don't use nvm: PMX's background job remembers Node's path, and nvm switching or removing a version breaks it.
- **Claude Code missing:** point the user to https://code.claude.com.
- **Not macOS:** stop. PMX supports macOS only for now.

### Step 2: install the package

Download the package and its checksum file into a new empty folder, check the checksum, then install:

```bash
d="$(mktemp -d)" && cd "$d"
curl -fsSLO https://github.com/kp-prodgit/productgit/releases/download/v0.10.0/productgit-0.10.0.tgz
curl -fsSLO https://github.com/kp-prodgit/productgit/releases/download/v0.10.0/SHA256SUMS
shasum -a 256 -c SHA256SUMS
npm install -g ./productgit-0.10.0.tgz
```

If `shasum` doesn't print `productgit-0.10.0.tgz: OK`, stop and don't install. Tell the user the download didn't match the release.

**Joining a team that already uses PMX?** Install your team's version instead. Clone the team's PMX repo (ask the team lead for its URL), then run `npm install -g <repo>/.pmx/cli/productgit.tgz`.

### Step 3: verify

- `pmx --version` prints `0.10.0`, or the team's version.
- `command -v pmx` is inside the folder `npm prefix -g` printed.

If `pmx` isn't found, the npm global `bin` folder isn't on PATH. Tell the user to open a new Terminal window, or add `$(npm prefix -g)/bin` to their PATH.

### Step 4: `pmx init`, with the user

`pmx init` asks questions only the user can answer, and reads tokens without showing them. Ask the user to run it themselves in Terminal. Don't run it for them, and never type a token or password for them.

Tell the user beforehand:
- **The PMX repo** holds the team's shared skills, memory and settings. On their own: accept the default, and PMX creates one at `~/pmx`. Joining a team: give the folder where they cloned the team repo.
- **Every answer is checked.** If they paste something by mistake, init asks again. At the end it shows a summary, and nothing is saved until they confirm.
- **Say yes** to the background job, to the `/pmx-schedule` command, and to "Let PMX's scheduled tasks run pmx…". Without the last one, scheduled runs stop at permission prompts nobody sees.

### Step 5: check the install

Run `pmx doctor --json` and read the result:
- `ok: true` means every required check passed. Read each id in `warnings` to the user, with its `detail` from `checks`.
- When `ok` is false, `failed` lists the failed check ids. Find each one in `checks`, and read its `detail` to the user: it says what to do.

### Step 6: scheduled tasks in the Claude app

Ask the user to open the Claude desktop app, go to the Code tab, start a new session with auto mode off, and type `/pmx-schedule`. Claude creates PMX's scheduled tasks there. Teams using Linear can type `/pmx-board` for the team board.

Afterwards, run `pmx schedule` here and check that every task shows ✔.

### Step 7: report

Tell the user:
- the installed version;
- the doctor result, with any warnings left;
- which scheduled tasks exist;
- that they can switch auto mode back on now;
- that `pmx update` keeps PMX current, and that the team lead uses `pmx update --latest` and then `pmx vendor --require`.

---

## Background for people reading this

- **What gets installed:** one prebuilt package with no runtime dependencies. Installing it downloads nothing else and builds nothing.
- **Node:** 22.12 or later, or 24 or later. Homebrew's `node` is the recommended way to get it.
- **Where things live:**
  - `~/.pmx`: settings, logs, drafts and receipts, private to the user;
  - your PMX repo: shared with the team;
  - the macOS keychain: tokens;
  - one launchd job, `com.productgit.pmx`.
- **Uninstall:** `pmx uninstall`, then `npm uninstall -g productgit`.
