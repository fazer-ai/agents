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
    if (!covers(groups, "sig", timestampPart)) {
      return {
        field: "maxAgeSeconds",
        problem: `needs {{sig.${timestampPart}}} in the message: a timestamp the signature does not cover can be replaced`,
      };
    }
    maxAgeSeconds = v;
  }
  return { format, signaturePart, timestampPart, maxAgeSeconds, groups };
}

function covers(groups: Group[], source: Source, name = ""): boolean {
  return groups.some((g) =>
    g.pieces.some(
      (p) => p.kind === "value" && p.source === source && p.name === name,
    ),
  );
}

// Whether a request this config authenticates also authenticates its BODY. A manifest that signs
// only an id leaves the body free to be replaced under a captured signature, so whatever acts on the
// body must not act on it.
export function signatureCoversBody(raw: unknown): boolean {
  const parsed = parseSignatureConfig(raw);
  if (parsed === undefined) return true;
  if (isSignatureConfigProblem(parsed)) return false;
  return covers(parsed.groups, "body");
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

// The message the sender signed, or null when a value outside every optional group is absent.
export function renderSignedMessage(
  groups: Group[],
  src: SignedMessageSources,
): string | null {
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
  let out = "";
  for (const g of groups) {
    let rendered = "";
    let absent = false;
    for (const p of g.pieces) {
      if (p.kind === "text") {
        rendered += p.text;
        continue;
      }
      const v = read(p);
      if (v === null) {
        absent = true;
        break;
      }
      rendered += v;
    }
    if (absent) {
      if (g.optional) continue;
      return null;
    }
    out += rendered;
  }
  return out;
}

// A provider timestamp in seconds or milliseconds (Mercado Pago's own examples use both), as epoch
// milliseconds; null when it is not a plain integer.
export function timestampMs(value: string): number | null {
  if (!/^\d{1,16}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1e12 ? n : n * 1000;
}
