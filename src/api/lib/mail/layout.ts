import { currentLocale, type Locale } from "@/api/lib/i18n";

// The app palette, copied from the tokens in `public/index.css` because mail clients do not resolve CSS
// custom properties: every color has to be a literal in an inline style. Keyed by token name so
// tests/api/lib/mail/layout.test.ts can hold each value to the stylesheet; a retheme that forgets this
// file fails there instead of shipping mail in the old colors. Light is the base (most clients ignore
// dark-mode CSS, and the ones that apply their own inversion do it from a light design); dark is applied
// through `prefers-color-scheme` where the client supports it.
export const EMAIL_THEME = {
  light: {
    "bg-primary": "#f5f5f4",
    "bg-secondary": "#ffffff",
    border: "#e8e8e6",
    "text-primary": "#1c1c1a",
    "text-secondary": "#45443f",
    "text-muted": "#66655f",
    accent: "#4b55c8",
    "accent-solid": "#5e6ad2",
    "accent-foreground": "#ffffff",
  },
  dark: {
    "bg-primary": "#0f0f0e",
    "bg-secondary": "#151514",
    border: "#ffffff12",
    "text-primary": "#f7f7f5",
    "text-secondary": "#c9c8c4",
    "text-muted": "#979690",
    accent: "#828fff",
    "accent-solid": "#5e6ad2",
    "accent-foreground": "#ffffff",
  },
} as const;

const FONT_STACK =
  "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO_STACK =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export type EmailBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  // a call to action. The renderer adds the copy-this-link fallback
  // under it, in both parts, so no template can forget it.
  | { type: "button"; label: string; url: string }
  // secondary text: expiry, "ignore this if it wasn't you".
  | { type: "note"; text: string }
  // a value the reader copies by hand (a one-time code).
  | { type: "code"; text: string };

export interface EmailContent {
  subject: string;
  // Whose message this is, in the header and the signature. The mail goes out on behalf of a workspace
  // (the dashboard's owner), so the name is the workspace's, not the product's.
  brandName: string;
  // the preview line inbox lists show after the subject. Without it
  // clients show the first text they find, usually the alt text of the logo.
  preheader: string;
  blocks: EmailBlock[];
  // why the reader got this message. Rendered under the card.
  footer?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// every string reaching the HTML goes through this, translated copy
// included: the API i18n instance runs with `escapeValue: false`, so a value
// interpolated into a catalog string (a user's name) arrives raw.
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

// refuses anything but http(s). The URLs come from our own code, so a
// `javascript:` or a relative path here is a bug, and throwing surfaces it in
// the test suite instead of mailing a dead or hostile button.
function assertHttpUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Email button URL is not absolute: "${url}"`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Email button URL must be http(s): "${url}"`);
  }
  return parsed.toString();
}

const BUTTON_FALLBACK: Record<Locale, string> = {
  en: "If the button doesn't work, copy this link into your browser:",
  "pt-BR": "Se o botão não funcionar, copie este link no navegador:",
};

const light = EMAIL_THEME.light;
const dark = EMAIL_THEME.dark;

