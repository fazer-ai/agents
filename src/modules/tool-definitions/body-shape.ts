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

// The AUTHORING rule for `rows`, deliberately stricter than what the runtime tolerates: `parseBody`
// coerces a non-string value to "", ignores any extra key, drops a row whose key trims to nothing,
// and lets a later row overwrite an earlier one on the same trimmed key. Every one of those loses
// something the author wrote. What the runtime DOES with such rows instead lives in `canonicalRow`.
// Returns the reason, so the message can name the row rather than the rule.
function rowsProblem(rows: unknown): string | null {
  if (!Array.isArray(rows)) {
    return 'body mode "kv" needs `rows` to be a list of {"key":"…","value":"…"}, both non-empty strings — a row whose key is blank is dropped, and its value with it.';
  }
  const bad = rows.some(
    (r) =>
      !isPlainObject(r) ||
      typeof r.key !== "string" ||
      r.key.trim() === "" ||
      typeof r.value !== "string" ||
      extraKeys(r, ["key", "value"]).length > 0,
  );
  if (bad) {
    return 'body mode "kv" needs `rows` to be a list of {"key":"…","value":"…"}, both non-empty strings — a row whose key is blank is dropped, and its value with it.';
  }
  return null;
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
    const rowsBad = body.rows !== undefined ? rowsProblem(body.rows) : null;
    if (rowsBad) return rowsBad;
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
// import uses it instead of blanking the row, so a legacy tool keeps sending what it was sending.
//
// It is written as a MIRROR of parseBody's branches, not as a variation on the refusal above, and
// that distinction is the whole reason this exists as its own function. The two answer different
// questions — "may an author write this?" and "what does the runtime do with it?" — and they differ
// at exactly the places a shape is *tolerated* rather than *read*: an extra key beside `raw`, an
// extra key inside a row, a value of the wrong type. Deriving one from the other silently changes
// the request every time they diverge, which is the thing this whole change exists to stop.
//
// Every rule below has a line of parseBody behind it:
//   raw     -> `typeof b.raw === "string" ? b.raw : ""`
//   kv rows -> key/value coerced to "" when not strings, then `.filter(r => r.key.trim())`
//   else    -> the legacy `fields` branch
function canonicalRow(r: unknown): { key: string; value: string } | null {
  const row = isPlainObject(r) ? r : {};
  const key = typeof row.key === "string" ? row.key : "";
  // NOTE: parseBody filters on the TRIMMED key, and the kv consumer trims again before writing it,
  // so a row that trims to nothing never reaches the payload.
  if (key.trim() === "") return null;
  return { key, value: typeof row.value === "string" ? row.value : "" };
}

export function canonicalBodyShape(body: unknown): Record<string, unknown> {
  if (!isPlainObject(body)) return {};
  if (body.mode === "raw") {
    return { mode: "raw", raw: typeof body.raw === "string" ? body.raw : "" };
  }
  if (body.mode === "kv") {
    // NOTE: rows are kept in order and NOT deduplicated by key. Two rows on the same trimmed key are
    // a deliberate fallback idiom — a row whose value is a lone {{aiField}} is SKIPPED when the model
    // omitted that field, so an earlier constant survives as the default — and which of them wins is
    // decided per call by the model's own arguments. Nothing static can mirror that, so nothing here
    // tries: keeping both rows is what makes this byte-identical.
    const rows = Array.isArray(body.rows)
      ? body.rows.map(canonicalRow).filter((r) => r !== null)
      : [];
    return { mode: "kv", rows };
  }
  if (body.mode === "fields") return { mode: "fields" };
  return {};
}
