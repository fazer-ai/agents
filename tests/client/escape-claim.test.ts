import { afterEach, describe, expect, test } from "bun:test";
import { claimEscape, handOverEscape } from "@/client/components/escapeClaim";

// Who owns Escape inside an open dialog. Radix listens on `document` with `capture: true`, so a
// control inside the dialog cannot stop the press and cannot register early enough to try; what it
// can do is declare the claim, which `<Modal>` turns into the `preventDefault` Radix reads back.
// Measured in a browser (issue #538): without this, dismissing a completion suggestion asked the
// operator whether to discard the body they were writing.

const releases: Array<() => void> = [];
function claiming(fn: (t: EventTarget | null) => boolean) {
  const release = claimEscape(fn);
  releases.push(release);
  return release;
}
afterEach(() => {
  while (releases.length > 0) releases.pop()?.();
});

describe("escape claims", () => {
  test("nothing is claimed by default, so the dialog keeps closing", () => {
    expect(handOverEscape(null)).toBe(false);
  });

  test("a claim answers for its own target and no other", () => {
    const mine = {} as EventTarget;
    const theirs = {} as EventTarget;
    claiming((t) => t === mine);
    expect(handOverEscape(mine)).toBe(true);
    // Two editors can be open at once; only the one the press happened in may cancel the close.
    expect(handOverEscape(theirs)).toBe(false);
  });

  test("releasing gives Escape back", () => {
    const mine = {} as EventTarget;
    const release = claiming((t) => t === mine);
    expect(handOverEscape(mine)).toBe(true);
    release();
    expect(handOverEscape(mine)).toBe(false);
  });

  // A claim left behind by an unmounted control would answer for a DOM node that no longer exists,
  // and the dialog would stop closing on Escape with nothing on screen explaining it.
  test("a released claim is not consulted again", () => {
    let asked = 0;
    const release = claiming(() => {
      asked += 1;
      return false;
    });
    handOverEscape(null);
    expect(asked).toBe(1);
    release();
    handOverEscape(null);
    expect(asked).toBe(1);
  });

  test("one claim is enough, and the rest still get their say", () => {
    const t = {} as EventTarget;
    claiming(() => false);
    claiming(() => true);
    expect(handOverEscape(t)).toBe(true);
  });
});
