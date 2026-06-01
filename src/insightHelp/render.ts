// Minimal markdown→HTML renderer for insight help cards. Content is bundled
// from local .md files we author ourselves, so we don't need a full parser
// (no user input → no XSS surface). Handles the subset we actually use:
// `## Heading`, paragraphs, `- bullets`, **bold**, `inline code`, blank-line
// separation. HTML-special characters are escaped before any markup is added.

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function inline(s: string): string {
  // Order matters: escape first, then layer bold/code on top of escaped text.
  let out = escapeHtml(s);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return out;
}

export function renderInsightHelp(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let listItems: string[] | null = null;

  const flushPara = () => {
    if (para.length === 0) return;
    out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (listItems === null) return;
    out.push("<ul>" + listItems.map((i) => `<li>${inline(i)}</li>`).join("") + "</ul>");
    listItems = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      flushPara();
      flushList();
      continue;
    }
    if (line.startsWith("## ")) {
      flushPara();
      flushList();
      out.push(`<h4>${inline(line.slice(3))}</h4>`);
      continue;
    }
    if (line.startsWith("- ")) {
      flushPara();
      if (listItems === null) listItems = [];
      listItems.push(line.slice(2));
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return out.join("");
}
