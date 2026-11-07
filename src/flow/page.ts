import { FLOW_CSS, FLOW_JS } from "./render.js";

/**
 * The flow page on this Mac (FLOW-2), served by the same loopback server as `pmx explain --web`, under the same
 * token and nonce rules. It shows held items by the file and title found again in the PM's folders, so it
 * never leaves 127.0.0.1.
 */
export const flowPage = (nonce: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>PMX flow · Product Git</title>
<style nonce="${nonce}">
body { margin: 0; background: #f6f7f9; padding: 16px max(16px, env(safe-area-inset-left)) 48px; }
@media (prefers-color-scheme: dark) { body { background: #12161c; } }
.note { font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #5f6878; margin: 0 0 12px; }
@media (prefers-color-scheme: dark) { .note { color: #9aa3b2; } }
${FLOW_CSS}
</style>
</head>
<body>
<p class="note">Only this Mac can open this page. Held meetings show the file found again in your folders; their text was never stored or sent. See one run in full with <code>pmx explain</code>.</p>
<div id="flow"></div>
<script nonce="${nonce}">
${FLOW_JS}
(function () {
  "use strict";
  var token = new URLSearchParams(location.hash.slice(1)).get("t") || "";
  history.replaceState(null, "", location.pathname);
  window.PMXFlow.mount(document.getElementById("flow"), {
    mode: "local",
    load: function (hours, scope) {
      return fetch("/api/flow?hours=" + hours + "&scope=" + scope, { headers: { authorization: "Bearer " + token }, cache: "no-store" })
        .then(function (r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b.error || r.statusText); return b.graph; }); });
    },
  });
})();
</script>
</body>
</html>
`;
