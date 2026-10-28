import { serverNow } from "@/client/lib/serverClock";

// The passkey offer is decided once per sign-in: a reload or a
// navigation inside the same session does not bring it back. Per tab, which is
// what a session looks like from here, and reset by every new sign-in.
const SEEN_KEY = "@app:passkey-offer-seen";

export function passkeyOfferSeen(): boolean {
  try {
    return sessionStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function markPasskeyOfferSeen() {
  try {
    sessionStorage.setItem(SEEN_KEY, "1");
  } catch {
    // NOTE: storage blocked: the offer may come back on a reload, which only
    // costs a "Not now" click.
  }
}

// Which sign-in the page is in, bumped on every sign-in and sign-out
// (AuthContext calls resetPasskeyOffer on both). Work started under one
// value must not act on, or speak for, the next: a profile save does not
// change it, unlike the user object.
let passkeySession = 0;

export const currentPasskeySession = () => passkeySession;

export function resetPasskeyOffer() {
  passkeySession += 1;
  try {
    sessionStorage.removeItem(SEEN_KEY);
  } catch {
    // NOTE: nothing to reset when storage is blocked.
  }
}

// Every passkey the client makes (Settings, the offer, the silent
// upgrade) is announced, so a mounted list reloads and an open offer closes.
// The event names the sign-in the registration started in: a late success
// for an account that has signed out must not close the next one's offer.
export const PASSKEYS_CHANGED_EVENT = "passkeys:changed";

export function announcePasskeysChanged(startedIn: number) {
  window.dispatchEvent(
    new CustomEvent(PASSKEYS_CHANGED_EVENT, {
      detail: { session: startedIn },
    }),
  );
}

export function isCurrentPasskeyChange(event: Event): boolean {
  return (
    (event as CustomEvent<{ session?: number }>).detail?.session ===
    passkeySession
  );
}

export type PasskeyOfferOutcome =
  | { kind: "none" }
  | { kind: "upgraded" }
  | { kind: "card"; expiresAt: Date };

const NONE: PasskeyOfferOutcome = { kind: "none" };

// The order of the offer, apart from React so it can be tested without
// stubbing modules: the server's yes, then the silent upgrade where the
// browser has it, then the card only when that made nothing. Marked seen
// before anything shows, so a reload in the middle does not offer twice.
// `isCurrent` is asked after every wait: a response that lands after the
// session it was asked for ended (a sign-out, another account signing in)
// must not mark, upgrade or show anything for the next one.
export async function decidePasskeyOffer(deps: {
  supported: () => boolean;
  seen: () => boolean;
  markSeen: () => void;
  isCurrent: () => boolean;
  fetchOffer: () => Promise<{ offer: boolean; expiresAt: Date | null }>;
  conditionalAvailable: () => Promise<boolean>;
  upgrade: (isCurrent: () => boolean) => Promise<unknown>;
}): Promise<PasskeyOfferOutcome> {
  if (deps.seen() || !deps.supported()) return NONE;
  let answer: { offer: boolean; expiresAt: Date | null };
  try {
    answer = await deps.fetchOffer();
  } catch {
    return NONE;
  }
  const { expiresAt } = answer;
  if (!answer.offer || !expiresAt || !deps.isCurrent()) return NONE;
  deps.markSeen();
  const conditional = await deps.conditionalAvailable();
  if (!deps.isCurrent()) return NONE;
  if (conditional) {
    try {
      await deps.upgrade(deps.isCurrent);
      return { kind: "upgraded" };
    } catch {
      // NOTE: the password manager declined, or is not the one that signed
      // in: fall through to the card, silently.
    }
  }
  if (!deps.isCurrent()) return NONE;
  return { kind: "card", expiresAt };
}

// How long the card stays up. `expiresAt` is the end of the server's recent sign-in window, so it is
// measured against the server's clock: a browser clock ahead would hide a valid offer at once, one
// behind would leave the card up after "Create passkey" started needing the password again.
export function passkeyOfferRemainingMs(expiresAt: Date, now = serverNow()) {
  return Math.max(0, expiresAt.getTime() - now);
}
