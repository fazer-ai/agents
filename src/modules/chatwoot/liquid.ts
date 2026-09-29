// Text the model wrote, made to reach the customer as written. Chatwoot renders every outgoing
// message, private notes included, as a Liquid template: an unknown `{{variable}}` comes out empty and
// a known one (`{{contact.email}}`) comes out filled with the contact's data. Operator-written text
// (the signature, the templates in settings) keeps that rendering; this is only for the model's.
// Why this shape, and how it was checked against the fork's own renderer: docs/chatwoot.md.

// Each `{{` and `{%` becomes an output tag that prints it back (`{{ '{{' }}`). Chatwoot wraps every
// backtick pair in `{% raw %}`, which a code span can close from inside, so on a text that needs
// escaping every backtick is printed by a tag too (`url_decode` of `%60`), and so is a `{` right
// before one, which would otherwise run into that tag. Text without `{{` or `{%` goes out untouched.
export function literalForChatwoot(text: string): string {
  if (!text.includes("{{") && !text.includes("{%")) return text;
  return text.replace(/\{\{|\{%|\{(?=`)|`/g, (m) =>
    m === "`" ? "{{ '%60' | url_decode }}" : `{{ '${m}' }}`,
  );
}

// What the customer reads of a text `literalForChatwoot` escaped: its own tags printed back. For
// measuring a message (a typing delay), never for sending.
export function asRendered(wire: string): string {
  return wire.replace(
    /\{\{ '(\{\{|\{%|\{)' \}\}|\{\{ '%60' \| url_decode \}\}/g,
    (_m, c) => c ?? "`",
  );
}

// Operator text with untrusted values in it (the model's words, a contact's name), for Chatwoot to
// render: `markValue` fences each value as it goes in, and `composeForChatwoot` takes the fenced text
// and gives the wire. The operator's Liquid still renders and each value comes out as written.
const VALUE_OPEN = "";
const VALUE_CLOSE = "";
const FENCES = /[]/g;

export function markValue(value: string): string {
  return `${VALUE_OPEN}${value.replace(FENCES, "")}${VALUE_CLOSE}`;
}

// A `String.replace` over the operator's text only: a fenced value is opaque, so a placeholder a
// customer wrote into their own name is left as they wrote it, not filled.
export function replaceInOperatorText(
  fenced: string,
  pattern: RegExp,
  fill: (match: string, ...groups: string[]) => string,
): string {
  return fenced
    .split(/(\uE000[^\uE001]*\uE001)/)
    .map((part, i) =>
      i % 2 === 1 ? part : part.replace(pattern, fill as never),
    )
    .join("");
}

// Values are escaped whole, like `literalForChatwoot`. The operator's backticks are printed by tags
// too once any value is escaped, since a code span of theirs around a value would otherwise keep the
// value's tags from rendering; Chatwoot's pairing of those backticks is replayed here instead, and a
// `{{`/`{%` of theirs inside a span is printed literally, as Chatwoot's raw block would have kept it.
// Values with no `{`, `%` or backtick change nothing, so the text goes out as the operator wrote it.
export function composeForChatwoot(fenced: string): string {
  const chars: string[] = [];
  const fromValue: boolean[] = [];
  let inValue = false;
  for (const c of fenced) {
    if (c === VALUE_OPEN) inValue = true;
    else if (c === VALUE_CLOSE) inValue = false;
    else {
      chars.push(c);
      fromValue.push(inValue);
    }
  }
  if (
    !chars.some((c, i) => fromValue[i] && (c === "{" || c === "%" || c === "`"))
  )
    return chars.join("");
  // Chatwoot pairs backticks left to right (`/`(.*?)`/m`); the values' own are printed by tags, so
  // only the operator's pair.
  const inCode: boolean[] = new Array(chars.length).fill(false);
  // An operator's own `{% raw %}` block would print a value's tags as they are, so it is replayed the
  // same way: its two tags are dropped and what they held is printed literally.
  const dropped: boolean[] = new Array(chars.length).fill(false);
  const text = chars.join("");
  const charAt: number[] = [];
  let offset = 0;
  chars.forEach((c, i) => {
    charAt[offset] = i;
    offset += c.length;
  });
  // Liquid's whitespace control on those tags trims the operator's text around the block, so the
  // replay trims it too: `{%-` on the opening tag before the block, its `-%}` after it (the closing
  // tag's is swallowed with the block and trims nothing).
  const isSpace = (i: number) => !fromValue[i] && /\s/.test(chars[i] as string);
  let rawOpen: { from: number; to: number; trimAfter: boolean } | null = null;
  for (const m of text.matchAll(
    /\{%(-?)\s*raw\s*(-?)%\}|\{%\s*endraw\s*(-?)%\}/g,
  )) {
    const from = charAt[m.index] as number;
    const to = charAt[m.index + m[0].length] ?? chars.length;
    if (fromValue.slice(from, to).some(Boolean)) continue;
    const isEnd = m[3] !== undefined;
    if (!rawOpen && !isEnd) {
      rawOpen = { from, to, trimAfter: m[2] === "-" };
      for (let j = from - 1; m[1] === "-" && j >= 0 && isSpace(j); j--)
        dropped[j] = true;
    } else if (rawOpen && isEnd) {
      for (let j = rawOpen.from; j < to; j++) {
        dropped[j] = j < rawOpen.to || j >= from;
        inCode[j] = true;
      }
      const trimAfter = rawOpen.trimAfter;
      for (let j = to; trimAfter && j < chars.length && isSpace(j); j++)
        dropped[j] = true;
      rawOpen = null;
    }
  }
  let open = -1;
  chars.forEach((c, i) => {
    if (c !== "`" || fromValue[i] || inCode[i]) return;
    if (open < 0) open = i;
    else {
      for (let j = open + 1; j < i; j++) inCode[j] = true;
      open = -1;
    }
  });
  const keep = (_: unknown, i: number) => !dropped[i];
  const cs = chars.filter(keep);
  const val = fromValue.filter(keep);
  const code = inCode.filter(keep);
  const out: { tag: boolean; text: string }[] = [];
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i] as string;
    const next = cs[i + 1];
    const opens = c === "{" && (next === "{" || next === "%");
    if (c === "`") out.push({ tag: true, text: "{{ '%60' | url_decode }}" });
    else if (
      opens &&
      val[i] === val[i + 1] &&
      (val[i] || (code[i] && code[i + 1]))
    ) {
      out.push({ tag: true, text: `{{ '{${next}' }}` });
      i++;
    } else if (opens && (val[i] !== val[i + 1] || code[i] !== code[i + 1])) {
      // A delimiter split between a value and the operator's text belongs to neither: its `{` is
      // printed alone, so the operator's own `{{` right after it still opens their tag.
      out.push({ tag: true, text: "{{ '{' }}" });
    } else out.push({ tag: false, text: c });
  }
  // A literal `{` right before a tag would run into it (`{{{`): printed by a tag of its own.
  return out
    .map((p, i) =>
      !p.tag && p.text === "{" && out[i + 1]?.tag ? "{{ '{' }}" : p.text,
    )
    .join("");
}
