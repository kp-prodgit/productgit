/**
 * The page served by `pmx explain --web`. Self-contained: no external scripts, fonts or images.
 * Every value from a receipt, a skill or the PM's files is inserted with textContent, never as HTML.
 */
export const page = (nonce: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>How PMX decided · Product Git</title>
<style nonce="${nonce}">
:root {
  --bg: #f7f7f5; --panel: #ffffff; --ink: #1b1b1a; --muted: #6b6a66; --line: #e4e2dc;
  --accent: #2f5bd3; --ok: #1f7a4d; --ok-bg: #e6f3ec; --warn: #a15c00; --warn-bg: #fbf0e0; --out: #8a5a00;
  --chip: #efede7; --shadow: 0 1px 2px rgba(0,0,0,.06), 0 4px 16px rgba(0,0,0,.04);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141413; --panel: #1d1d1b; --ink: #ecebe6; --muted: #a09e97; --line: #2f2e2b;
    --accent: #8aa8ff; --ok: #5cc28f; --ok-bg: #18301f; --warn: #e3a64f; --warn-bg: #33270f; --out: #e3a64f;
    --chip: #2a2926; --shadow: none;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
header { padding: 16px 24px 0; border-bottom: 1px solid var(--line); background: var(--panel); }
header h1 { font-size: 17px; margin: 0; font-weight: 650; letter-spacing: -.01em; }
header p { margin: 2px 0 12px; color: var(--muted); font-size: 13px; }
.tabs { display: flex; gap: 4px; overflow-x: auto; }
.tabs button { all: unset; cursor: pointer; padding: 8px 14px; border-bottom: 2px solid transparent; color: var(--muted); font-weight: 550; white-space: nowrap; }
.tabs button[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--accent); }
main { max-width: 960px; margin: 0 auto; padding: 24px 24px 96px; }
h2 { font-size: 20px; letter-spacing: -.015em; margin: 0 0 4px; }
h3 { font-size: 15px; margin: 0 0 6px; }
.lede { color: var(--muted); margin: 0 0 20px; }
.muted { color: var(--muted); }
.small { font-size: 13px; }
code, .mono { font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; box-shadow: var(--shadow); margin-bottom: 12px; }
.chip { display: inline-block; background: var(--chip); border-radius: 999px; padding: 1px 10px; font-size: 12px; color: var(--muted); margin: 2px 4px 2px 0; }
.chip.ok { background: var(--ok-bg); color: var(--ok); } .chip.out { background: var(--warn-bg); color: var(--out); }
.row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
select { max-width: 100%; font: inherit; padding: 4px 8px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); }
.funnel { display: flex; flex-wrap: wrap; gap: 8px; margin: 4px 0 24px; }
.funnel .f { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 8px 12px; min-width: 104px; }
.funnel .n { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1.1; }
.funnel .l { font-size: 12px; color: var(--muted); }
.funnel .arrow { align-self: center; color: var(--muted); }
ol.steps { list-style: none; padding: 0; margin: 0; position: relative; }
ol.steps > li { position: relative; padding: 0 0 20px 44px; }
ol.steps > li::before { content: ""; position: absolute; left: 15px; top: 30px; bottom: 0; width: 2px; background: var(--line); }
ol.steps > li:last-child::before { display: none; }
.num { position: absolute; left: 0; top: 0; width: 32px; height: 32px; border-radius: 50%; background: var(--accent); color: #fff; display: grid; place-items: center; font-weight: 650; font-size: 14px; }
.src { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin: 8px 0; background: var(--panel); }
.src.used { border-left: 4px solid var(--ok); } .src.out { border-left: 4px solid var(--out); }
.src .name { font-weight: 600; word-break: break-word; }
.cut { margin: 6px 0 0 0; padding: 6px 10px; border-radius: 8px; background: var(--warn-bg); font-size: 13px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
.tw { overflow-x: auto; }
th, td { border-bottom: 1px solid var(--line); padding: 8px; text-align: left; vertical-align: top; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 600; }
details { margin-top: 8px; } summary { cursor: pointer; color: var(--accent); font-size: 13px; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.size { display: inline-grid; place-items: center; min-width: 36px; height: 28px; border-radius: 8px; background: var(--accent); color: #fff; font-weight: 700; }
.flag { color: var(--warn); font-size: 13px; }
.empty { padding: 24px; text-align: center; color: var(--muted); border: 1px dashed var(--line); border-radius: 12px; }
.err { color: var(--warn); }
[hidden] { display: none !important; }
@media (max-width: 600px) { main { padding: 16px 16px 64px; } header { padding: 12px 16px 0; } ol.steps > li { padding-left: 40px; } }
</style>
</head>
<body>
<header>
  <h1>How PMX decided</h1>
  <p>Everything here comes from your own Mac. Text that PMX left out is never stored; file names and lines are found again in your folders when you open this page.</p>
  <div class="tabs" role="tablist">
    <button role="tab" data-tab="run" aria-selected="true">Last run</button>
    <button role="tab" data-tab="rules" aria-selected="false">Privacy rules</button>
    <button role="tab" data-tab="skills" aria-selected="false">Claude skills</button>
    <button role="tab" data-tab="sizing" aria-selected="false">Task sizes</button>
  </div>
</header>
<main>
  <section id="run" role="tabpanel"></section>
  <section id="rules" role="tabpanel" hidden></section>
  <section id="skills" role="tabpanel" hidden></section>
  <section id="sizing" role="tabpanel" hidden></section>
</main>
<script nonce="${nonce}">
"use strict";
// The token arrives in the URL fragment (never sent to the server). Keep it in memory and drop it from
// the address bar and history.
const token = new URLSearchParams(location.hash.slice(1)).get("t") || "";
history.replaceState(null, "", location.pathname);

function h(tag, cls, ...kids) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}
const chip = (text, cls) => h("span", "chip" + (cls ? " " + cls : ""), text);
const plural = (n, one, many) => n + " " + (n === 1 ? one : (many || one + "s"));
const money = (n) => (n === null || n === undefined ? "cost unknown" : "$" + n.toFixed(2));

async function api(path) {
  const r = await fetch(path, { headers: { authorization: "Bearer " + token }, cache: "no-store" });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}

function fail(el, e) { el.replaceChildren(h("p", "err", "Couldn't load this: " + e.message)); }

for (const b of document.querySelectorAll(".tabs button")) {
  b.addEventListener("click", () => {
    for (const x of document.querySelectorAll(".tabs button")) x.setAttribute("aria-selected", String(x === b));
    for (const s of document.querySelectorAll("main > section")) s.hidden = s.id !== b.dataset.tab;
    load(b.dataset.tab);
  });
}
const loaded = {};
function load(tab) {
  if (loaded[tab]) return;
  loaded[tab] = true;
  ({ run: loadRuns, rules: loadRules, skills: loadSkills, sizing: loadSizing })[tab]();
}

// ---- Last run ----------------------------------------------------------------------------------
let holdLabels = {};
const MASK = { email: ["email address", "email addresses"], phone: ["phone number", "phone numbers"], card: ["card number", "card numbers"], id: ["ID number", "ID numbers"], person: ["customer name", "customer names"] };

async function loadRuns() {
  const el = document.getElementById("run");
  try {
    const [{ runs }, rules, sizing] = await Promise.all([api("/api/runs"), api("/api/rules"), api("/api/sizing")]);
    holdLabels = rules.holdLabels;
    flagText = sizing.flagText;
    if (!runs.length) {
      el.replaceChildren(h("div", "empty", "No runs yet. Run ", h("code", null, "pmx digest"), " and come back."));
      return;
    }
    const pick = h("select");
    for (const r of runs) {
      const o = h("option", null, (r.type === "digest" ? "Digest" : r.type === "todo" ? "Your to-dos" : r.dryRun ? "Suggested tasks (dry run)" : "Suggested tasks") + " · " + new Date(r.at).toLocaleString());
      o.value = r.id;
      pick.append(o);
    }
    const body = h("div");
    el.replaceChildren(h("div", "row", h("h2", null, "How this run worked"), pick), body);
    const show = async () => {
      try { renderRun(body, await api("/api/runs/" + encodeURIComponent(pick.value))); } catch (e) { fail(body, e); }
    };
    pick.addEventListener("change", show);
    await show();
  } catch (e) { fail(el, e); }
}

function renderRun(el, { receipt: r, live }) {
  const used = r.sources.filter((s) => s.decision === "used").length;
  const cuts = r.sources.reduce((n, s) => n + s.passagesCut.length, 0);
  const masked = Object.values(r.masked).reduce((a, b) => a + b, 0);
  const lede = h("p", "lede", r.type === "digest"
    ? "PMX reads your call transcripts, removes anything personal, masks contact details, then asks Claude to write a digest where every claim cites a call. You approve it before anyone else sees it."
    : r.type === "todo"
    ? "PMX reads your own meetings, including 1:1s, cuts health, pay and performance passages, masks contact details, then asks Claude for the things you committed to. Your to-dos never leave this Mac."
    : "PMX reads the team's sources, removes anything personal, then asks Claude to suggest tasks and size each one with the team rubric. A person triages them before any agent runs.");

  const f = (n, l) => h("div", "f", h("div", "n", n), h("div", "l", l));
  const arrow = () => h("div", "arrow", "→");
  const funnel = h("div", "funnel", f(r.sources.length, "found"), arrow(), f(used, "used"), arrow(), f(cuts, cuts === 1 ? "passage cut" : "passages cut"), arrow(), f(masked, "masked"), arrow(),
    f(r.model ? money(r.model.costUsd) : "–", "Claude"), arrow(), f(r.digest ? r.digest.cited.length : r.synth ? r.synth.tasks.length : r.todo ? r.todo.added.length : "–", r.digest ? "sources cited" : r.todo ? "to-dos" : "tasks"));

  const steps = h("ol", "steps");
  const step = (n, title, ...kids) => steps.append(h("li", null, h("div", "num", n), h("h3", null, title), ...kids));

  const folders = r.rules.folders.length ? r.rules.folders.join(", ") : "your sources";
  step(1, "Found " + plural(r.sources.length, "conversation"),
    h("p", "muted small", "Looked in " + folders + " for files from the last " + r.window.days + " days (" + new Date(r.window.since).toLocaleDateString() + " onward)."),
    r.skippedSources.map((s) => h("p", "small", "Skipped: " + s)));

  const list = r.sources.map((s, i) => {
    const l = live[i] || { file: null, title: null, cuts: [] };
    const name = s.file || l.file || (s.kind === "slack" ? "A Slack message" : "A file that's no longer in your folder");
    const title = s.title || l.title;
    const card = h("div", "src " + (s.decision === "used" ? "used" : "out"),
      h("div", "row", s.decision === "used" ? chip("Used · " + s.id, "ok") : chip("Left out", "out"), h("span", "name", name)),
      title && title !== name ? h("div", "muted small", title) : null,
      h("div", "small", s.decision === "used" ? "Why: " + s.detail + "." : "Rule: " + holdLabels[s.rule] + ", because " + s.detail + "."));
    const cutsLive = l.cuts.length ? l.cuts : s.passagesCut.map((c) => ({ rule: c.rule, line: null, matched: null }));
    for (const c of cutsLive)
      card.append(h("div", "cut", "Cut " + (c.line ? "the passage at line " + c.line : "one passage") + ": " + holdLabels[c.rule] + (c.matched ? " (matched “" + c.matched + "”)" : "") + ". The text was not sent or stored."));
    if (s.ledger) card.append(h("div", "small", LEDGER[s.ledger.state] + (s.ledger.entry ? " (" + s.ledger.entry + ")" : "") + "."));
    if (s.decision === "used") card.append(h("div", "muted small", plural(s.passagesUsed, "passage") + " sent to Claude."));
    return card;
  });
  step(2, "Privacy rules decided what Claude may read",
    h("p", "muted small", r.rules.allowOneOnOne
      ? "Your own to-dos may come from internal meetings and 1:1s, because they stay on this Mac. Passages about performance, pay or health are still cut. See the Privacy rules tab for the exact rules."
      : "Only calls with someone from outside your company are used, and passages about 1:1s, performance, pay or health are always cut. Meetings the team already processed are skipped. See the Privacy rules tab for the exact rules."),
    list);

  const m = Object.entries(r.masked).filter(([, n]) => n).map(([k, n]) => chip(plural(n, MASK[k][0], MASK[k][1])));
  step(3, "Masked before Claude saw it",
    m.length ? h("div", null, m) : h("p", "muted small", "Nothing needed masking."),
    h("p", "muted small", "Emails, phone numbers, card and ID numbers, and names on your customer list are replaced with placeholders such as [PHONE]. The real values are never stored."));

  if (r.model) {
    step(4, "Claude wrote the draft",
      h("div", "row", chip(r.model.name), r.skills.map((k) => chip(k.name + " · " + (k.source === "team" ? "team copy" : "built-in copy") + " · " + k.version))),
      h("p", "small", "Tools: " + r.model.tools + "."),
      h("p", "muted small", money(r.model.costUsd) + " · " + (r.model.durationMs / 1000).toFixed(1) + " seconds" + (r.model.tokens ? " · " + r.model.tokens.toLocaleString() + " tokens" : "")),
      h("details", null, h("summary", null, "Prompt fingerprint"), h("p", "small muted", "The prompt is not stored. Its SHA-256 is ", h("code", null, r.model.promptSha256), ", so you can prove two runs got the same input.")));
  } else {
    step(4, "Claude was not called", h("p", "muted small", r.outcome === "no-signal" ? "Nothing was left to read after the privacy rules, so no model ran and nothing was spent." : "The run stopped before calling Claude."));
  }

  if (r.digest) {
    step(5, "Citation check", h("p", "small", plural(r.digest.cited.length, "source") + " cited. " + plural(r.digest.removedClaims, "claim") + " removed because it didn't cite a source PMX gave Claude."));
    step(6, "Draft waits for you", h("p", "small", "Saved at ", h("code", null, r.digest.staged), ". Only on your Mac. Approve, edit or reject it with ", h("code", null, "pmx digest --review"), "; approving commits it to your team folder."));
  }
  if (r.synth) {
    step(5, plural(r.synth.tasks.length, "suggested task"), r.synth.tasks.map(taskCard), r.synth.skipped.map((s) => h("p", "small muted", "Skipped: " + s)));
  }
  if (r.todo) {
    step(5, plural(r.todo.added.length, "new to-do"),
      r.todo.added.map((t) => h("div", "card", h("strong", null, t.text), h("div", "muted small", "From " + t.source + (t.due ? " · due " + t.due : "")))),
      r.todo.duplicates ? h("p", "small muted", plural(r.todo.duplicates, "to-do") + " already on your list, so not added again.") : null,
      r.todo.dropped.map((d) => h("p", "small muted", "Dropped: " + d)));
  }
  if (r.error) steps.append(h("li", null, h("div", "num", "!"), h("h3", null, "The run failed"), h("p", "err", r.error)));
  el.replaceChildren(lede, funnel, steps);
}

const LEDGER = {
  "processed-now": "Processed in this run",
  "would-process": "Would be processed (dry run)",
  "already-processed": "Skipped: already processed",
  "in-progress-elsewhere": "Skipped: another machine is processing it",
  "before-window": "Skipped: before this run's start date",
};
let flagText = {};
function taskCard(t) {
  const s = t.sizing;
  return h("div", "card",
    h("div", "row", h("span", "size", t.size), h("strong", null, t.title)),
    h("div", "muted small", t.category + " · " + plural(t.sources.length, "source") + ": " + t.sources.join(", ")),
    s ? h("div", "small", "Rubric cell it matched: “" + (s.cell || "none given") + "”" + (s.expectedCell && s.cell !== s.expectedCell ? " (the rubric says “" + s.expectedCell + "”)" : "")) : h("div", "small muted", "No sizing reason recorded."),
    s && s.why ? h("div", "small", "Why: " + s.why) : null,
    s ? s.flags.map((f) => h("div", "flag", "Check the size: " + (flagText[f] || f) + ".")) : null);
}

// ---- Privacy rules ------------------------------------------------------------------------------
async function loadRules() {
  const el = document.getElementById("rules");
  try {
    const r = await api("/api/rules");
    const list = (xs, empty) => (xs.length ? h("div", null, xs.map((x) => chip(x))) : h("p", "muted small", empty));
    const topics = Object.entries(r.topics).map(([, t]) => h("div", "card",
      h("h3", null, t.label),
      h("p", "small muted", "Any passage that mentions one of these is cut, for example:"),
      h("div", null, t.examples.map((x) => chip(x))),
      h("details", null, h("summary", null, "Exact patterns"), h("div", "mono small", t.patterns.join("  |  ")))));
    el.replaceChildren(
      h("h2", null, "Privacy rules"),
      h("p", "lede", "These rules run on your Mac before Claude sees anything. They are fixed and the same for everyone on your team, so a run is never a judgement call."),
      h("div", "grid2",
        h("div", "card", h("h3", null, "1. Which files PMX reads"),
          h("p", "small", "Only these folders, only files from the last 7 days, and only text files (.md, .txt, .vtt, .srt). Recordings are never read."),
          list(r.folders, "No folder set up."),
          h("p", "small muted", "Sources your team allows: " + r.allowedSources.join(", ") + (r.slackChannels.length ? " · Slack channels: " + r.slackChannels.join(", ") : ""))),
        h("div", "card", h("h3", null, "2. Customer calls only"),
          h("p", "small", "A call is used only if at least one participant has an email outside your company's domains. A file with no participant list is left out."),
          list(r.internalDomains, "No company domains set, so anyone with an email counts as outside. Add yours to internalDomains in pmx.config.json.")),
        h("div", "card", h("h3", null, "3. Your do-not-read list"),
          h("p", "small", "Anything involving these people, meeting titles or channels is left out. Only you see this list; receipts record how many entries it has, not what they are."),
          h("p", "small muted", "People"), list(r.neverIngest.people, "None"),
          h("p", "small muted", "Meeting titles"), list(r.neverIngest.meetingTitles, "None"),
          h("p", "small muted", "Channels"), list(r.neverIngest.channels, "None"),
          h("p", "small muted", "Change it with pmx init.")),
        h("div", "card", h("h3", null, "4. Masked before Claude sees it"),
          h("p", "small", "Email addresses, phone numbers, card numbers that pass a checksum, US Social Security numbers, and names on your customer list become [EMAIL], [PHONE], [CARD], [ID] and [PERSON-n]."))),
      h("h3", null, "5. Topics that are always cut"),
      h("p", "small muted", "If a meeting title matches the 1:1 rule, the whole meeting is left out. Otherwise PMX cuts only the passages that match."),
      h("div", "grid2", topics),
      h("div", "card", h("h3", null, "6. What Claude can do during a run"),
        h("p", "small", "PMX runs Claude in its own profile at " + r.profile + ". It can't see your personal Claude Code memory, settings, plugins or connectors. For digests and suggested tasks it gets no tools at all: it reads the masked text and writes text back. Source text is marked as data, so instructions inside a call are ignored.")));
  } catch (e) { fail(el, e); }
}

// ---- Skills -------------------------------------------------------------------------------------
async function loadSkills() {
  const el = document.getElementById("skills");
  try {
    const { skills, profile } = await api("/api/skills");
    el.replaceChildren(
      h("h2", null, "Claude skills"),
      h("p", "lede", "A skill is a set of written instructions Claude follows for one job. PMX uses the copy in your team folder if there is one, otherwise the copy built into pmx. They only load in PMX's own Claude profile (" + profile + "), never in your personal Claude Code. “Differs from built-in” means your team edited its copy, or this version of pmx ships a newer one."),
      ...skills.map((s) => h("div", "card",
        h("div", "row", h("h3", null, s.name), chip(s.status, s.status === "differs from built-in" ? "out" : ""), s.category ? chip(s.category) : null),
        h("p", "small", s.description),
        h("p", "small", h("strong", null, "When it runs: "), s.usedBy),
        h("p", "small muted mono", s.path + " · version " + s.version))));
  } catch (e) { fail(el, e); }
}

// ---- Sizing -------------------------------------------------------------------------------------
async function loadSizing() {
  const el = document.getElementById("sizing");
  try {
    const s = await api("/api/sizing");
    flagText = s.flagText;
    const sizes = ["S", "M", "L", "XL"];
    const general = h("table", null, h("thead", null, h("tr", null, h("th", null, "Size"), h("th", null, "Rubric"), h("th", null, "Team estimate"))),
      h("tbody", null, sizes.map((z) => h("tr", null, h("td", null, h("span", "size", z)),
        h("td", null, (s.rubric.general[z] || {}).rule || "", h("div", "muted small", (s.rubric.general[z] || {}).run || "")),
        h("td", null, s.sizes[z] ? "~" + s.sizes[z].minutes + " min · ~$" + s.sizes[z].costUsd.toFixed(2) : "")))));
    const cats = Object.keys(s.rubric.cells);
    const grid = h("table", null, h("thead", null, h("tr", null, h("th", null, "Category"), sizes.map((z) => h("th", null, z)))),
      h("tbody", null, cats.map((c) => h("tr", null, h("td", null, h("strong", null, c)), sizes.map((z) => {
        const range = (s.rubric.ranges[c] || {})[z];
        return h("td", null, s.rubric.cells[c][z], range ? h("div", "muted small", "checked: " + range[0] + (range[1] === null ? "+" : "–" + range[1]) + " sources") : null);
      })))));
    const tasks = s.latest && s.latest.tasks.length
      ? [h("h3", null, "Sizes in the last suggested-task run (" + new Date(s.latest.at).toLocaleString() + ")"), s.latest.tasks.map(taskCard)]
      : [h("div", "empty", "No suggested tasks yet. Sizes are chosen when you run ", h("code", null, "pmx synthesize"), ", which needs Linear.")];
    el.replaceChildren(
      h("h2", null, "How task sizes are chosen"),
      h("p", "lede", "A size is the agent effort to produce a reviewable draft, not engineering effort. Claude picks it with the team rubric below and must quote the cell it matched. PMX then checks that cell against the rubric and, where the rubric counts sources, the number of sources the task cites. A disagreement is flagged for the person triaging; it never blocks the task, and anyone can change a size."),
      h("div", "card", h("h3", null, "General rule"), h("div", "tw", general)),
      h("div", "card", h("h3", null, "Per category"), h("div", "tw", grid), h("p", "small muted", "From the pmx-size skill (" + (s.source === "team" ? "team copy" : "built-in copy") + ", version " + s.version + "). When unsure between two sizes, Claude picks the larger one.")),
      ...tasks.flat());
  } catch (e) { fail(el, e); }
}

load("run");
</script>
</body>
</html>`;
