---
name: pmx-schedule
description: Sets up Product Git's (PMX) scheduled tasks in this Claude app. Asks pmx which tasks this machine is missing (meeting collection, the Linear sync) and creates each one with the scheduled-tasks tool. Use when the user types /pmx-schedule or asks to set up or fix PMX's Claude tasks.
---

<!-- Installed by Product Git (pmx init / pmx schedule --install-skill), which keeps it up to date. Your edits are overwritten on the next update. -->

# Set up PMX's scheduled tasks

PMX can't create tasks in this app itself, so it lists what this machine needs and you create them.

1. Run `pmx schedule --json` in a shell. If `pmx` isn't found, try `/opt/homebrew/bin/pmx` and `/usr/local/bin/pmx`; if neither exists, tell the user PMX isn't installed and stop.
2. The JSON has a `missing` list. For each entry, create a scheduled task with exactly its `taskId`, `title`, `description`, `cronExpression` and `prompt`. Don't reword the prompt or change the schedule.
3. Create nothing that isn't in `missing`, and never change or delete any other scheduled task.
4. Run `pmx schedule` and show the user what it prints.
5. Tell the user to open each new task under Scheduled and click "Run now" once, approving what it asks, so later runs don't stop for permission. Tasks run only while the Claude app is open.

If `missing` is empty, say every PMX task is already set up.
