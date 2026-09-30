import { z } from "zod";
import { CONTEXT_VAR_NAMES } from "@/modules/tool-definitions/normalize";
import { resolveSecretInjection } from "@/modules/vault/secret-types";

// The request headers an MCP connection declares, name -> value template. A value is literal text
// with any number of `{{placeholders}}` naming the conversation variables an HTTP tool header reads
// (CONTEXT_VAR_NAMES), resolved per tools/call from the turn, never from the model.

export const MCP_HEADERS_DESCRIPTION = [
  "Request headers sent on every tool call to this server, as name -> value. A value may use the conversation variables an HTTP tool header accepts: {{contact_id}}, {{contact_phone}}, {{contact_identifier}}, {{conversation_id}}, {{inbox_id}} and the rest.",
  "Each variable is filled from the conversation when the tool is called, never by the model; one the conversation has no value for is sent empty.",
  "Tool discovery (tools/list) carries none of these headers, since it runs outside any conversation. Network transports only, and the credential's own header always wins.",
].join("\n\n");

export const MAX_MCP_HEADERS = 20;
const MAX_VALUE_CHARS = 2000;
const MAX_NAME_CHARS = 128;

// RFC 9110 field-name: a token.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

// Set by the MCP transport itself on every request; a declared one would be overwritten or break
// the session.
const TRANSPORT_HEADERS = new Set([
  "accept",
  "content-type",
  "content-length",
  "host",
  "last-event-id",
  "mcp-session-id",
  "mcp-protocol-version",
]);

const CONTEXT_NAMES = new Set<string>(CONTEXT_VAR_NAMES);

export type McpHeaders = Record<string, string>;

// The map as the caller sent it, key for key. `z.record` rebuilds the object, and `__proto__` hits
// the prototype setter on the way and vanishes; kept here, mcpHeadersProblem refuses it by name.
export const mcpHeadersInput = z.custom<Record<string, unknown>>(
  (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  { message: "expected an object of header name -> value" },
);

// The header the connection's credential is sent in, lowercased, or null when it goes in the query
// or there is none. Mirrors buildConnConfig: a credential whose kind names no injection is a Bearer.
export function credentialHeaderName(
  hasCredential: boolean,
  kind: string | null | undefined,
  paramName: string | null | undefined,
): string | null {
  if (!hasCredential) return null;
  const inj = resolveSecretInjection(kind, "x", paramName);
  if (inj?.target === "query") return null;
  return (inj?.name ?? "Authorization").toLowerCase();
}

// Why `headers` cannot be stored as given, or null. `transport` and `credentialHeader` are the
// connection's state after the write, so a header that is fine now and collides after a credential
// change is caught by the write that makes the change.
export function mcpHeadersProblem(
  headers: Record<string, unknown>,
  transport: string,
  credentialHeader: string | null,
): string | null {
  const entries = Object.entries(headers);
  if (entries.length === 0) return null;
  if (transport === "stdio")
    return "headers apply to network transports only; a stdio server is a local process";
  if (entries.length > MAX_MCP_HEADERS)
    return `at most ${MAX_MCP_HEADERS} headers`;
  const seen = new Set<string>();
  for (const [name, value] of entries) {
    if (
      name.length > MAX_NAME_CHARS ||
      !HEADER_NAME.test(name) ||
      name === "__proto__"
    )
      return `"${name}" is not a valid header name`;
    if (typeof value !== "string") return `header "${name}" must be text`;
    const lower = name.toLowerCase();
    if (seen.has(lower)) return `header "${name}" is declared twice`;
    seen.add(lower);
    if (TRANSPORT_HEADERS.has(lower))
      return `header "${name}" is set by the MCP transport`;
    if (lower === credentialHeader)
      return `header "${name}" carries the connection's credential`;
    if (value.length > MAX_VALUE_CHARS)
      return `header "${name}" is longer than ${MAX_VALUE_CHARS} characters`;
    if (/[\r\n\0]/.test(value)) return `header "${name}" contains a line break`;
    const unknown = [...value.matchAll(PLACEHOLDER)]
      .map((m) => m[1] as string)
      .filter((n) => !CONTEXT_NAMES.has(n));
    if (unknown.length > 0)
      return `header "${name}" uses {{${unknown[0]}}}, which is not a conversation variable (${CONTEXT_VAR_NAMES.join(", ")})`;
  }
  return null;
}

// The stored value as a header map. A row written before the column existed, or by a path that
// skipped validation, reads as the entries that are strings.
export function readMcpHeaders(raw: unknown): McpHeaders {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: McpHeaders = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function withoutControlChars(v: string): string {
  let out = "";
  for (const ch of v) {
    const c = ch.charCodeAt(0);
    out += c < 0x20 || c === 0x7f ? " " : ch;
  }
  return out;
}

// The headers for one call: each placeholder replaced by its value in `context`, or by "" when the
// conversation has none, the way an HTTP tool header renders. A substituted value comes from the
// customer's side (a contact name), so its control characters become spaces: a line break would
// otherwise make the whole request throw.
export function renderMcpHeaders(
  headers: McpHeaders,
  context: Record<string, string>,
): McpHeaders {
  const out: McpHeaders = {};
  for (const [name, template] of Object.entries(headers)) {
    out[name] = template.replace(PLACEHOLDER, (_, n: string) =>
      withoutControlChars(Object.hasOwn(context, n) ? (context[n] ?? "") : ""),
    );
  }
  return out;
}
