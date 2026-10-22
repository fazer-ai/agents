// What an HMAC_SHA256 instance signs when it is not the raw body (`config.signature`): a template
// over a CLOSED set of sources ({{body}}, {{header.x}}, {{query.x}}, {{sig.x}}, `|lower`, and `[[…]]`
// for a piece dropped when a value inside it is absent), so nothing here evaluates operator text.
// The writer (integrations/service.ts) and the gate (./auth.ts) both read the config through
// `parseSignatureConfig`, so a row the writer would refuse fails closed at the read. The grammar
// and a worked Mercado Pago example are in docs/integrations.md ("The signed message").

import { isUsableHeaderName } from "./header-name";

export type SignatureFormat = "hex" | "parts";

type Source = "body" | "header" | "query" | "sig";
type Piece =
  | { kind: "text"; text: string }
  | { kind: "value"; source: Source; name: string; lower: boolean };
type Group = { optional: boolean; pieces: Piece[] };

export interface SignatureConfig {
  format: SignatureFormat;
  signaturePart: string | null;
  timestampPart: string | null;
  maxAgeSeconds: number | null;
  groups: Group[];
}

export const SIGNATURE_MESSAGE_MAX_CHARS = 1000;
export const SIGNATURE_MAX_AGE_SECONDS_MAX = 7 * 24 * 3600;
// The id check walks every subset of optional groups; past this many it refuses instead.
const ID_FRAMING_GROUPS_MAX = 8;
const PART_KEY = /^[A-Za-z0-9_-]{1,32}$/;
const QUERY_NAME = /^[A-Za-z0-9._~\-[\]]{1,128}$/;
const VALUE = /^(body|header|query|sig)(?:\.([^|]+))?(?:\|(lower))?$/;

export type SignatureConfigProblem = { field: string; problem: string };

function parseMessage(
  message: string,
  format: SignatureFormat,
): Group[] | SignatureConfigProblem {
  const bad = (problem: string): SignatureConfigProblem => ({
    field: "message",
    problem,
  });
  const groups: Group[] = [];
  let current: Group = { optional: false, pieces: [] };
  let text = "";
  const flushText = () => {
    if (text) current.pieces.push({ kind: "text", text });
    text = "";
  };
  const closeGroup = () => {
    flushText();
    if (current.pieces.length) groups.push(current);
  };
  let i = 0;
  while (i < message.length) {
    if (message.startsWith("[[", i)) {
      if (current.optional) return bad("an optional [[group]] cannot nest");
      closeGroup();
      current = { optional: true, pieces: [] };
      i += 2;
    } else if (message.startsWith("]]", i)) {
      if (!current.optional) return bad("a ]] closes no [[group]]");
      closeGroup();
      current = { optional: false, pieces: [] };
      i += 2;
    } else if (message.startsWith("{{", i)) {
      const end = message.indexOf("}}", i + 2);
      if (end < 0) return bad("a {{placeholder}} is not closed");
      const inner = message.slice(i + 2, end).trim();
      const m = VALUE.exec(inner);
      if (!m) return bad(`{{${inner}}} is not a known placeholder`);
      const source = m[1] as Source;
      const name = m[2] ?? "";
      if (source === "body" ? name !== "" : name === "") {
        return bad(`{{${inner}}} is not a known placeholder`);
      }
      if (source === "header" && !isUsableHeaderName(name)) {
        return bad(`{{${inner}}} does not name a usable header`);
      }
      if (source === "query" && !QUERY_NAME.test(name)) {
        return bad(`{{${inner}}} does not name a usable query parameter`);
      }
      if (source === "sig") {
        if (format !== "parts") {
          return bad(
            `{{${inner}}} reads a signature part, which only the "parts" format has`,
          );
        }
        if (!PART_KEY.test(name)) {
          return bad(`{{${inner}}} does not name a usable signature part`);
        }
      }
      flushText();
      current.pieces.push({
        kind: "value",
        source,
        name,
        lower: m[3] === "lower",
      });
      i = end + 2;
    } else {
      text += message[i];
      i += 1;
    }
  }
  if (current.optional) return bad("an optional [[group]] is not closed");
  closeGroup();
  if (!groups.length) return bad("the message is empty");
  return groups;
}

