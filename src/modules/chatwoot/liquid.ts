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
  let open = -1;
  chars.forEach((c, i) => {
    if (c !== "`" || fromValue[i]) return;
    if (open < 0) open = i;
    else {
      for (let j = open + 1; j < i; j++) inCode[j] = true;
      open = -1;
    }
  });
  const out: { tag: boolean; text: string }[] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as string;
    const next = chars[i + 1];
    const opens = c === "{" && (next === "{" || next === "%");
    if (c === "`") out.push({ tag: true, text: "{{ '%60' | url_decode }}" });
    else if (
      opens &&
      fromValue[i] === fromValue[i + 1] &&
      (fromValue[i] || inCode[i])
    ) {
      out.push({ tag: true, text: `{{ '{${next}' }}` });
      i++;
    } else if (opens && fromValue[i] !== fromValue[i + 1]) {
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
