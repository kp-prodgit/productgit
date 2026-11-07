/**
 * The flow view's renderer (FLOW-2, FLOW-5), shared by `pmx flow --web` on this Mac and the /pmx-flow artifact.
 * Plain browser code with no libraries, so it runs under the local page's strict CSP and needs nothing from a CDN.
 * Every value from the graph is inserted with textContent, never as HTML.
 *
 * `PMXFlow.mount(root, opts)`:
 *   opts.load(hours, scope) → Promise<FlowGraph>   scope is "mine" or "team"
 *   opts.mode               "local" | "artifact"
 *   opts.neverIngest?(kind, value) → Promise<string>   artifact only: adds to the do-not-read list
 *   opts.whatIf?(kind, value) → Promise<{meetings, tasks, note}>
 *   opts.boardUrl?          the team board, for triage
 */
export const FLOW_CSS = `
.pf { --pf-bg: #f6f7f9; --pf-card: #fff; --pf-ink: #18202c; --pf-muted: #5f6878; --pf-line: #dfe3ea; --pf-soft: #eef1f5;
  --pf-used: #2f7d55; --pf-held: #b86e00; --pf-held-bg: #fff4e2; --pf-run: #3a63d1; --pf-task: #7a4fd0; --pf-issue: #1f7fa8;
  --pf-exec: #2f8f6a; --pf-bad: #c63d3d; --pf-skill: #8a6d1d; --pf-accent: #3a63d1; --pf-seal: #8b2b2b; --pf-glass: rgba(255,255,255,.9);
  color: var(--pf-ink); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .pf { --pf-bg: #12161c; --pf-card: #1b2029; --pf-ink: #e5e9f0; --pf-muted: #9aa3b2;
  --pf-line: #2d3440; --pf-soft: #232a35; --pf-used: #5cc08e; --pf-held: #e8a548; --pf-held-bg: #3a2a12; --pf-run: #7f9ef5; --pf-task: #b392f2;
  --pf-issue: #5fb6dc; --pf-exec: #5cc7a0; --pf-bad: #f07272; --pf-skill: #d8b85a; --pf-accent: #7f9ef5; --pf-seal: #f08f8f; --pf-glass: rgba(44,53,68,.92); } }
:root[data-theme="dark"] .pf { --pf-bg: #12161c; --pf-card: #1b2029; --pf-ink: #e5e9f0; --pf-muted: #9aa3b2; --pf-line: #2d3440; --pf-soft: #232a35;
  --pf-used: #5cc08e; --pf-held: #e8a548; --pf-held-bg: #3a2a12; --pf-run: #7f9ef5; --pf-task: #b392f2; --pf-issue: #5fb6dc; --pf-exec: #5cc7a0;
  --pf-bad: #f07272; --pf-skill: #d8b85a; --pf-accent: #7f9ef5; --pf-seal: #f08f8f; --pf-glass: rgba(44,53,68,.92); }
.pf * { box-sizing: border-box; }
.pf button, .pf select, .pf input { font: inherit; color: inherit; }
.pf button { cursor: pointer; }
.pf :focus-visible { outline: 2px solid var(--pf-accent); outline-offset: 2px; }
.pf-top { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; margin-bottom: 12px; }
.pf-top h1 { font-size: 18px; margin: 0; font-weight: 650; letter-spacing: -.01em; }
.pf-fresh { color: var(--pf-muted); font-size: 12px; }
.pf-controls { display: flex; flex-wrap: wrap; gap: 6px; margin-left: auto; }
.pf-seg { display: inline-flex; border: 1px solid var(--pf-line); border-radius: 8px; overflow: hidden; background: var(--pf-card); }
.pf-seg button { border: 0; background: none; padding: 4px 10px; font-size: 13px; color: var(--pf-muted); }
.pf-seg button[aria-pressed="true"] { background: var(--pf-ink); color: var(--pf-bg); }
.pf select { border: 1px solid var(--pf-line); background: var(--pf-card); border-radius: 8px; padding: 4px 8px; font-size: 13px; }
.pf-ledger { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 12px; margin-bottom: 12px; }
@media (max-width: 760px) { .pf-ledger { grid-template-columns: 1fr; } }
.pf-box { background: var(--pf-card); border: 1px solid var(--pf-line); border-radius: 12px; padding: 12px 14px; min-width: 0; }
.pf-box h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: var(--pf-muted); margin: 0 0 8px; font-weight: 600; }
.pf-claims { margin: 0; padding: 0; list-style: none; }
.pf-claims li { padding: 3px 0; }
.pf-nums { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.pf-num { background: var(--pf-soft); border-radius: 10px; padding: 6px 10px; min-width: 84px; }
.pf-num b { display: block; font-size: 20px; font-variant-numeric: tabular-nums; line-height: 1.1; }
.pf-num span { font-size: 12px; color: var(--pf-muted); }
.pf-num.held b { color: var(--pf-held); }
.pf-checks { list-style: none; padding: 0; margin: 0 0 8px; }
.pf-checks li { display: grid; grid-template-columns: 20px 1fr; gap: 6px; padding: 4px 0; font-size: 13px; }
.pf-checks .ok { color: var(--pf-used); } .pf-checks .violated { color: var(--pf-bad); } .pf-checks .unknown { color: var(--pf-muted); }
.pf-checks li[hidden] { display: none; }
.pf-seal { border: 2px solid var(--pf-seal); color: var(--pf-seal); border-radius: 10px; padding: 8px 10px; font-weight: 650; text-align: center; transform: rotate(-1.5deg); margin-top: 6px; }
.pf-seal.bad { border-color: var(--pf-bad); color: var(--pf-bad); }
.pf-btn { border: 1px solid var(--pf-line); background: var(--pf-card); border-radius: 8px; padding: 5px 12px; font-size: 13px; }
.pf-btn.primary { background: var(--pf-accent); color: #fff; border-color: var(--pf-accent); }
.pf-budget { display: flex; gap: 6px; align-items: flex-end; height: 44px; margin: 4px 0 0; }
.pf-day { flex: 1; min-width: 10px; background: var(--pf-soft); border-radius: 4px; position: relative; height: 100%; }
.pf-day i { position: absolute; left: 0; right: 0; bottom: 0; background: var(--pf-run); border-radius: 4px; }
.pf-day.over i { background: var(--pf-bad); }
.pf-runs { display: flex; gap: 4px; align-items: center; overflow-x: auto; padding: 6px 0 10px; }
.pf-runs button { border: 1px solid var(--pf-line); background: var(--pf-card); border-radius: 999px; padding: 2px 9px; font-size: 12px; white-space: nowrap; color: var(--pf-muted); }
.pf-runs button[aria-pressed="true"] { border-color: var(--pf-accent); color: var(--pf-accent); }
.pf-runs button.failed { border-color: var(--pf-bad); color: var(--pf-bad); }
.pf-main { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 12px; align-items: start; }
.pf-main.closed { grid-template-columns: minmax(0, 1fr); }
@media (max-width: 960px) { .pf-main { grid-template-columns: 1fr; } }
.pf-stage { background: var(--pf-bg); border: 1px solid var(--pf-line); border-radius: 12px; overflow: auto; position: relative; min-height: 320px; max-height: 72vh; }
.pf-canvas { position: relative; }
.pf-cols { position: absolute; inset: 0; display: grid; pointer-events: none; }
.pf-col-h { position: sticky; top: 0; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--pf-muted); padding: 8px 12px; font-weight: 600; }
.pf-svg { position: absolute; left: 0; top: 0; pointer-events: none; overflow: visible; }
.pf-svg path { fill: none; stroke: var(--pf-line); stroke-width: 1.6; transition: opacity .2s; }
.pf-svg path.held, .pf-svg path.skipped { stroke: var(--pf-held); stroke-dasharray: 5 4; }
.pf-svg path.inferred { stroke-dasharray: 2 4; }
.pf-svg path.registered, .pf-svg path.lodged { stroke: var(--pf-issue); }
.pf-svg path.executed, .pf-svg path.judged { stroke: var(--pf-exec); }
.pf-svg path.used-skill { stroke: var(--pf-skill); opacity: .45; }
.pf-svg path.lit { stroke-width: 2.6; opacity: 1; }
.pf-svg path.dim { opacity: .08; }
.pf-node { position: absolute; background: var(--pf-card); border: 1px solid var(--pf-line); border-left: 4px solid var(--pf-line); border-radius: 8px; padding: 6px 8px;
  text-align: left; overflow: hidden; display: flex; flex-direction: column; gap: 2px; transition: opacity .2s, box-shadow .2s; }
.pf-node:hover { box-shadow: 0 2px 10px rgba(0,0,0,.08); }
.pf-node .t { font-size: 13px; font-weight: 550; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pf-node .s { font-size: 11px; color: var(--pf-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pf-node .bar { height: 3px; background: var(--pf-accent); border-radius: 2px; display: none; }
.pf[data-lens="cost"] .pf-node .bar, .pf[data-lens="time"] .pf-node .bar { display: block; }
.pf-node.dim { opacity: .18; }
.pf-node.sel { box-shadow: 0 0 0 2px var(--pf-accent); }
.pf-node.k-run { border-left-color: var(--pf-run); } .pf-node.k-task, .pf-node.k-todo { border-left-color: var(--pf-task); }
.pf-node.k-issue, .pf-node.k-meeting { border-left-color: var(--pf-issue); } .pf-node.k-execution, .pf-node.k-verdict { border-left-color: var(--pf-exec); }
.pf-node.k-skill { border-left-color: var(--pf-skill); }
.pf-node.k-source { border-left-color: var(--pf-used); }
.pf-node.st-held, .pf-node.k-skipped, .pf-node.k-vault { border-left-color: var(--pf-held); background: var(--pf-held-bg); }
.pf-node.st-failed, .pf-node.st-violated, .pf-node.st-rejected { border-left-color: var(--pf-bad); }
.pf-node.st-dry-run { border-style: dashed; }
.pf[data-lens="privacy"] .pf-node:not(.k-source):not(.k-vault):not(.k-skipped) { opacity: .55; }
.pf[data-lens="skills"] .pf-node[data-skill] { border-left-color: var(--sk); }
.pf-list { padding: 8px; }
.pf-list h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--pf-muted); margin: 12px 4px 6px; }
.pf-list .pf-node { position: relative; width: 100%; margin-bottom: 6px; }
.pf-panel { background: var(--pf-card); border: 1px solid var(--pf-line); border-radius: 12px; padding: 12px 14px; position: sticky; top: 8px; max-height: 72vh; overflow: auto; }
.pf-panel h2 { font-size: 15px; margin: 0 0 4px; word-break: break-word; }
.pf-panel .k { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--pf-muted); }
.pf-panel dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; font-size: 13px; margin: 10px 0; }
.pf-panel dt { color: var(--pf-muted); } .pf-panel dd { margin: 0; word-break: break-word; }
.pf-path { list-style: none; padding: 0; margin: 8px 0; border-left: 2px solid var(--pf-line); }
.pf-path li { padding: 3px 0 3px 10px; font-size: 13px; position: relative; }
.pf-path li::before { content: ""; position: absolute; left: -5px; top: 10px; width: 8px; height: 8px; border-radius: 50%; background: var(--pf-line); }
.pf-path li.here::before { background: var(--pf-accent); }
.pf-path button { all: unset; cursor: pointer; } .pf-path button:hover { text-decoration: underline; }
.pf-panel code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--pf-soft); padding: 2px 6px; border-radius: 6px; display: inline-block; margin: 2px 0; word-break: break-all; }
.pf-msg { font-size: 13px; color: var(--pf-muted); margin: 6px 0; }
.pf-gaps { font-size: 12px; color: var(--pf-muted); margin: 8px 0 0; padding-left: 18px; }
.pf-empty { padding: 40px 16px; text-align: center; color: var(--pf-muted); }
.pf-strata { perspective: 1600px; padding: 40px 16px 40px; min-height: 520px; touch-action: none; cursor: grab; }
.pf-scene { transform-style: preserve-3d; position: relative; margin: 120px auto 0; width: min(720px, 100%); height: 240px; transition: transform .1s linear; }
.pf-layer { all: unset; position: absolute; left: 0; right: 0; bottom: 0; height: 118px; border-radius: 14px; border: 1.5px solid var(--pf-run);
  background: var(--pf-glass); box-shadow: 0 10px 30px rgba(0,0,0,.18); transform-style: preserve-3d; display: grid; grid-template-columns: 120px repeat(6, 1fr);
  gap: 6px; padding: 10px 12px; cursor: pointer; }
.pf-layer:hover, .pf-layer:focus-visible { border-color: var(--pf-held); box-shadow: 0 10px 34px rgba(0,0,0,.3); }
.pf-layer .day { font-size: 12px; color: var(--pf-muted); }
.pf-layer .day b { display: block; font-size: 15px; color: var(--pf-ink); }
.pf-layer .cell { display: flex; flex-wrap: wrap; align-content: flex-start; gap: 4px; border-left: 1px dashed var(--pf-line); padding-left: 6px; }
.pf-dot { width: 11px; height: 11px; border-radius: 50%; background: var(--pf-muted); }
.pf-dot.k-source { background: var(--pf-used); } .pf-dot.st-held, .pf-dot.k-skipped { background: var(--pf-held); } .pf-dot.k-run { background: var(--pf-run); }
.pf-dot.k-task, .pf-dot.k-todo { background: var(--pf-task); } .pf-dot.k-issue, .pf-dot.k-meeting { background: var(--pf-issue); } .pf-dot.k-execution, .pf-dot.k-verdict { background: var(--pf-exec); }
.pf-dot.st-failed, .pf-dot.st-rejected { background: var(--pf-bad); }
.pf-hint { font-size: 12px; color: var(--pf-muted); text-align: center; margin-top: 8px; }
.pf-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--pf-muted); margin: 8px 2px 0; }
.pf-legend span::before { content: ""; display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; background: var(--c); }
@media (prefers-reduced-motion: reduce) { .pf * { transition: none !important; } }
`;

