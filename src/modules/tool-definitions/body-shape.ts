// The request body of an HTTP tool, and the one place that says which shapes exist.
//
// `parseBody` (src/graph/tools/http.ts) executes three: "kv" assembles JSON from explicit rows,
// "raw" sends an interpolated template, and absent/"fields" assembles JSON from the declared input
// fields. It reads a fixed set of keys and ignores every other, which is why an unsupported shape
// was never noticed: the request still went out, assembled from the field names, looking plausible
// and carrying nothing the operator had written (issue #150).
//
// The rule is therefore not "declare a known mode" but the stricter one: the body must be exactly an
// executable shape, with NO key the runtime does not read. Both halves are load-bearing, and the
// second is what catches a half-conversion. A body authored as a plain JSON object
// (`{"contact":{"email":"{{email}}"}}`) reads like a template and is not one; the same object with
// `mode: "raw"` bolted on is worse, because it declares a mode a mode-only check would accept while
// `parseBody` sends an empty body and drops every key the author actually wrote. A key the runtime
// does not read is a payload somebody believes they are sending.

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extraKeys(obj: Record<string, unknown>, known: string[]): string[] {
  return Object.keys(obj).filter((k) => !known.includes(k));
}

function rowIsMalformed(r: unknown): boolean {
  return (
    !isPlainObject(r) ||
    typeof r.key !== "string" ||
    // NOTE: `parseBody` drops a row whose key trims to nothing, so a blank key loses the value
    // exactly as silently as a key the runtime never reads.
    r.key.trim() === "" ||
    typeof r.value !== "string" ||
    extraKeys(r, ["key", "value"]).length > 0
  );
}

function rowsAreMalformed(rows: unknown): boolean {
  if (!Array.isArray(rows)) return true;
  return rows.some(rowIsMalformed);
}

const SHAPES =
  '{"mode":"kv","rows":[{"key":"…","value":"…"}]}, {"mode":"raw","raw":"…"}, or {} to keep the legacy assembly from the declared input fields';

const NESTED_HINT =
  'For a nested payload, use mode "raw" and write the JSON yourself — e.g. {"mode":"raw","raw":"{\\"contact\\":{\\"email\\":\\"{{contact_email}}\\"}}"} — where placeholders interpolate at any depth.';

function dropped(mode: string, reads: string, extra: string[]): string {
  return `body mode "${mode}" ${reads}, so ${extra.join(", ")} would be dropped without a trace. ${NESTED_HINT}`;
}

// Returns null when the body is one the runtime executes, otherwise the reason, written for whoever
// authored it. Absent and `{}` are legitimate, and they do NOT mean "no body": both select the legacy
// `fields` branch, which assembles the payload from the declared input fields.
export function unsupportedBodyShape(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  if (!isPlainObject(body)) return `body must be an object: ${SHAPES}.`;
  const keys = Object.keys(body);
  if (keys.length === 0) return null;

  if (body.mode === "raw") {
    if (body.raw !== undefined && typeof body.raw !== "string") {
      return 'body mode "raw" needs `raw` to be a string: the template is sent as written.';
    }
    const extra = extraKeys(body, ["mode", "raw"]);
    return extra.length > 0
      ? dropped("raw", "sends the `raw` template and nothing else", extra)
      : null;
  }

  if (body.mode === "kv") {
    if (body.rows !== undefined && rowsAreMalformed(body.rows)) {
      return 'body mode "kv" needs `rows` to be a list of {"key":"…","value":"…"}, both non-empty strings — a row whose key is blank is dropped, and its value with it.';
    }
    const extra = extraKeys(body, ["mode", "rows"]);
    return extra.length > 0
      ? dropped(
          "kv",
          "assembles the payload from `rows` and nothing else",
          extra,
        )
      : null;
  }

  if (body.mode === "fields") {
    const extra = extraKeys(body, ["mode"]);
    return extra.length > 0
      ? dropped(
          "fields",
          "assembles the payload from the declared input fields and nothing else",
          extra,
        )
      : null;
  }

  const seen =
    body.mode !== undefined
      ? `mode ${JSON.stringify(body.mode)}`
      : `an object with no mode (keys: ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""})`;
  return (
    `body must declare a mode the runtime executes — got ${seen}. Use ${SHAPES}. ` +
    "A body written as a plain JSON object is not a template: it is discarded, and the request goes " +
    "out assembled from the declared input fields instead — which is also what {} does, so {} is not " +
    `a way to send nothing. ${NESTED_HINT}`
  );
}

// What `parseBody` actually executes for a body this file refuses, spelled canonically. The bundle
// import uses it instead of blanking the row: `{}` is behavior-preserving only for a body with no
// recognized mode (both select the legacy `fields` branch), and a `{mode:"raw", raw:"…", extra:…}`
// WAS sending its template — replacing that with `{}` would switch the tool to the fields assembly,
// changing the outbound request of a tool that was merely stored untidily.
export function canonicalBodyShape(body: unknown): Record<string, unknown> {
  if (!isPlainObject(body)) return {};
  if (body.mode === "raw") {
    return { mode: "raw", raw: typeof body.raw === "string" ? body.raw : "" };
  }
  if (body.mode === "kv") {
    const rows = Array.isArray(body.rows)
      ? body.rows.filter((r) => !rowIsMalformed(r))
      : [];
    return { mode: "kv", rows };
  }
  if (body.mode === "fields") return { mode: "fields" };
  return {};
}
