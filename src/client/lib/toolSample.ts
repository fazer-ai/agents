// THE HALF OF A SAMPLE RESPONSE THAT NEVER LEAVES THE BROWSER (issue #566).
//
// The tool editor stores the SHAPE of a pasted sample server-side, which is what the path pickers
// and the caret completion need. The preview needs the VALUES, and those are the customer's data —
// so they stay here, in the browser that already had them on screen, keyed by tool id.
//
// WHAT THIS BUYS OVER STORING THEM. "We never store the response" is a stronger invariant than "we
// store it when a toggle is on": no backup question, no bundle question, no export rule to keep in
// step. The price is that the preview reads over the shape on a different machine, or after this
// storage is cleared, and the field says so when that happens rather than quietly showing stand-ins
// as if they were the API's answer.
//
// EVERY ACCESS IS GUARDED. `localStorage` throws outright in some contexts (a private window with
// site data blocked, a browser configured to refuse storage), and it can be full. A sample that
// cannot be kept is not an error the operator can act on — it costs them the values on the next
// open, which is exactly today's behaviour — so nothing here reports a failure.

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

// Called when the tool is SAVED, not on every keystroke, so the two halves always describe the same
// sample: a text kept here while the shape beside it was never written would offer the operator
// values for a response the tool does not have.
export function writeLocalSample(
  toolId: string,
  sample: LocalSample | null,
): void {
  try {
    if (sample === null || sample.text.trim() === "") {
      localStorage.removeItem(keyFor(toolId));
      return;
    }
    if (sample.text.length > MAX_STORED_CHARS) {
      // NOTE: cleared rather than left holding the PREVIOUS sample, which would restore values from
      // a response the tool no longer describes.
      localStorage.removeItem(keyFor(toolId));
      return;
    }
    localStorage.setItem(keyFor(toolId), JSON.stringify(sample));
  } catch {
    // See the module header: nothing to report and nothing to do.
  }
}