// `undefined` is "this instance signs the body", the behavior every instance had before the key
// existed. Anything present is either fully usable or a problem naming the field.
export function parseSignatureConfig(
  raw: unknown,
): SignatureConfig | SignatureConfigProblem | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { field: "", problem: "must be an object" };
  }
  const s = raw as Record<string, unknown>;
  const format = s.format ?? "hex";
  if (format !== "hex" && format !== "parts") {
    return { field: "format", problem: 'must be "hex" or "parts"' };
  }
  const part = (key: "signaturePart" | "timestampPart") => {
    const v = s[key];
    if (v === undefined || v === null || v === "") return null;
    return typeof v === "string" && PART_KEY.test(v) ? v : false;
  };
  const signaturePart = part("signaturePart");
  const timestampPart = part("timestampPart");
  if (signaturePart === false) {
    return { field: "signaturePart", problem: "is not a usable part name" };
  }
  if (timestampPart === false) {
    return { field: "timestampPart", problem: "is not a usable part name" };
  }
  if (format === "parts" && signaturePart === null) {
    return {
      field: "signaturePart",
      problem: 'is required with the "parts" format',
    };
  }
  if (format === "hex" && timestampPart !== null) {
    return {
      field: "timestampPart",
      problem: 'only the "parts" format has a timestamp part',
    };
  }
  const message = s.message ?? "{{body}}";
  if (typeof message !== "string") {
    return { field: "message", problem: "must be a string" };
  }
  if (message.length > SIGNATURE_MESSAGE_MAX_CHARS) {
    return {
      field: "message",
      problem: `is over ${SIGNATURE_MESSAGE_MAX_CHARS} characters`,
    };
  }
  const groups = parseMessage(message, format);
  if (!Array.isArray(groups)) return groups;
  let maxAgeSeconds: number | null = null;
  if (s.maxAgeSeconds !== undefined && s.maxAgeSeconds !== null) {
    const v = s.maxAgeSeconds;
    if (
      typeof v !== "number" ||
      !Number.isInteger(v) ||
      v < 1 ||
      v > SIGNATURE_MAX_AGE_SECONDS_MAX
    ) {
      return {
        field: "maxAgeSeconds",
        problem: `must be a whole number between 1 and ${SIGNATURE_MAX_AGE_SECONDS_MAX}`,
      };
    }
    if (timestampPart === null) {
      return {
        field: "maxAgeSeconds",
        problem: "needs a timestamp part to measure the age from",
      };
    }
    if (!timestampAnchored(groups, timestampPart)) {
      return {
        field: "maxAgeSeconds",
        problem: `needs {{sig.${timestampPart}}} once in the message, outside any [[group]], as its first or last value and next to fixed text that is not a digit: a timestamp the signature does not pin down can be swapped`,
      };
    }
    maxAgeSeconds = v;
  }
  return { format, signaturePart, timestampPart, maxAgeSeconds, groups };
}

// Whether the signed message pins the timestamp down, so the signature that covers it cannot be
// reused with another one. Coverage alone is not enough: in `{{header.a}}{{sig.t}}{{header.b}}`
// the digits can move between the timestamp and its neighbours and still render the same message.
// The timestamp is all digits (the age check refuses anything else), so it is fixed when it sits
// at one end of the values, with only required fixed text between it and that end, and fixed text
// that is not a digit on its other side: the digit run then has exactly one place to start and end.
function timestampAnchored(groups: Group[], name: string): boolean {
  const flat = groups.flatMap((g) =>
    g.pieces.map((piece) => ({ piece, optional: g.optional })),
  );
  const at = flat.flatMap((f, i) =>
    f.piece.kind === "value" &&
    f.piece.source === "sig" &&
    f.piece.name === name
      ? [i]
      : [],
  );
  if (at.length !== 1) return false;
  const i = at[0] as number;
  if (flat[i]?.optional) return false;
  const fixedText = (f: (typeof flat)[number] | undefined) =>
    f !== undefined && !f.optional && f.piece.kind === "text";
  const nonDigitEdge = (
    f: (typeof flat)[number] | undefined,
    edge: "first" | "last",
  ) => {
    if (f === undefined) return true;
    if (!fixedText(f) || f.piece.kind !== "text") return false;
    return (edge === "first" ? /^\D/u : /\D$/u).test(f.piece.text);
  };
  const before = flat.filter((_, j) => j < i);
  const after = flat.filter((_, j) => j > i);
  const startAnchored =
    before.every(fixedText) && nonDigitEdge(flat[i + 1], "first");
  const endAnchored =
    after.every(fixedText) && nonDigitEdge(flat[i - 1], "last");
  return startAnchored || endAnchored;
}

