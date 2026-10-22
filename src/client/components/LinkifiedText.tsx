import type { ReactNode } from "react";

// Plain text with every http(s) URL in it turned into a link that opens in a new tab. For server
// messages that end on the page to fix the problem (the Google "API turned off" refusal names the
// console page that enables it): as plain text the operator has to select and copy the address.
// Only the URL becomes markup; the rest stays text, so nothing in the message is interpreted.
const URL_RE = /https?:\/\/[^\s<>"]+/g;
// A sentence that ends on a URL puts its period (or a closing parenthesis) right after it.
const TRAILING_PUNCTUATION_RE = /[.,;:!?)]+$/;

export function LinkifiedText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    const url = match[0].replace(TRAILING_PUNCTUATION_RE, "");
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <a
        key={start}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all underline underline-offset-2"
      >
        {url}
      </a>,
    );
    last = start + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
