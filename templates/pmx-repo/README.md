# PMX repo

The team's shared PMX repo, managed by [Product Git](https://productgit.com).

| Path | What |
|---|---|
| `memory/` | Shared team memory: product, glossary, style, decisions. PR only. |
| `.claude/skills/` | Shared skills, one per task category. PR only. |
| `pmx.config.json` | Team config: model, categories, sizes, caps, sources. PR only. |
| `outputs/` | Agent drafts, one PR each. |
| `digests/` | Approved weekly digests. |
| `ideation/` | Ideation canvases (JSON). |
| `pmx.stop` | Kill switch. If this file exists on main, no agent pulls. |
| `.pmx/cli/productgit.tgz` | The CLI package this team and CI install. Update with `pmx vendor`, in a PR of its own. |
| `.pmx/runs/` | Run records, one per agent output (checked in CI). |

## Join the team (macOS)

1. Install [Claude Code](https://code.claude.com) and sign in with your company account.
2. Clone this repo, then install the CLI from it:

   ```bash
   npm install -g ./.pmx/cli/productgit.tgz
   ```

   If npm says you lack permission, your Node was installed system-wide. Run
   `npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to your PATH, then retry.
3. Run `pmx init`, give it the path of this checkout, then `pmx doctor`.

The run log is on the `pmx/runlog` branch: `runs/YYYY-MM.jsonl`, hash-chained per agent.
Check it with `pmx doctor`.
