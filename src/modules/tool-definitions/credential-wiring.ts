// Whether an HTTP tool's request will actually carry the credential attached to it. Issue #504: a
// tool can reference a `generic` credential while nothing in its templates interpolates `{{secret}}`.
// Nothing refuses that, and nothing should — a tool may legitimately hold a reference it does not
// wire yet — but the failure it produces is unreadable: the request goes out UNAUTHENTICATED and the
// upstream answers 401/403, which reads as a bad credential rather than as a credential that was
// never sent. A `generic` credential is the one kind with no auto-injection (the catalog says so),
// so it is also the only one where "attached" and "sent" can come apart silently.

import {
  INJECTING_MECHANISM_KIND_IDS,
  isNonInjectableSecret,
  secretTypeAutoInjects,
} from "@/modules/vault/secret-types";
import type { ToolShapePatch } from "./normalize";

// The SAME grammar the runtime interpolates with (`PLACEHOLDER` in graph/tools/http.ts): the braces
// take surrounding whitespace, so a scanner matching only the tight spelling would call a working
// `{{ secret }}` unused and warn about a tool that is wired correctly.
const SECRET_PLACEHOLDER = /\{\{\s*secret\s*\}\}/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Every string the runtime interpolates `{{secret}}` into, and nothing else. Five sites, and they are
// the same five `normalizeToolShapes` rewrites: the URL, header values, query values, the body (raw
// text, or the kv rows' values) and a FIXED input field's value.
//
// `source === "fixed"` is not a detail. `buildHttpTool` reads `s.source === "fixed" ? "fixed" : "ai"`
// and precomputes only the fixed values with the secret in scope; a `{{secret}}` written into an AI
// field's `value` is never interpolated, so counting it as usage would silence the warning for a
// tool whose credential genuinely never leaves.
export function toolSecretTemplates(shapes: ToolShapePatch): string[] {
  const out: string[] = [];
  if (typeof shapes.urlTemplate === "string") out.push(shapes.urlTemplate);
  for (const key of ["headers", "query"] as const) {
    const value = shapes[key];
    if (!isPlainObject(value)) continue;
    for (const v of Object.values(value)) {
      if (typeof v === "string") out.push(v);
    }
  }
  const body = shapes.body;
  if (isPlainObject(body)) {
    if (body.mode === "raw" && typeof body.raw === "string") out.push(body.raw);
    if (body.mode === "kv" && Array.isArray(body.rows)) {
      for (const row of body.rows) {
        if (isPlainObject(row) && typeof row.value === "string") {
          out.push(row.value);
        }
      }
    }
  }
  const schema = shapes.inputSchema;
  if (isPlainObject(schema)) {
    for (const spec of Object.values(schema)) {
      if (isPlainObject(spec) && spec.source === "fixed") {
        if (typeof spec.value === "string") out.push(spec.value);
      }
    }
  }
  return out;
}

export function toolUsesSecretPlaceholder(shapes: ToolShapePatch): boolean {
  return toolSecretTemplates(shapes).some((t) => SECRET_PLACEHOLDER.test(t));
}

// The warning, or null when the wiring is fine. `kind` is the ATTACHED credential's kind, read off
// the vault entry; null (or a kind this build does not know) is the legacy `generic` and answers the
// same way, because that is how every other reader treats it.
//
// Scoped to kinds that CAN be sent: a `neverOutbound` credential on an HTTP tool is a worse problem
// with a different answer (it must not be sent at all, and the write boundary does not yet refuse
// it), and telling its operator to "write {{secret}} where the API expects it" would be advice to
// mail their stdio token to a third party.
export function unusedCredentialWarning(
  kind: string | null | undefined,
  shapes: ToolShapePatch,
): string | null {
  if (secretTypeAutoInjects(kind) || isNonInjectableSecret(kind)) return null;
  if (toolUsesSecretPlaceholder(shapes)) return null;
  return `the attached credential is never sent: a "${kind ?? "generic"}" credential is not auto-injected, and {{secret}} appears in none of url_template, headers, query, body or a fixed field value — this request goes out unauthenticated, and the upstream's 401/403 will look like a bad credential rather than one that was never wired. Write {{secret}} where the API expects it, or attach a credential whose type injects it (${INJECTING_MECHANISM_KIND_IDS.join(", ")}).`;
}
