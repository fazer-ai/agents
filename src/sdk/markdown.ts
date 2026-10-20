// The small markdown the widget renders an agent's reply in: paragraphs, bullet and numbered lists,
// fenced code, inline code, bold, italic and http(s) links. Built as DOM nodes with `textContent`,
// never as an HTML string, so nothing the model writes can become markup on the host's page.

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]\n]+\]\([^)\s]+\))/;

function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function renderInline(doc: Document, text: string, into: Node): void {
  let rest = text;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      into.appendChild(doc.createTextNode(rest));
      return;
    }
    if (m.index > 0)
      into.appendChild(doc.createTextNode(rest.slice(0, m.index)));
    const token = m[0];
    if (m[1]) {
      const code = doc.createElement("code");
      code.textContent = token.slice(1, -1);
      into.appendChild(code);
    } else if (m[2]) {
      const strong = doc.createElement("strong");
      renderInline(doc, token.slice(2, -2), strong);
      into.appendChild(strong);
    } else if (m[3]) {
      const em = doc.createElement("em");
      renderInline(doc, token.slice(1, -1), em);
      into.appendChild(em);
    } else {
      const close = token.indexOf("](");
      const label = token.slice(1, close);
      const href = safeHref(token.slice(close + 2, -1));
      if (href) {
        const a = doc.createElement("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = label;
        into.appendChild(a);
      } else {
        into.appendChild(doc.createTextNode(label));
      }
    }
    rest = rest.slice(m.index + token.length);
  }
}

export function renderMarkdown(doc: Document, text: string): DocumentFragment {
  const out = doc.createDocumentFragment();
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.trimStart().startsWith("```")) {
      const body: string[] = [];
      i++;
      while (
        i < lines.length &&
        !(lines[i] as string).trimStart().startsWith("```")
      )
        body.push(lines[i++] as string);
      i++;
      const pre = doc.createElement("pre");
      const code = doc.createElement("code");
      code.textContent = body.join("\n");
      pre.appendChild(code);
      out.appendChild(pre);
      continue;
    }
    const bullet = /^\s*[-*]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    const marker = bullet.test(line)
      ? bullet
      : numbered.test(line)
        ? numbered
        : null;
    if (marker) {
      const list = doc.createElement(marker === bullet ? "ul" : "ol");
      while (i < lines.length && marker.test(lines[i] as string)) {
        const li = doc.createElement("li");
        renderInline(doc, (lines[i] as string).replace(marker, ""), li);
        list.appendChild(li);
        i++;
      }
      out.appendChild(list);
      continue;
    }
    const p = doc.createElement("p");
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] as string).trim() !== "" &&
      !bullet.test(lines[i] as string) &&
      !numbered.test(lines[i] as string) &&
      !(lines[i] as string).trimStart().startsWith("```")
    )
      para.push(lines[i++] as string);
    para.forEach((l, n) => {
      if (n > 0) p.appendChild(doc.createElement("br"));
      renderInline(doc, l, p);
    });
    out.appendChild(p);
  }
  return out;
}
