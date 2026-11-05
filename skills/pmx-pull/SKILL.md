---
name: pmx-pull
description: How to see and steer the team's PMX queue from an interactive Claude session. Explains `pmx pull --dry-run`, `pmx status`, `pmx claim` and `pmx release`. Never triages, accepts or rejects.
pmx: {"kind": "core"}
---

# Working with the PMX queue

Use these commands in a terminal. Your own session never does the drafting: `pmx` starts a separate
clean run so your personal setup doesn't shape team work.

| Want to | Run |
|---|---|
| See what your agent would pull next, and why | `pmx pull --dry-run` |
| See the queue, leases and your budget | `pmx status` |
| Claim a specific ready task for your agent | `pmx claim <task id>` |
| Give a claim back | `pmx release <task id>` |
| Release claims that went stale | `pmx release --stale` |
| Review drafts | `pmx review` (terminal) or `pmx review --web` |

## Never do these from a chat session

- Move a task from `inbox` to `ready`. Triage is a human action in the tracker.
- Accept or reject a draft on someone's behalf.
- Create or delete `pmx.stop`, the team kill switch.
