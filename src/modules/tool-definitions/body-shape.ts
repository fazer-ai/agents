// The request body of an HTTP tool, and the one place that says which shapes exist.
//
// `parseBody` (src/graph/tools/http.ts) executes three: "kv" assembles JSON from explicit rows,
// "raw" sends an interpolated template, and absent/"fields" assembles JSON from the declared input
// fields. Anything else falls through to that last branch, which is why an unsupported shape was
// never noticed: the request still went out, assembled from the field names, looking plausible and
// carrying nothing the operator had written (issue #150).
//
// The reported case is a body authored as a plain JSON object — `{"contact":{"email":"{{email}}"}}`
// — which reads like a template and is not one. It was accepted by the write, stored, echoed back
// by the dry-run preview and then discarded at invocation, so the only visible symptom was the
// upstream API complaining about a field the operator could see in their own tool definition.
// Checking the shape where it is authored is what turns that into an answer the author can act on.

const KNOWN_MODES = ["kv", "raw", "fields"] as const;

function describe(body: Record<string, unknown>): string {
  const mode = body.mode;
  if (mode !== undefined) return `mode ${JSON.stringify(mode)}`;
  const keys = Object.keys(body);
  const shown = keys.slice(0, 4).join(", ");
  return `an object with no mode (keys: ${shown}${keys.length > 4 ? ", …" : ""})`;
}

// Returns null when the body is one the runtime executes, otherwise the reason, written for whoever
// authored it. Absent and `{}` are legitimate: both mean "no body configuration".
export function unsupportedBodyShape(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body !== "object" || Array.isArray(body)) {
    return 'body must be an object: {"mode":"kv","rows":[…]}, {"mode":"raw","raw":"…"}, or {} for none.';
  }
  const obj = body as Record<string, unknown>;
  if (Object.keys(obj).length === 0) return null;
  if (typeof obj.mode === "string" && KNOWN_MODES.includes(obj.mode as never)) {
    return null;
  }
  return (
    `body must declare a mode the runtime executes — got ${describe(obj)}. ` +
    'Use {"mode":"kv","rows":[{"key":"…","value":"…"}]} for a flat payload, or {"mode":"raw","raw":"…"} ' +
    "for anything else. A body written as a plain JSON object is not a template: it is discarded, and " +
    "the request goes out assembled from the declared input fields instead. For a nested payload, " +
    'write it with mode "raw" — e.g. {"mode":"raw","raw":"{\\"contact\\":{\\"email\\":\\"{{contact_email}}\\"}}"} ' +
    "— where placeholders interpolate at any depth."
  );
}
