import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  announcePasskeysChanged,
  currentPasskeySession,
  decidePasskeyOffer,
  isCurrentPasskeyChange,
  markPasskeyOfferSeen,
  PASSKEYS_CHANGED_EVENT,
  passkeyOfferSeen,
  resetPasskeyOffer,
} from "@/client/lib/passkeyOffer";

const UNTIL = new Date("2026-10-14T12:05:00Z");

function deps(over: Partial<Parameters<typeof decidePasskeyOffer>[0]> = {}) {
  return {
    supported: () => true,
    seen: () => false,
    markSeen: mock(() => {}),
    isCurrent: () => true,
    fetchOffer: mock(async () => ({ offer: true, expiresAt: UNTIL })),
    conditionalAvailable: mock(async () => false),
    upgrade: mock(async () => ({})),
    ...over,
  };
}

describe("decidePasskeyOffer", () => {
  test("an offer with no silent upgrade in the browser shows the card until the window closes, and the session remembers it", async () => {
    const d = deps();
    expect(await decidePasskeyOffer(d)).toEqual({
      kind: "card",
      expiresAt: UNTIL,
    });
    expect(d.markSeen).toHaveBeenCalledTimes(1);
    expect(d.upgrade).not.toHaveBeenCalled();
  });

  // NOTE: the offer's order: the browser's silent upgrade first, the card
  // only when it made nothing.
  test("where the browser has the silent upgrade it is tried once, and a success shows nothing", async () => {
    const d = deps({ conditionalAvailable: mock(async () => true) });
    expect((await decidePasskeyOffer(d)).kind).toBe("upgraded");
    expect(d.upgrade).toHaveBeenCalledTimes(1);
  });

  test("a declined silent upgrade falls back to the card without surfacing the error", async () => {
    const d = deps({
      conditionalAvailable: mock(async () => true),
      upgrade: mock(async () => {
        throw new Error("NotAllowedError");
      }),
    });
    expect((await decidePasskeyOffer(d)).kind).toBe("card");
  });

  test("an offer already decided in this session is not asked for again", async () => {
    const d = deps({ seen: () => true });
    expect((await decidePasskeyOffer(d)).kind).toBe("none");
    expect(d.fetchOffer).not.toHaveBeenCalled();
  });

  test("a browser without WebAuthn is never offered one", async () => {
    const d = deps({ supported: () => false });
    expect((await decidePasskeyOffer(d)).kind).toBe("none");
    expect(d.fetchOffer).not.toHaveBeenCalled();
  });

  test("no offer from the server, or none readable, shows nothing and leaves the session unmarked", async () => {
    for (const fetchOffer of [
      mock(async () => ({ offer: false, expiresAt: null })),
      mock(async () => {
        throw new Error("offline");
      }),
    ]) {
      const d = deps({ fetchOffer });
      expect((await decidePasskeyOffer(d)).kind).toBe("none");
      expect(d.markSeen).not.toHaveBeenCalled();
      expect(d.conditionalAvailable).not.toHaveBeenCalled();
    }
  });

  // NOTE: the answer can land after a sign-out and another account's sign-in;
  // it must not mark that session, upgrade with its cookie, or show it a card.
  test("an answer for a session that has ended does nothing to the next one", async () => {
    const d = deps({
      isCurrent: () => false,
      conditionalAvailable: mock(async () => true),
    });
    expect((await decidePasskeyOffer(d)).kind).toBe("none");
    expect(d.markSeen).not.toHaveBeenCalled();
    expect(d.upgrade).not.toHaveBeenCalled();
  });

  test("the upgrade is handed the same session check, to ask before it starts the browser's ceremony", async () => {
    let current = true;
    const upgrade = mock(async (isCurrent: () => boolean) => {
      current = false;
      if (!isCurrent()) throw new Error("cancelled");
    });
    const d = deps({
      isCurrent: () => current,
      conditionalAvailable: mock(async () => true),
      upgrade,
    });
    expect((await decidePasskeyOffer(d)).kind).toBe("none");
    expect(upgrade).toHaveBeenCalledTimes(1);
  });

  test("a session that ends while the browser is asked about the upgrade is not upgraded", async () => {
    let current = true;
    const d = deps({
      isCurrent: () => current,
      conditionalAvailable: mock(async () => {
        current = false;
        return true;
      }),
    });
    expect((await decidePasskeyOffer(d)).kind).toBe("none");
    expect(d.upgrade).not.toHaveBeenCalled();
  });
});

describe("the per-session mark", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  test("a new sign-in clears it, so the next one may be offered again", () => {
    markPasskeyOfferSeen();
    expect(passkeyOfferSeen()).toBe(true);
    resetPasskeyOffer();
    expect(passkeyOfferSeen()).toBe(false);
  });
});

// NOTE: a registration that finishes after its account signed out must not
// close the next account's offer.
test("a passkey announced by an earlier sign-in does not speak for the current one", () => {
  const seen: boolean[] = [];
  const listen = (event: Event) => seen.push(isCurrentPasskeyChange(event));
  window.addEventListener(PASSKEYS_CHANGED_EVENT, listen);
  try {
    const before = currentPasskeySession();
    announcePasskeysChanged(before);
    resetPasskeyOffer();
    announcePasskeysChanged(before);
    announcePasskeysChanged(currentPasskeySession());
  } finally {
    window.removeEventListener(PASSKEYS_CHANGED_EVENT, listen);
  }
  expect(seen).toEqual([true, false, true]);
});