// Whether a piece reads that value. Header names are case-insensitive (the gate reads them so), so
// `{{header.X-Payment-ID}}` and `header.x-payment-id` name one value; query parameters are not.
function isValue(
  p: Piece,
  source: Source,
  name: string,
): p is Extract<Piece, { kind: "value" }> {
  return (
    p.kind === "value" &&
    p.source === source &&
    (source === "header"
      ? p.name.toLowerCase() === name.toLowerCase()
      : p.name === name)
  );
}

// Whether every message this config renders carries that value: it sits in the required part, or
// alone in its [[group]] (which then drops only when the value itself is absent, and whoever reads
// the value refuses an absent one). `lossless` also refuses `|lower`, which signs a projection.
function covers(
  groups: Group[],
  source: Source,
  name: string,
  lossless: boolean,
): boolean {
  return groups.some((g) => {
    const values = g.pieces.filter((p) => p.kind === "value");
    return values.some(
      (p) =>
        isValue(p, source, name) &&
        !(lossless && p.lower) &&
        (!g.optional || values.length === 1),
    );
  });
}

// Whether a request this config authenticates also authenticates its BODY, byte for byte and with
// fixed boundaries. Coverage alone is not enough: with `{{header.a}}{{body}}`, or a [[group]] that
// can drop, a captured signature still verifies when part of the body moves into a header. So the
// body is the LAST piece, there is no [[group]], it is not `|lower`ed, and every other value is
// followed by literal text, which the gate refuses a value to contain (`signed_value_ambiguous`):
// each value then ends at a fixed point and so does the body.
export function signatureCoversBody(raw: unknown): boolean {
  const parsed = parseSignatureConfig(raw);
  if (parsed === undefined) return true;
  if (isSignatureConfigProblem(parsed)) return false;
  if (parsed.groups.length !== 1 || parsed.groups[0]?.optional) return false;
  const pieces = parsed.groups[0]?.pieces ?? [];
  const last = pieces.at(-1);
  if (last?.kind !== "value" || last.source !== "body" || last.lower) {
    return false;
  }
  return pieces.every(
    (p, i) =>
      i === pieces.length - 1 ||
      p.kind === "text" ||
      (p.source !== "body" && pieces[i + 1]?.kind === "text"),
  );
}

// Whether the signed message includes the query parameter or header a consult-back reads its id
// from. `|lower` is accepted here: the id only picks which resource the operator's own tool reads,
// and a case variant either names nothing or a resource whose answer the provider signs for.
export function signatureCoversId(
  raw: unknown,
  source: "header" | "query",
  name: string,
): boolean {
  const parsed = parseSignatureConfig(raw);
  if (parsed === undefined || isSignatureConfigProblem(parsed)) return false;
  if (!covers(parsed.groups, source, name, false)) return false;
  // No [[group]] before the id: framing each layout on its own is not enough, since two layouts can
  // render the same bytes with the id in different places (`[[{{header.x}};]]{{query.id}};[[{{header.y}};]]`
  // signs `ABC;DEF;` for id DEF after x ABC, and for id ABC before y DEF). With only required
  // pieces before it, the id starts at one fixed point of every message.
  const home = parsed.groups.findIndex((g) =>
    g.pieces.some((p) => isValue(p, source, name)),
  );
  if (parsed.groups.slice(0, home).some((g) => g.optional)) return false;
  // And that first occurrence is one every message carries: a group that holds another value can
  // drop while a later occurrence still renders, and the bytes it left then read as another id
  // (`[[pre{{query.id}};{{header.x}};]]{{query.id}};…` signs `preA;B;A;` for id A and for id preA).
  const anchor = parsed.groups[home];
  if (
    anchor?.optional &&
    anchor.pieces.filter((p) => p.kind === "value").length !== 1
  ) {
    return false;
  }
  // Fixed boundaries, as for the body: literal text (or the end of the message) after the id and
  // after every value before it, which the gate refuses a value to contain. Asked of every message
  // the template can render, since a dropped [[group]] takes its separators with it.
  const optional = parsed.groups.filter((g) => g.optional).length;
  if (optional > ID_FRAMING_GROUPS_MAX) return false;
  for (let mask = 0; mask < 2 ** optional; mask++) {
    let bit = 0;
    const pieces = parsed.groups.flatMap((g) =>
      !g.optional || mask & (1 << bit++) ? g.pieces : [],
    );
    const at = pieces.findIndex((p) => isValue(p, source, name));
    if (at < 0) continue;
    // The body before the id is refused outright: the gate never boundary-checks the body (its
    // bytes are the signed thing), so `{{body}}0{{query.id}}` signs `1`+`01` and `10`+`1` alike.
    const framed = pieces.every(
      (p, i) =>
        i > at ||
        p.kind === "text" ||
        (p.source !== "body" && pieces[i + 1]?.kind !== "value"),
    );
    if (!framed) return false;
  }
  return true;
}

