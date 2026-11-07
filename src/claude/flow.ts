import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { savePersonalConfig, type PersonalConfig, type TeamConfig } from "../core/config.js";
import { pmxHome } from "../core/paths.js";
import { currentVersion } from "../core/version.js";
import { FLOW_CSS, FLOW_JS } from "../flow/render.js";
import { mcpInstalled, MCP_TOOLS } from "../mcp/server.js";
import { ARTIFACT_URL, boardUrl } from "./board.js";
import { claudePresent } from "./skill.js";

/**
 * The flow view as a live Claude artifact (FLOW-5). The page holds no data: it asks the PMX server on the viewer's
 * own Mac (`host:pmx`, `pmx mcp`) through the Claude desktop app, so it shows something only to a PM who opens it
 * on a Mac running PMX, and only at the shared level. PMX can't publish artifacts; `/pmx-flow` does.
 */
export const flowFile = () => join(pmxHome(), "flow", "pmx-flow.html");
export const flowCapabilities = () => ({ mcp: { servers: [{ server: "host:pmx", tools: MCP_TOOLS.map((t) => t.name) }] } });

export function flowArtifact(cfg: { team: string; version: string; boardUrl: string | null }): string {
  const json = JSON.stringify(cfg).replace(/</g, "\\u003c");
  return `<title>PMX Flow</title>
<!-- Installed by Product Git. \`pmx flow --html\` writes this page; /pmx-flow publishes it as a Claude artifact (FLOW-5). -->
<script type="application/json" id="pmx-config">${json}</script>
<style>
:root { --page-bg: #f6f7f9; --page-ink: #18202c; --page-muted: #5f6878; --page-warn-bg: #fff4e2; --page-warn: #7a4a08; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --page-bg: #12161c; --page-ink: #e5e9f0; --page-muted: #9aa3b2; --page-warn-bg: #3a2a12; --page-warn: #f6cf8e; color-scheme: dark; } }
:root[data-theme="dark"] { --page-bg: #12161c; --page-ink: #e5e9f0; --page-muted: #9aa3b2; --page-warn-bg: #3a2a12; --page-warn: #f6cf8e; color-scheme: dark; }
body { margin: 0; background: var(--page-bg); color: var(--page-ink); padding: 16px max(16px, env(safe-area-inset-right)) 48px max(16px, env(safe-area-inset-left)); }
.note { font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: var(--page-muted); margin: 0 0 12px; }
.warn { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: var(--page-warn-bg); color: var(--page-warn); border-radius: 10px; padding: 12px 14px; margin: 0 0 12px; }
.warn code { font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; }
${FLOW_CSS}
</style>
<p class="note">This page reads Product Git on the Mac that opens it, through the Claude desktop app. Held meetings appear by rule only; to see their titles, run <code>pmx flow --web</code> on that Mac.</p>
<div id="banner" class="warn" hidden></div>
<div id="flow"></div>
<script>
${FLOW_JS}
(function () {
  "use strict";
  var cfg = JSON.parse(document.getElementById("pmx-config").textContent);
  var banner = document.getElementById("banner");
  var mcp = window.claude && window.claude.use ? window.claude.use("mcp") : Promise.resolve(null);
  var HELP = {
    server_not_connected: "This page reads PMX on your Mac. Open it in the Claude desktop app on the Mac where PMX runs. If PMX is there, run pmx mcp --install once and restart the Claude app.",
    not_granted: "Allow this page to use PMX on your Mac when Claude asks; it only reads PMX's records, and adds to your do-not-read list when you click to.",
    approval_required: "Allow this page to use PMX on your Mac when Claude asks.",
  };
  function show(text) { banner.textContent = text; banner.hidden = !text; }
  function call(tool, args) {
    return mcp.then(function (m) {
      if (!m) { var e = new Error(HELP.server_not_connected); e.code = "server_not_connected"; throw e; }
      return m.callTool("host:pmx", tool, args);
    }).then(function (r) {
      var p = r && r.payload;
      if (p && p.error) throw new Error(p.error);
      show("");
      return p;
    }, function (e) {
      var text = HELP[e && e.code] || (e && e.code === "tool_error" ? "PMX answered with an error: " + (e.message || "") : "Couldn't reach PMX on this Mac" + (e && e.code ? " (" + e.code + ")" : "") + ". Try again in a moment.");
      show(text);
      var err = new Error(text); err.code = e && e.code; throw err;
    });
  }
  window.PMXFlow.mount(document.getElementById("flow"), {
    mode: "artifact",
    boardUrl: cfg.boardUrl,
    load: function (hours, scope) { return call("flow_graph", { hours: hours, scope: scope }); },
    whatIf: function (kind, value) { return call("flow_what_if", { kind: kind, value: value }); },
    neverIngest: function (kind, value) { return call("never_ingest_add", { kind: kind, value: value }).then(function (r) { return r.message; }); },
  });
})();
</script>
`;
}

export async function renderFlow(team: TeamConfig | null, personal: PersonalConfig | null): Promise<string> {
  const html = flowArtifact({ team: team?.team ?? "", version: currentVersion(), boardUrl: boardUrl(team, personal)?.url ?? null });
  await mkdir(join(flowFile(), ".."), { recursive: true });
  await writeFile(flowFile(), html, { mode: 0o644 });
  return flowFile();
}

/** What `/pmx-flow` reads (`pmx flow --publish-json`): the page and exactly how to publish it. */
export async function flowJson(team: TeamConfig | null, personal: PersonalConfig | null) {
  if (!(await claudePresent())) return { ready: false, reason: "Claude isn't set up on this Mac, and the flow view runs inside the Claude app." };
  return {
    ready: true,
    html: await renderFlow(team, personal),
    title: "PMX Flow",
    description: "Where Product Git's data went: meetings read and held, tasks, Linear issues, agent runs, skills and spend, read from this Mac.",
    icon: "flow",
    capabilities: flowCapabilities(),
    url: personal?.flow?.url ?? null,
    publishedVersion: personal?.flow?.version ?? null,
    version: currentVersion(),
    mcpInstalled: await mcpInstalled(),
  };
}

export async function setFlowUrl(personal: PersonalConfig, url: string, now: Date): Promise<void> {
  if (!ARTIFACT_URL.test(url)) throw new Error(`"${url}" isn't a Claude artifact link (https://claude.ai/artifact/…).`);
  personal.flow = { url: url.replace(/\/$/, ""), version: currentVersion(), publishedAt: now.toISOString() };
  await savePersonalConfig(personal);
}