function renderBlockHtml(block: EmailBlock, locale: Locale): string {
  switch (block.type) {
    case "heading":
      return `<h1 class="bf-text" style="margin:0 0 16px;font-size:20px;line-height:28px;font-weight:600;color:${light["text-primary"]};">${escapeHtml(block.text)}</h1>`;
    case "paragraph":
      return `<p class="bf-text-secondary" style="margin:0 0 16px;font-size:15px;line-height:24px;color:${light["text-secondary"]};">${escapeHtml(block.text)}</p>`;
    case "note":
      return `<p class="bf-muted" style="margin:0 0 16px;font-size:13px;line-height:20px;color:${light["text-muted"]};">${escapeHtml(block.text)}</p>`;
    case "code":
      return `<p class="bf-code" style="margin:8px 0 24px;padding:16px;border-radius:8px;background:${light["bg-primary"]};font-family:${MONO_STACK};font-size:32px;line-height:40px;font-weight:600;letter-spacing:8px;text-align:center;color:${light["text-primary"]};">${escapeHtml(block.text)}</p>`;
    case "button": {
      const url = escapeHtml(assertHttpUrl(block.url));
      const fallback = escapeHtml(BUTTON_FALLBACK[locale]);
      // a table-cell button, the one shape that renders as a button in
      // Outlook for Windows too (it ignores padding and radius on <a>).
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr><td align="center" bgcolor="${light["accent-solid"]}" style="border-radius:8px;background:${light["accent-solid"]};"><a href="${url}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 24px;font-family:${FONT_STACK};font-size:15px;line-height:20px;font-weight:600;color:${light["accent-foreground"]};text-decoration:none;border-radius:8px;">${escapeHtml(block.label)}</a></td></tr></table><p class="bf-muted" style="margin:0 0 16px;font-size:12px;line-height:18px;color:${light["text-muted"]};">${fallback}<br><a href="${url}" target="_blank" rel="noopener" class="bf-link" style="color:${light.accent};word-break:break-all;">${url}</a></p>`;
    }
  }
}

function renderBlockText(block: EmailBlock): string {
  switch (block.type) {
    case "heading":
    case "paragraph":
    case "note":
    case "code":
      return block.text;
    case "button":
      return `${block.label}:\n${assertHttpUrl(block.url)}`;
  }
}

// The one layout every transactional message renders through. The HTML and the plain-text part are built
// from the SAME blocks: a text part written by hand next to the HTML drifts (a changed link, a dropped
// sentence), and the text part is what spam filters, plain-text clients and the dev console transport
// actually show.
export function renderEmail(content: EmailContent): RenderedEmail {
  const locale = currentLocale();
  const appName = content.brandName;
  const body = content.blocks
    .map((block) => renderBlockHtml(block, locale))
    .join("\n");
  const footer = content.footer
    ? `<p style="margin:0 0 8px;">${escapeHtml(content.footer)}</p>`
    : "";

  const html = `<!doctype html>
<html lang="${escapeHtml(locale)}" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(content.subject)}</title>
<style>
body { margin: 0; padding: 0; -webkit-text-size-adjust: 100%; }
@media (prefers-color-scheme: dark) {
  .bf-page { background: ${dark["bg-primary"]} !important; }
  .bf-card { background: ${dark["bg-secondary"]} !important; border-color: ${dark.border} !important; }
  .bf-text { color: ${dark["text-primary"]} !important; }
  .bf-text-secondary { color: ${dark["text-secondary"]} !important; }
  .bf-muted { color: ${dark["text-muted"]} !important; }
  .bf-code { background: ${dark["bg-primary"]} !important; color: ${dark["text-primary"]} !important; }
  .bf-link { color: ${dark.accent} !important; }
}
@media (max-width: 600px) {
  .bf-card { padding: 24px !important; }
}
</style>
</head>
<body class="bf-page" style="margin:0;padding:0;background:${light["bg-primary"]};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(content.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bf-page" style="background:${light["bg-primary"]};">
<tr><td align="center" style="padding:40px 16px;font-family:${FONT_STACK};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
<tr><td align="center" style="padding:0 0 24px;">
<p class="bf-text" style="margin:0;font-size:16px;line-height:24px;font-weight:600;color:${light["text-primary"]};">${escapeHtml(appName)}</p>
</td></tr>
<tr><td class="bf-card" style="background:${light["bg-secondary"]};border:1px solid ${light.border};border-radius:12px;padding:32px;font-family:${FONT_STACK};">
${body}
</td></tr>
<tr><td class="bf-muted" align="center" style="padding:24px 8px 0;font-family:${FONT_STACK};font-size:12px;line-height:18px;color:${light["text-muted"]};">
${footer}<p style="margin:0;">${escapeHtml(appName)}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;

  const text = [
    ...content.blocks.map(renderBlockText),
    ...(content.footer ? ["--", content.footer] : ["--"]),
    appName,
  ].join("\n\n");

  return { subject: content.subject, html, text: `${text}\n` };
}