// Whether the signature vouches for this value only lowercased (`|lower`): two spellings that differ
// in case then carry the same signature, so whatever counts them as distinct must not.
export function signedLowered(
  raw: unknown,
  source: "header" | "query",
  name: string,
): boolean {
  const parsed = parseSignatureConfig(raw);
  if (parsed === undefined || isSignatureConfigProblem(parsed)) return false;
  // The original case is authenticated only by an occurrence every message carries: in the required
  // part, or alone in its [[group]]. One that rides in a group with another value drops with it
  // (`{{query.id|lower}};[[{{query.id}}:{{header.extra}};]]` without `extra` signs `ABC` and `abc`
  // alike), and two spellings that can carry one signature must share a key.
  const signed = parsed.groups.flatMap((g) => {
    const values = g.pieces.filter((p) => p.kind === "value");
    return g.pieces
      .filter((p) => isValue(p, source, name))
      .map((p) => ({
        lower: p.kind === "value" && p.lower,
        always: !g.optional || values.length === 1,
      }));
  });
  return signed.length > 0 && !signed.some((o) => !o.lower && o.always);
}

export function isSignatureConfigProblem(
  v: SignatureConfig | SignatureConfigProblem,
): v is SignatureConfigProblem {
  return "problem" in v;
}

// `ts=1704908010,v1=abc` → { ts: ["1704908010"], v1: ["abc"] }. A key may repeat (Stripe sends one
// `v1` per active secret during a rotation), so every value is kept.
export function parseSignatureParts(header: string): Map<string, string[]> {
  const parts = new Map<string, string[]>();
  for (const item of header.split(",")) {
    const eq = item.indexOf("=");
    if (eq <= 0) continue;
    const key = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim();
    if (!key || !value) continue;
    parts.set(key, [...(parts.get(key) ?? []), value]);
  }
  return parts;
}

export interface SignedMessageSources {
  rawBody: string;
  getHeader: (name: string) => string | null;
  getQuery: (name: string) => string | null;
  parts: Map<string, string[]>;
}

// A value that contains the text right after it lets the sender move the boundary between the two
// (`1.2` + `.` + body reads the same as `1` + `.` + `2.body`), so the gate refuses it instead of
// guessing. `(v + text).indexOf(text) < v.length` also catches an overlap (`xa` before `aa`).
function blursBoundary(value: string, next: Piece | undefined): boolean {
  return (
    next?.kind === "text" &&
    (value + next.text).indexOf(next.text) < value.length
  );
}

// The message the sender signed; `missing` when a value outside every optional group is absent,
// `ambiguous` when a value runs into the text after it.
export function renderSignedMessage(
  groups: Group[],
  src: SignedMessageSources,
): string | "missing" | "ambiguous" {
  const read = (p: Extract<Piece, { kind: "value" }>): string | null => {
    const v =
      p.source === "body"
        ? src.rawBody
        : p.source === "header"
          ? src.getHeader(p.name)
          : p.source === "query"
            ? src.getQuery(p.name)
            : (src.parts.get(p.name)?.[0] ?? null);
    if (v === null) return null;
    return p.lower ? v.toLowerCase() : v;
  };
  // The groups that render, first: a value's boundary is the text after it in the MESSAGE, which
  // can sit in the next group once a group between them drops.
  const shown: { piece: Piece; value: string }[] = [];
  for (const g of groups) {
    const values = g.pieces.map((p) => (p.kind === "text" ? p.text : read(p)));
    if (values.some((v) => v === null)) {
      if (g.optional) continue;
      return "missing";
    }
    for (const [i, piece] of g.pieces.entries()) {
      shown.push({ piece, value: values[i] as string });
    }
  }
  for (const [i, { piece, value }] of shown.entries()) {
    if (
      piece.kind === "value" &&
      piece.source !== "body" &&
      blursBoundary(value, shown[i + 1]?.piece)
    ) {
      return "ambiguous";
    }
  }
  return shown.map((x) => x.value).join("");
}

// A provider timestamp in seconds or milliseconds (Mercado Pago's own examples use both), as epoch
// milliseconds; null when it is not a plain integer.
export function timestampMs(value: string): number | null {
  if (!/^\d{1,16}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1e12 ? n : n * 1000;
}
