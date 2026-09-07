// WHAT WE MAY KEEP OF A SAMPLE RESPONSE, so the tool editor's pickers survive a reopen without the
// customer's data surviving with them (issue #566).
//
// The sample an operator pastes is a real response from a real API. It routinely carries names,
// e-mail addresses, phone numbers, CPF, prices and internal ids, and sometimes a token echoed back
// in the body. Storing it would put a third party's personal data in a column nobody thinks of as
// data storage, and from there into every backup.
//
// THE SPLIT THIS MODULE EXISTS FOR. The screen has two consumers of the sample and they need
// different things: the pickers and the caret completion need PATHS, and only the preview needs
// VALUES. So the paths are what gets stored — the keys, with every value replaced by a stand-in —
// and the response itself never leaves the browser that received it. "We never store it" is a
// stronger invariant than "we store it when a toggle is on": there is no backup question, no bundle
// question, and no export rule to keep in step.
//
// AND THE SERVER REDACTS AGAIN ON WRITE. The client redacts so the response does not travel over the
// wire; the server redacts so the invariant is a property of the STORAGE and not of whichever client
// happened to send the row. The two are not redundant, they answer different questions.
//
// WHY A STRING KEEPS ITS LENGTH. Not decoration. The per-value clip and the model's overall limit
// are exactly what `response-template.ts` exists to prevent (#456: a truncated payload does not read
// to a model as missing data, it reads as a gap to fill from training data). A preview over a fixed
// `"string"` would show a template fitting comfortably where the real values overflow and drop the
// fields after them — the operator would be checking a promise the runtime does not keep. Length is
// the one property that makes the preview exact about SIZE while storing none of the content.

import { MAX_VALUE_CHARS } from "@/modules/tool-definitions/response-template";

// The stand-in for one character. ASCII on purpose: the renderer's own cut is `clipText`, which
// spends a unit dropping an orphan surrogate half, and a stand-in that could contain one would make
// the preview shorter than the response it stands for — the single thing this redaction promises to
// get right. Also the shape that reads as "redacted" to anyone who opens the row.
const STAND_IN_CHAR = "x";

// A stand-in never needs to be longer than the point where the renderer stops caring. Past
// `MAX_VALUE_CHARS` the renderer clips and appends its marker whatever the true length was, so a
// value 50k long and one 2002 long render identically — and storing the difference would make the
// shape as large as the response it replaces, for nothing.
const MAX_STAND_IN_CHARS = MAX_VALUE_CHARS + 1;

// Past this the shape is not stored at all, rather than stored truncated. Truncating would drop
// keys, and a picker that silently stops offering half a response is worse than one that offers
// nothing: the operator reads the gap as "that field is not in the response" and fixes a template
// that was right. The number is generous next to any response a person pastes to design against.
export const SAMPLE_SHAPE_MAX_CHARS = 64_000;

export interface StoredSampleShape {
  // The status the sample came back under, or null when it was pasted by hand. It travels WITH the
  // shape because the preview branches on it: a sample captured from a 404 the tool declares a
  // "no result" status is projected differently, and a shape stored without it would reopen reading
  // that 404 as a 200.
  status: number | null;
  body: unknown;
}

// Structure kept, every value replaced. `null` is not data, so it stays: it is the difference
// between "the API returned nothing here" and "the API did not return this key", and the template
// renders the two the same way for the model but the PICKER must not offer a path that does not
// exist.
export function redactSample(node: unknown): unknown {
  if (typeof node === "string") {
    return STAND_IN_CHAR.repeat(Math.min(node.length, MAX_STAND_IN_CHARS));
  }
  if (typeof node === "number") return 0;
  if (typeof node === "boolean") return true;
  if (node === null) return null;
  if (Array.isArray(node)) return node.map(redactSample);
  if (typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = redactSample(v);
    return out;
  }
  // A body came out of JSON.parse, so nothing else can reach here; a value that somehow did is not
  // something a path may end on either way.
  return null;
}

// The row to store, or null when there is nothing storable. Serialized once, here, because the size
// question is about what lands in the column and not about the tree in memory.
export function storableShape(
  body: unknown,
  status: number | null,
): StoredSampleShape | null {
  const redacted = redactSample(body);
  if (JSON.stringify(redacted).length > SAMPLE_SHAPE_MAX_CHARS) return null;
  return { status, body: redacted };
}

// The wire value, read the way the runtime readers in this folder are read: whatever arrived is
// judged here and comes back either storable or null, never trusted as sent. This is the half that
// makes "no response is stored" a property of the COLUMN — the client redacts so the response does
// not travel, and this redacts again so a client that skipped that step still cannot write one.
export function readStorableShape(raw: unknown): StoredSampleShape | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return null;
  const o = raw as Record<string, unknown>;
  if (!("body" in o)) return null;
  const status = o.status;
  return storableShape(
    o.body,
    typeof status === "number" && Number.isInteger(status) ? status : null,
  );
}