export const FLOW_JS = String.raw`
(function () {
  var STAGES = ["Arrivals", "Checkpoint", "Workshop", "Tasks", "Linear", "Departures"];
  var KIND = { source: "Source", skipped: "Skipped upstream", vault: "The vault", run: "PMX run", skill: "Skill", task: "Proposed task", todo: "Private to-do",
    issue: "Linear issue", meeting: "Meeting in Linear", execution: "Agent run", verdict: "Review verdict" };
  var META = { origin: "From", channel: "Channel", passagesUsed: "Passages used", passagesCut: "Passages cut", cutRules: "Cut because", ledger: "Meeting ledger",
    detail: "Why", file: "File", rule: "Rule", ruleLabel: "Held because", type: "Run", outcome: "Outcome", dryRun: "Dry run", model: "Model", tokens: "Tokens",
    masked: "Values masked", scope: "Scope", canaries: "Canaries held", error: "Error", category: "Category", size: "Size", why: "Why this size", flags: "Check the size",
    sources: "Sources cited", identifier: "Linear", pending: "Waiting for sync", agent: "Agent", taskId: "Task", runtime: "Runtime", skill: "Skill",
    reviewMinutes: "Review minutes", editSize: "Edit size", name: "Skill", version: "Version", count: "Count", due: "Due", runs: "Collection runs", saved: "Saved",
    connectors: "Connectors", posted: "Tasks posted", held: "Held" };
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === "text") e.textContent = attrs[k];
      else if (k === "cls") e.className = attrs[k];
      else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) e.setAttribute(k, attrs[k] === true ? "" : attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function money(n) { return n == null ? "–" : "$" + Number(n).toFixed(n < 0.1 ? 3 : 2); }
  function dur(ms) { if (ms == null) return "–"; var s = Math.round(ms / 1000); return s < 90 ? s + "s" : Math.round(s / 60) + " min"; }
  function when(at) { if (!at) return ""; var d = new Date(at); return isNaN(d) ? at : d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }); }
  function dayOf(at) { var d = new Date(at); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function hue(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }

  function mount(root, opts) {
    var st = { hours: 24, scope: "mine", lens: "flow", view: "flow", sel: null, run: null, day: null, g: null, audited: false };
    root.classList.add("pf");
    root.textContent = "";
    var top = el("div", { cls: "pf-top" });
    var ledger = el("div", { cls: "pf-ledger" });
    var runs = el("div", { cls: "pf-runs", role: "toolbar", "aria-label": "Runs" });
    var main = el("div", { cls: "pf-main closed" });
    var stage = el("div", { cls: "pf-stage" });
    var panel = el("aside", { cls: "pf-panel", hidden: true, "aria-live": "polite" });
    main.append(stage, panel);
    root.append(top, ledger, runs, main);

    function seg(items, cur, on) {
      var s = el("div", { cls: "pf-seg", role: "group" });
      items.forEach(function (it) { s.append(el("button", { type: "button", "aria-pressed": String(it[0] === cur), text: it[1], onclick: function () { on(it[0]); } })); });
      return s;
    }
    function drawTop() {
      top.textContent = "";
      var g = st.g;
      var fresh = g ? "As of " + when(g.at) + (g.freshness.linearSyncedAt ? " · Linear synced " + when(g.freshness.linearSyncedAt) : " · Linear not synced yet") : "Loading…";
      var win = el("select", { "aria-label": "Window", onchange: function (e) { st.hours = Number(e.target.value); reload(); } });
      [[24, "Last 24 hours"], [72, "Last 3 days"], [168, "Last 7 days"], [336, "Last 14 days"]].forEach(function (o) { win.append(el("option", { value: String(o[0]), selected: o[0] === st.hours, text: o[1] })); });
      top.append(el("h1", { text: "Where PMX's data went" }), el("span", { cls: "pf-fresh", text: fresh }),
        el("div", { cls: "pf-controls" }, [win,
          seg([["mine", "This Mac"], ["team", "Team"]], st.scope, function (v) { st.scope = v; st.sel = null; st.run = null; reload(); }),
          seg([["flow", "Flow"], ["privacy", "Privacy"], ["skills", "Skills"], ["cost", "Cost"], ["time", "Time"]], st.lens, function (v) { st.lens = v; root.setAttribute("data-lens", v); drawTop(); draw(); }),
          seg([["flow", "2D"], ["strata", "3D days"]], st.view, function (v) { st.view = v; drawTop(); draw(); })]));
    }
    function drawLedger() {
      ledger.textContent = "";
      var g = st.g, s = g.summary;
      var nums = el("div", { cls: "pf-nums" });
      var add = function (n, l, cls) { nums.append(el("div", { cls: "pf-num " + (cls || "") }, [el("b", { text: String(n) }), el("span", { text: l })])); };
      if (g.level !== "team") { add(s.read, "read"); add(s.held + s.skippedUpstream, "held", "held"); }
      add(s.tasks, "tasks proposed"); add(s.registered, "in Linear"); add(s.executions, "agent runs");
      if (s.capUsd != null) add(money(s.spentUsd), "of " + money(s.capUsd) + " a day");
      var claims = el("ul", { cls: "pf-claims" });
      var byRule = {};
      g.nodes.forEach(function (n) { if (n.status === "held") byRule[n.meta.ruleLabel] = (byRule[n.meta.ruleLabel] || 0) + 1; });
      var rules = Object.keys(byRule).map(function (k) { return byRule[k] + " " + String(k).toLowerCase(); });
      if (rules.length) claims.append(el("li", { text: "Held: " + rules.join(", ") + "." }));
      if (s.skippedUpstream) claims.append(el("li", { text: s.skippedUpstream + " meeting(s) skipped by the collection task before anything was saved." }));
      if (g.level === "team") claims.append(el("li", { text: "Team view: from the shared run log only. Meetings and held items stay on each PM's Mac." }));
      var left = el("div", { cls: "pf-box" }, [el("h2", { text: "Trust ledger" }), nums, claims]);
      if (g.budget.length) {
        var max = Math.max.apply(null, g.budget.map(function (b) { return Math.max(b.capUsd, b.spentUsd); }).concat([0.01]));
        var bars = el("div", { cls: "pf-budget", "aria-label": "Spend per day against the cap" });
        g.budget.forEach(function (b) {
          var d = el("div", { cls: "pf-day" + (b.spentUsd > b.capUsd ? " over" : ""), title: b.day + ": " + money(b.spentUsd) + " of " + money(b.capUsd) });
          d.style.height = Math.max(8, (b.capUsd / max) * 100) + "%";
          var i = el("i"); i.style.height = Math.min(100, (b.spentUsd / Math.max(b.capUsd, 0.0001)) * 100) + "%"; d.append(i); bars.append(d);
        });
        left.append(el("div", { cls: "pf-msg", text: "Spend per day against your cap (USD; PMX can't read your Claude plan's usage)." }), bars);
      }
      if (g.gaps.length) { var gl = el("ul", { cls: "pf-gaps" }); g.gaps.forEach(function (x) { gl.append(el("li", { text: x })); }); left.append(gl); }
      var list = el("ul", { cls: "pf-checks" });
      g.checks.forEach(function (c, i) {
        list.append(el("li", { hidden: !st.audited, "data-i": String(i) }, [el("span", { cls: c.status, text: c.status === "ok" ? "✔" : c.status === "violated" ? "✘" : "?" }),
          el("span", {}, [el("b", { text: c.label + ". " }), c.detail])]));
      });
      var box = el("div", { cls: "pf-box" }, [el("h2", { text: "Audit" }), list]);
      var btn = el("button", { cls: "pf-btn primary", type: "button", text: st.audited ? "Run the audit again" : "Run the audit", onclick: audit });
      box.append(btn);
      if (st.audited) box.append(sealFor(g));
      ledger.append(left, box);
    }
    function sealFor(g) {
      var bad = g.checks.filter(function (c) { return c.status === "violated"; });
      var leak = g.checks.find(function (c) { return c.id === "held-never-in-linear"; });
      var held = g.summary.held + g.summary.skippedUpstream;
      var text = bad.length ? bad.length + " check(s) failed: open them above." :
        g.level === "team" ? "Run log verified." : held + " held · 0 reached Linear" + (leak && leak.status === "unknown" ? " (Linear not synced yet)" : "") + " · checked " + when(g.at);
      return el("div", { cls: "pf-seal" + (bad.length ? " bad" : ""), role: "status", text: text });
    }
    function audit() {
      st.audited = true;
      drawLedger();
      var items = ledger.querySelectorAll(".pf-checks li");
      var seal = ledger.querySelector(".pf-seal");
      if (reduced) return;
      items.forEach(function (li) { li.hidden = true; });
      if (seal) seal.hidden = true;
      var i = 0;
      (function next() { if (i < items.length) { items[i++].hidden = false; setTimeout(next, 280); } else if (seal) seal.hidden = false; })();
    }
    function drawRuns() {
      runs.textContent = "";
      var g = st.g;
      if (!g.runs.length) return;
      runs.append(el("button", { type: "button", "aria-pressed": String(!st.run), text: "All runs", onclick: function () { st.run = null; st.sel = null; drawRuns(); draw(); } }));
      g.runs.forEach(function (r) {
        runs.append(el("button", { type: "button", cls: r.outcome === "failed" ? "failed" : "", "aria-pressed": String(st.run === r.id),
          text: (r.type === "synthesize" ? "Synthesis" : r.type === "digest" ? "Digest" : "To-dos") + " " + when(r.at) + (r.dryRun ? " (dry run)" : ""),
          onclick: function () { st.run = r.id; select("run:" + r.id); drawRuns(); } }));
      });
    }

    // Tracing walks edges both ways but never through a skill, the vault or a run, so one shared node doesn't light everything.
    function trace(id) {
      var g = st.g, keep = {}, out = {}, inn = {};
      g.edges.forEach(function (e) { (out[e.from] = out[e.from] || []).push(e.to); (inn[e.to] = inn[e.to] || []).push(e.from); });
      // A run reads many sources and proposes many tasks: stop there unless the run itself is picked, so a meeting
      // lights only the tasks that cite it.
      var hub = function (x) { var n = byId[x]; return x !== id && n && (n.kind === "skill" || n.kind === "vault" || n.kind === "run"); };
      function walk(start, map) { var q = [start]; while (q.length) { var x = q.shift(); (map[x] || []).forEach(function (y) { if (!keep[y]) { keep[y] = true; if (!hub(y)) q.push(y); } }); } }
      keep[id] = true;
      walk(id, out); walk(id, inn);
      return keep;
    }
    var byId = {};
    function select(id) { st.sel = id; draw(); drawPanel(); }

    function visibleNodes() {
      var g = st.g;
      return g.nodes.filter(function (n) { return !st.day || (n.at && dayOf(n.at) === st.day) || n.kind === "vault" || n.kind === "skill"; });
    }
    function card(n, lit, maxCost, maxDur) {
      var sub = [];
      if (n.kind === "source") sub.push(n.status === "held" ? "Held · " + (n.meta.ruleLabel || "") : (n.meta.origin || "") + (n.at ? " · " + String(n.at).slice(0, 10) : ""));
      else if (n.kind === "run") sub.push((n.status || "") + " · " + money(n.costUsd) + " · " + dur(n.durationMs));
      else if (n.kind === "task") sub.push((n.meta.category || "") + " · " + (n.meta.size || "") + (n.status === "dry-run" ? " · dry run" : ""));
      else if (n.kind === "issue" || n.kind === "meeting") sub.push((n.status || "") + (n.meta.pending ? " · waiting for sync" : ""));
      else if (n.kind === "execution") sub.push(money(n.costUsd) + " · " + dur(n.durationMs));
      else if (n.kind === "verdict") sub.push(n.meta.reviewMinutes != null ? n.meta.reviewMinutes + " min review" : "");
      else if (n.kind === "skill") sub.push(n.meta.source === "bundled" ? "bundled with PMX" : "team skill");
      else if (n.kind === "skipped") sub.push("never saved; counts only");
      else if (n.kind === "vault") sub.push("never sent to the model or Linear");
      var b = el("button", { type: "button", cls: "pf-node k-" + n.kind + (n.status ? " st-" + n.status : "") + (st.sel && !lit[n.id] ? " dim" : "") + (st.sel === n.id ? " sel" : ""),
        "data-id": n.id, title: n.label, onclick: function () { select(st.sel === n.id ? null : n.id); } },
        [el("span", { cls: "t", text: n.label }), el("span", { cls: "s", text: sub.join("") })]);
      var skill = st.g.edges.find(function (e) { return e.to === n.id && e.kind === "used-skill"; });
      var sk = n.kind === "skill" ? n.id : skill && skill.from;
      if (sk) { b.setAttribute("data-skill", sk); b.style.setProperty("--sk", "hsl(" + hue(sk) + " 60% 48%)"); }
      var v = st.lens === "cost" ? (n.costUsd || 0) / maxCost : st.lens === "time" ? (n.durationMs || 0) / maxDur : 0;
      if (v) { var bar = el("span", { cls: "bar" }); bar.style.width = Math.max(4, v * 100) + "%"; b.append(bar); }
      return b;
    }
    function draw() {
      var g = st.g;
      if (!g) return;
      byId = {};
      g.nodes.forEach(function (n) { byId[n.id] = n; });
      stage.textContent = "";
      var nodes = visibleNodes();
      if (!nodes.filter(function (n) { return n.kind !== "vault"; }).length) {
        stage.append(el("div", { cls: "pf-empty", text: g.level === "team" ? "No team activity in this window." : "Nothing ran in this window. Try a longer one." }));
        return;
      }
      if (st.view === "strata") return drawStrata(nodes);
      var lit = st.sel ? trace(st.sel) : {};
      var maxCost = Math.max.apply(null, nodes.map(function (n) { return n.costUsd || 0; }).concat([0.0001]));
      var maxDur = Math.max.apply(null, nodes.map(function (n) { return n.durationMs || 0; }).concat([1]));
      var narrow = stage.clientWidth < 760;
      if (narrow) {
        var list = el("div", { cls: "pf-list" });
        STAGES.forEach(function (name, i) {
          var col = nodes.filter(function (n) { return n.stage === i; });
          if (!col.length) return;
          list.append(el("h3", { text: name }));
          col.forEach(function (n) { list.append(card(n, lit, maxCost, maxDur)); });
        });
        stage.append(list, legend());
        return;
      }
      var colW = Math.max(190, Math.floor((stage.clientWidth - 2) / 6)), cardW = colW - 28, cardH = 52, gap = 10, head = 34, pos = {};
      var cols = STAGES.map(function (_, i) { return nodes.filter(function (n) { return n.stage === i; }).sort(function (a, b) { return String(a.at || "").localeCompare(String(b.at || "")) || a.label.localeCompare(b.label); }); });
      var height = head + Math.max.apply(null, cols.map(function (c) { return c.length; })) * (cardH + gap) + 24;
      var canvas = el("div", { cls: "pf-canvas" });
      canvas.style.width = colW * 6 + "px"; canvas.style.height = Math.max(300, height) + "px";
      var heads = el("div", { cls: "pf-cols" }); heads.style.gridTemplateColumns = "repeat(6, " + colW + "px)";
      STAGES.forEach(function (s) { heads.append(el("div", { cls: "pf-col-h", text: s })); });
      canvas.append(heads);
      var ns = "http://www.w3.org/2000/svg";
      var svg = document.createElementNS(ns, "svg"); svg.setAttribute("class", "pf-svg"); svg.setAttribute("width", String(colW * 6)); svg.setAttribute("height", String(Math.max(300, height)));
      svg.setAttribute("aria-hidden", "true");
      canvas.append(svg);
      cols.forEach(function (col, i) {
        col.forEach(function (n, j) {
          var x = i * colW + 14, y = head + j * (cardH + gap);
          pos[n.id] = { x: x, y: y };
          var c = card(n, lit, maxCost, maxDur);
          c.style.left = x + "px"; c.style.top = y + "px"; c.style.width = cardW + "px"; c.style.height = cardH + "px";
          canvas.append(c);
        });
      });
      g.edges.forEach(function (e) {
        var a = pos[e.from], b = pos[e.to];
        if (!a || !b) return;
        var x1 = a.x + cardW, y1 = a.y + cardH / 2, x2 = b.x, y2 = b.y + cardH / 2, d;
        if (b.x <= a.x) { var r = a.x + cardW + 18 + Math.min(40, Math.abs(y2 - y1) / 6); x2 = b.x + cardW; d = "M" + x1 + "," + y1 + " C" + r + "," + y1 + " " + r + "," + y2 + " " + x2 + "," + y2; }
        else { var m = (x1 + x2) / 2; d = "M" + x1 + "," + y1 + " C" + m + "," + y1 + " " + m + "," + y2 + " " + x2 + "," + y2; }
        var p = document.createElementNS(ns, "path");
        p.setAttribute("d", d);
        p.setAttribute("class", e.kind + (e.inferred ? " inferred" : "") + (st.sel ? (lit[e.from] && lit[e.to] ? " lit" : " dim") : ""));
        svg.append(p);
      });
      stage.append(canvas, legend());
    }
    function legend() {
      var l = el("div", { cls: "pf-legend" });
      [["Passed the rules", "--pf-used"], ["Held", "--pf-held"], ["PMX run", "--pf-run"], ["Task", "--pf-task"], ["Linear", "--pf-issue"], ["Agent run / review", "--pf-exec"], ["Skill", "--pf-skill"]]
        .forEach(function (x) { var s = el("span", { text: x[0] }); s.style.setProperty("--c", "var(" + x[1] + ")"); l.append(s); });
      l.append(el("span", { text: "Dashed: held, or matched by title (older records)" }));
      return l;
    }

    // 3D days: one glass layer per day, stacked in depth. Drag to turn the stack; pick a day to open it in 2D.
    var rot = { x: 48, z: -18 };
    function drawStrata(nodes) {
      var days = {};
      nodes.forEach(function (n) { if (n.at) (days[dayOf(n.at)] = days[dayOf(n.at)] || []).push(n); });
      var keys = Object.keys(days).sort();
      var wrap = el("div", { cls: "pf-strata", role: "group", "aria-label": "Days stacked in 3D. Drag to turn; choose a day to open it." });
      var scene = el("div", { cls: "pf-scene" });
      var apply = function () { scene.style.transform = "rotateX(" + rot.x + "deg) rotateZ(" + rot.z + "deg)"; };
      apply();
      keys.forEach(function (k, i) {
        var ns = days[k];
        var cost = ns.reduce(function (a, n) { return a + (n.kind === "run" || n.kind === "execution" ? n.costUsd || 0 : 0); }, 0);
        var heldN = ns.filter(function (n) { return n.status === "held"; }).length;
        var layer = el("button", { cls: "pf-layer", type: "button", "aria-label": k + ": " + ns.length + " items, " + heldN + " held",
          onclick: function () { st.day = k; st.view = "flow"; drawTop(); draw(); } },
          [el("span", { cls: "day" }, [el("b", { text: new Date(k + "T12:00:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) }),
            ns.length + " items · " + heldN + " held · " + money(cost)])]);
        for (var s = 0; s < 6; s++) {
          var cell = el("span", { cls: "cell" });
          ns.filter(function (n) { return n.stage === s; }).slice(0, 40).forEach(function (n) { cell.append(el("i", { cls: "pf-dot k-" + n.kind + (n.status ? " st-" + n.status : ""), title: n.label })); });
          layer.append(cell);
        }
        layer.style.transform = "translateZ(" + (i * 96) + "px)";
        scene.append(layer);
      });
      var drag = null;
      wrap.addEventListener("pointerdown", function (e) { if (e.target.closest(".pf-layer")) return; drag = { x: e.clientX, y: e.clientY, r: { x: rot.x, z: rot.z } }; wrap.setPointerCapture(e.pointerId); });
      wrap.addEventListener("pointermove", function (e) { if (!drag) return; rot.z = drag.r.z + (e.clientX - drag.x) / 3; rot.x = Math.max(10, Math.min(80, drag.r.x - (e.clientY - drag.y) / 3)); apply(); });
      wrap.addEventListener("pointerup", function () { drag = null; });
      wrap.append(scene);
      stage.append(wrap, el("div", { cls: "pf-hint", text: keys.length ? "Each layer is a day, oldest at the bottom. Drag the background to turn the stack; choose a day to open it in 2D." : "No dated activity in this window." }));
      if (st.day) stage.append(el("div", { cls: "pf-hint" }, [el("button", { cls: "pf-btn", type: "button", text: "Show all days", onclick: function () { st.day = null; draw(); } })]));
    }

    function drawPanel() {
      var n = st.sel && byId[st.sel];
      panel.textContent = "";
      panel.hidden = !n;
      main.classList.toggle("closed", !n);
      if (!n) return;
      panel.append(el("div", { cls: "k", text: KIND[n.kind] || n.kind }), el("h2", { text: n.label }));
      if (n.at) panel.append(el("div", { cls: "pf-msg", text: when(n.at) }));
      var dl = el("dl");
      if (n.costUsd != null) { dl.append(el("dt", { text: "Cost" }), el("dd", { text: money(n.costUsd) + shareOfCap(n) })); }
      if (n.durationMs != null) { dl.append(el("dt", { text: "Took" }), el("dd", { text: dur(n.durationMs) })); }
      if (n.status) { dl.append(el("dt", { text: "Status" }), el("dd", { text: n.status })); }
      Object.keys(n.meta).forEach(function (k) { var v = n.meta[k]; if (v === null || v === "" || v === false || v === 0 && k !== "passagesCut") return; dl.append(el("dt", { text: META[k] || k }), el("dd", { text: String(v) })); });
      panel.append(dl);
      if (n.url) panel.append(el("p", {}, [el("a", { href: n.url, target: "_blank", rel: "noopener noreferrer", text: "Open in Linear" })]));
      if ((n.kind === "issue") && opts.boardUrl) panel.append(el("p", {}, [el("a", { href: opts.boardUrl, target: "_blank", rel: "noopener noreferrer", text: "Triage it on the team board" })]));
      if (n.kind === "run" && opts.mode === "local") panel.append(el("p", { cls: "pf-msg" }, ["Everything this run read, held and cut: ", el("code", { text: "pmx explain " + n.run })]));
      if (n.kind === "vault") panel.append(el("p", { cls: "pf-msg", text: opts.mode === "local" ? "Held items show the file found again on this Mac. Their text was never stored or sent." : "Held items are shown as a rule only. Their titles stay on the PM's Mac; run pmx flow --web there to see them." }));
      if (n.kind === "source" && n.status === "used" && n.meta.origin !== "slack") editor(n);
      var lit = trace(n.id);
      var path = g().nodes.filter(function (x) { return lit[x.id] && x.id !== n.id && x.kind !== "skill"; }).sort(function (a, b) { return a.stage - b.stage || String(a.at || "").localeCompare(String(b.at || "")); });
      var skills = g().nodes.filter(function (x) { return lit[x.id] && x.kind === "skill"; });
      if (path.length) {
        panel.append(el("div", { cls: "k", text: "Its path" }));
        var ol = el("ol", { cls: "pf-path" });
        path.slice(0, 40).forEach(function (x) { ol.append(el("li", { cls: x.stage === n.stage ? "here" : "" }, [el("button", { type: "button", text: STAGES[x.stage] + ": " + x.label, onclick: function () { select(x.id); } })])); });
        panel.append(ol);
      }
      if (skills.length) panel.append(el("div", { cls: "k", text: "Skills used" }), el("p", { cls: "pf-msg", text: skills.map(function (s) { return s.label; }).join(", ") }));
      panel.append(el("button", { cls: "pf-btn", type: "button", text: "Close", onclick: function () { select(null); } }));
    }
    function g() { return st.g; }
    function shareOfCap(n) {
      if (!n.at) return "";
      var b = st.g.budget.find(function (x) { return x.day === dayOf(n.at); });
      return b && b.capUsd ? " (" + Math.round((n.costUsd / b.capUsd) * 1000) / 10 + "% of that day's cap)" : "";
    }
    function editor(n) {
      var title = String(n.label || "").slice(0, 120);
      panel.append(el("div", { cls: "k", text: "Stop reading meetings like this" }));
      if (opts.mode !== "artifact" || !opts.neverIngest) {
        panel.append(el("p", { cls: "pf-msg", text: "Add a title to your do-not-read list in Terminal:" }), el("code", { text: 'pmx never-ingest add --title "' + title.replace(/"/g, "'") + '"' }));
        return;
      }
      var input = el("input", { type: "text", value: title, "aria-label": "Title text to never read", maxlength: "120" });
      input.style.width = "100%";
      var msg = el("p", { cls: "pf-msg", text: "Meetings whose title contains this text are never read again. This only adds a rule; removing one stays in Terminal." });
      var go = el("button", { cls: "pf-btn primary", type: "button", text: "Preview", onclick: function () {
        var v = input.value.trim();
        if (v.length < 3) { msg.textContent = "Give at least 3 characters."; return; }
        if (go.getAttribute("data-ready") !== v) {
          msg.textContent = "Checking the last 14 days…";
          (opts.whatIf ? opts.whatIf("title", v) : Promise.resolve(null)).then(function (w) {
            msg.textContent = w ? "It would have held " + w.meetings + " meeting(s) and " + w.tasks + " task(s) in the last 14 days. " + w.note : "";
            go.textContent = "Add to my do-not-read list"; go.setAttribute("data-ready", v);
          }, function (e) { msg.textContent = "Couldn't preview: " + (e && e.message || e); });
          return;
        }
        go.disabled = true;
        opts.neverIngest("title", v).then(function (m) { msg.textContent = m; go.textContent = "Added"; }, function (e) { go.disabled = false; msg.textContent = "Not added: " + (e && e.message || e); });
      } });
      panel.append(input, msg, go);
    }

    function reload() {
      drawTop();
      return opts.load(st.hours, st.scope).then(function (graph) {
        st.g = graph; st.audited = false;
        if (st.sel && !graph.nodes.some(function (n) { return n.id === st.sel; })) st.sel = null;
        drawTop(); drawLedger(); drawRuns(); draw(); drawPanel();
      }, function (e) {
        stage.textContent = "";
        stage.append(el("div", { cls: "pf-empty", text: String(e && e.message || e) }));
      });
    }
    var rt; window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(draw, 150); });
    reload();
    return { reload: reload };
  }
  window.PMXFlow = { mount: mount };
})();
`;
