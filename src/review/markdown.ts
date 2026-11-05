/**
 * A small, safe markdown renderer for the review page. HTML in the draft is always escaped:
 * drafts are model output derived from customer text, so they are never trusted as markup.
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function inline(s: string, cites: Record<string, string>): string {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`);
  t = t.replace(/\[((?:[A-Z]\d+)(?:,\s*[A-Z]\d+)*)\]/g, (_m, ids: string) =>
    ids.split(/,\s*/).map((id) => `<span class="cite${cites[id] ? "" : " missing"}" tabindex="0" data-quote="${esc(cites[id] ?? "No quote for this source in the task.")}">${id}</span>`).join(""),
  );
  return t;
}

export function renderMarkdown(md: string, cites: Record<string, string> = {}): string {
  const lines = md.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "), cites)}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^```/.test(line)) {
      flushPara();
      closeList();
      const code: string[] = [];
      while (++i < lines.length && !/^```/.test(lines[i]!)) code.push(lines[i]!);
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara();
      closeList();
      out.push(`<h${h[1]!.length}>${inline(h[2]!, cites)}</h${h[1]!.length}>`);
      continue;
    }
    if (/^\|.*\|\s*$/.test(line) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      flushPara();
      closeList();
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i++;
      const body: string[][] = [];
      while (i + 1 < lines.length && /^\|.*\|\s*$/.test(lines[i + 1]!)) body.push(cells(lines[++i]!));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c, cites)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c, cites)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const li = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flushPara();
      const kind = /\d/.test(li[1]!) ? "ol" : "ul";
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline(li[2]!.replace(/^\[[ x]\]\s+/, ""), cites)}</li>`);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }
    closeList();
    para.push(line.trim());
  }
  flushPara();
  closeList();
  return out.join("\n");
}
