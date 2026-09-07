// THE SAMPLE RESPONSE, KEPT WHERE IT ALREADY WAS (issue #566).
//
// The Sample response field in the HTTP tool editor used to be cleared on every open, so an operator
// coming back to adjust a response template, the most common reason to reopen an HTTP tool, found
// pickers that offered nothing, no preview at all, and no "Insert a field" button. The two ways out
// were pasting a response again by hand or spending a real call against the customer's API to
// recover what had been on screen once.
//
// So it is kept, in the browser that received it, keyed by tool id.
//
// WHY NOTHING IS STORED SERVER-SIDE, WHICH IS THE WHOLE DESIGN. The first draft of this feature put
// a redacted SHAPE of the response in a column (the keys, with every value replaced by a stand-in)
// so the pickers would work on any machine. Two rounds of review took that apart on the same
// question, and the second one settled it: no lexical rule establishes that a key is a field name
// rather than customer data. `{"users": {"ana@example.com": …}}` is a map keyed by an e-mail;
// `{"users": {"Ana": …}}` is a map keyed by a first name that any identifier pattern accepts. Since
// the keys cannot be separated from the data, and a path THROUGH a map is worthless to an operator
// anyway (it resolves for exactly one customer), there was nothing left worth storing.
//
// What that costs is written down rather than papered over: an operator on a second machine, or one
// whose site data was cleared, gets what they get today: no offer, and "Send a test request" as the
// way back. What it buys is that "we never store the customer's response" needs no qualification: no
// per-tool opt-in, no backup question, no export rule, and no column whose redaction a future reader
// has to re-derive before trusting it.
//
// EVERY ACCESS IS GUARDED. `localStorage` throws outright in some contexts (a private window with
// site data blocked, a browser configured to refuse storage) and it can be full. A sample that
// cannot be kept is not an error the operator can act on. It costs them the values on the next
// open, which is exactly the behaviour this replaces, so nothing here reports a failure.

const PREFIX = "@app:toolSample:";

// Well under the ~5MB a browser gives an origin, and past anything a person pastes to design a
// template against. A response bigger than this is one the operator will re-fetch anyway.
const MAX_STORED_CHARS = 512_000;

export interface LocalSample {
  text: string;
  // The status it came back under, or null when it was pasted by hand. Kept with the text because
  // the preview branches on it: a body captured from a 404 the tool declares a "no result" status
  // is projected differently, and restoring the text without it would read that 404 as a 200.
  status: number | null;
}

function keyFor(toolId: string): string {
  return `${PREFIX}${toolId}`;
}

export function readLocalSample(toolId: string): LocalSample | null {
  try {
    const raw = localStorage.getItem(keyFor(toolId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o.text !== "string") return null;
    return {
      text: o.text,
      status: typeof o.status === "number" ? o.status : null,
    };
  } catch {
    return null;
  }
}

// Called when the tool is SAVED rather than on every keystroke: what is kept is the sample the tool
// was last saved with, not a draft the operator abandoned.
export function writeLocalSample(
  toolId: string,
  sample: LocalSample | null,
): void {
  // REMOVED FIRST, unconditionally, and the ordering is the point: `setItem` can throw on a full
  // origin quota, and leaving the previous entry there means the next open restores ANOTHER
  // response's values as though this save had persisted (round 2 of review). Degrading to no sample
  // is the honest failure; degrading to a stale one is not.
  try {
    localStorage.removeItem(keyFor(toolId));
  } catch {
    // See the module header: nothing to report and nothing to do.
    return;
  }
  if (sample === null || sample.text.trim() === "") return;
  if (sample.text.length > MAX_STORED_CHARS) return;
  try {
    localStorage.setItem(keyFor(toolId), JSON.stringify(sample));
  } catch {
    // Same, and the entry is already gone: the next open offers nothing rather than the wrong thing.
  }
}
