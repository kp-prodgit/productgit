# Managed-settings template (B7, ADMIN-5)

For teams whose IT manages Macs. Deploying this file enforces Product Git's clean run profile (B1) on every
Claude Code session on the device, so a PMX run can't be loosened by a personal setting.

**This applies to all Claude Code use on the machine, not only PMX runs.** Review it with the team first.
In particular, `availableModels` limits every session to the team model, and `blockReadsOutsideWorkingDirectories`
applies everywhere. Remove any key your team doesn't want enforced machine-wide; `pmx doctor` still checks
the PMX profile either way.

## Deploy

| Method | Where |
|---|---|
| File | `/Library/Application Support/ClaudeCode/managed-settings.json` (root-owned, 0644) |
| MDM (Jamf, Kandji, Intune) | A configuration profile for the `com.anthropic.claudecode` domain carrying the same keys |
| Server-managed | Claude console → Admin → Managed settings, pasted as JSON |

## Keys

| Key | Why |
|---|---|
| `autoMemoryEnabled: false`, `env.CLAUDE_CODE_DISABLE_AUTO_MEMORY` | No personal memory in runs (PRIV-1) |
| `disableClaudeAiConnectors`, `syncClaudeAiSkills/Plugins: false`, `ENABLE_CLAUDEAI_MCP_SERVERS=false` | No personal Gmail/Drive connectors or synced skills (PRIV-1) |
| `availableModels` | The model is fixed by team config (NEUT-1). Match `model` in `pmx.config.json`. |
| `strictKnownMarketplaces`, `enabledPlugins` | Only the team's Product Git plugin can be installed |
| `allowManagedHooksOnly` | No personal hooks shape a run (NEUT-1) |
| `permissions.*`, `sandbox.*` | Permissions never skipped; reads and writes limited to the checkout; sandbox on (SEC-3) |

Hosted runners using `--bare` and an API key give a real guarantee instead of device trust; see the execution plan.
