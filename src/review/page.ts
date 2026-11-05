/** The review page served by `pmx review --web`. Self-contained: no external scripts, fonts or images. */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review queue · Product Git</title>
<style>
:root {
  --bg: #f7f7f5; --panel: #ffffff; --ink: #1b1b1a; --muted: #6b6a66; --line: #e4e2dc;
  --accent: #2f5bd3; --ok: #1f7a4d; --warn: #a15c00; --bad: #b3261e; --chip: #efede7;
  --cite-bg: #e8eefc; --cite-ink: #2443a3; --shadow: 0 1px 2px rgba(0,0,0,.06), 0 4px 16px rgba(0,0,0,.04);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141413; --panel: #1d1d1b; --ink: #ecebe6; --muted: #a09e97; --line: #2f2e2b;
    --accent: #8aa8ff; --ok: #5cc28f; --warn: #e3a64f; --bad: #ff8a80; --chip: #2a2926;
    --cite-bg: #233056; --cite-ink: #c3d2ff; --shadow: none;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
header { display: flex; align-items: baseline; gap: 12px; padding: 16px 24px; border-bottom: 1px solid var(--line); }
header h1 { font-size: 16px; margin: 0; font-weight: 650; letter-spacing: -.01em; }
header .sub { color: var(--muted); font-size: 13px; }
main { display: grid; grid-template-columns: 300px 1fr; min-height: calc(100vh - 57px); }
nav { border-right: 1px solid var(--line); padding: 12px; overflow-y: auto; }
nav button { all: unset; display: block; width: 100%; padding: 10px 12px; border-radius: 8px; cursor: pointer; box-sizing: border-box; }
nav button:hover { background: var(--chip); }
nav button[aria-current="true"] { background: var(--panel); box-shadow: var(--shadow); outline: 1px solid var(--line); }
nav .id { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
nav .t { display: block; font-weight: 550; margin-top: 2px; }
section#draft { padding: 24px 32px 120px; max-width: 900px; width: 100%; }
.meta { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 20px; }
.chip { background: var(--chip); border-radius: 999px; padding: 2px 10px; font-size: 12px; color: var(--muted); }
.chip.ok { color: var(--ok); } .chip.warn { color: var(--warn); } .chip.bad { color: var(--bad); }
h2.title { font-size: 22px; line-height: 1.25; margin: 0; letter-spacing: -.015em; }
a { color: var(--accent); }
.file { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 4px 24px 16px; margin-bottom: 16px; box-shadow: var(--shadow); }
.file .path { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); padding-top: 12px; }
.file h1 { font-size: 20px; } .file h2 { font-size: 17px; margin-top: 24px; } .file h3 { font-size: 15px; }
.file table { border-collapse: collapse; width: 100%; font-size: 14px; display: block; overflow-x: auto; }
.file th, .file td { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
.file pre { background: var(--chip); padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 13px; }
.cite { position: relative; display: inline-block; background: var(--cite-bg); color: var(--cite-ink); border-radius: 4px; padding: 0 5px; margin: 0 1px; font-size: 12px; font-weight: 600; cursor: help; }
.cite.missing { background: transparent; outline: 1px dashed var(--bad); color: var(--bad); }
.cite:hover::after, .cite:focus::after { content: attr(data-quote); position: absolute; left: 0; top: 1.8em; z-index: 5; width: min(360px, 80vw); background: var(--panel); color: var(--ink); border: 1px solid var(--line); box-shadow: 0 8px 24px rgba(0,0,0,.15); border-radius: 8px; padding: 10px 12px; font-weight: 400; font-size: 13px; line-height: 1.45; white-space: normal; }
.bar { position: fixed; bottom: 0; left: 300px; right: 0; background: var(--panel); border-top: 1px solid var(--line); padding: 12px 32px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.bar input { flex: 1 1 240px; min-width: 0; font: inherit; padding: 9px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); }
.bar button { font: inherit; font-weight: 600; padding: 9px 16px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); cursor: pointer; }
.bar button.accept { background: var(--ok); color: #fff; border-color: transparent; }
.bar button:disabled { opacity: .5; cursor: default; }
.bar kbd { font: 11px ui-monospace, monospace; color: var(--muted); margin-left: 4px; }
.empty { color: var(--muted); padding: 48px 0; text-align: center; }
#toast { position: fixed; top: 16px; right: 16px; background: var(--ink); color: var(--bg); padding: 8px 14px; border-radius: 8px; font-size: 14px; opacity: 0; transition: opacity .2s; pointer-events: none; }
#toast.show { opacity: 1; }
@media (max-width: 760px) {
  main { grid-template-columns: 1fr; }
  nav { border-right: 0; border-bottom: 1px solid var(--line); display: flex; overflow-x: auto; gap: 6px; padding: 8px 16px; }
  nav button { width: auto; min-width: 180px; }
  section#draft { padding: 16px 16px 180px; }
  .file { padding: 4px 16px 12px; }
  .bar { left: 0; padding: 12px 16px; }
  header { padding: 12px 16px; }
}
</style>
</head>
<body>
<header><h1>Review queue</h1><span class="sub" id="sub">Loading…</span></header>
<main>
  <nav id="list" aria-label="Drafts waiting for review"></nav>
  <section id="draft"><p class="empty">Loading drafts…</p></section>
</main>
<div class="bar" id="bar" hidden>
  <input id="note" placeholder="Note for redo or reject (required for those)" aria-label="Note">
  <button class="accept" id="accept">Accept<kbd>A</kbd></button>
  <button id="redo">Redo with note<kbd>R</kbd></button>
  <button id="reject">Reject<kbd>X</kbd></button>
</div>
<div id="toast" role="status"></div>
<script>
const TOKEN = "__TOKEN__";
let items = [], current = null;
const $ = (id) => document.getElementById(id);
const escText = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 2500); }
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "x-pmx-token": TOKEN, ...(opts.body ? { "content-type": "application/json" } : {}) } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}
function renderList() {
  $("list").innerHTML = items.map((i) => '<button data-id="' + escText(i.id) + '" aria-current="' + (current && current.id === i.id) + '"><span class="id">' + escText(i.identifier) + ' · ' + escText(i.category) + ' · ' + escText(i.size) + '</span><span class="t">' + escText(i.title) + '</span></button>').join("");
  for (const b of $("list").querySelectorAll("button")) b.onclick = () => select(b.dataset.id);
}
function select(id) {
  current = items.find((i) => i.id === id) || null;
  renderList();
  $("bar").hidden = !current;
  if (!current) { $("draft").innerHTML = '<p class="empty">Nothing waiting for review. Nice.</p>'; return; }
  const r = current.record;
  const chips = r
    ? ['<span class="chip">' + escText(r.skill) + '</span>', '<span class="chip">' + escText(r.model) + '</span>', '<span class="chip">' + escText(r.agent) + '</span>', '<span class="chip">' + r.minutes + ' min' + (r.costUsd != null ? ' · $' + r.costUsd.toFixed(2) : '') + '</span>',
       '<span class="chip ' + (r.cleanProfile ? 'ok">✓ clean profile' : 'bad">✗ ' + escText(r.failedChecks.join(", "))) + '</span>',
       '<span class="chip ' + (r.checklistOk ? 'ok">✓ checklist' : 'warn">⚠ ' + escText(r.checklistProblems.join("; "))) + '</span>']
    : ['<span class="chip bad">No run record</span>'];
  $("draft").innerHTML = '<h2 class="title">' + escText(current.title) + '</h2><div class="meta"><a class="chip" href="' + escText(current.url) + '" target="_blank" rel="noopener">' + escText(current.identifier) + '</a>' + (current.prUrl.startsWith("http") ? '<a class="chip" href="' + escText(current.prUrl) + '" target="_blank" rel="noopener">Pull request</a>' : '<span class="chip">' + escText(current.prUrl) + '</span>') + chips.join("") + '</div>' +
    current.files.map((f) => '<div class="file"><div class="path">' + escText(f.path) + '</div>' + f.html + '</div>').join("");
  $("note").value = "";
}
async function decide(kind) {
  if (!current) return;
  const note = $("note").value.trim();
  if (kind !== "accept" && !note) { $("note").focus(); toast("Add a note first"); return; }
  for (const b of $("bar").querySelectorAll("button")) b.disabled = true;
  try {
    const r = await api("/api/items/" + encodeURIComponent(current.id) + "/" + kind, { method: "POST", body: JSON.stringify({ note }) });
    toast(r.message);
    items = items.filter((i) => i !== current);
    select(items[0] && items[0].id);
    $("sub").textContent = items.length + " waiting";
  } catch (e) { toast("Failed: " + e.message); }
  for (const b of $("bar").querySelectorAll("button")) b.disabled = false;
}
$("accept").onclick = () => decide("accept");
$("redo").onclick = () => decide("redo");
$("reject").onclick = () => decide("reject");
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.metaKey || e.ctrlKey) return;
  if (e.key === "a") decide("accept");
  if (e.key === "r") { $("note").focus(); e.preventDefault(); }
  if (e.key === "x") decide("reject");
});
api("/api/queue").then((d) => { items = d.items; $("sub").textContent = items.length + " waiting · reviewing as " + d.reviewer; select(items[0] && items[0].id); })
  .catch((e) => { $("draft").innerHTML = '<p class="empty">Could not load the queue: ' + escText(e.message) + '</p>'; });
</script>
</body>
</html>
`;
