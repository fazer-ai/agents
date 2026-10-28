import {
  type AuthenticationResponseJSON,
  base64URLStringToBuffer,
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  bufferToBase64URLString,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from "@simplewebauthn/browser";
import { api } from "@/client/lib/api";
import {
  announcePasskeysChanged,
  currentPasskeySession,
} from "@/client/lib/passkeyOffer";
import type { ApiErrorPayload } from "@/client/lib/types";

export const passkeysSupported = () => browserSupportsWebAuthn();

// The library keeps one WebAuthn ceremony at a time and a new one
// aborts the last, so the silent upgrade, which runs in the background, must
// never start its own while a person's sign-in or registration is running or
// has started since the upgrade began. Counted from the moment the
// person asks, options request included, not from the browser call.
const foreground = { active: 0, started: 0 };

// Who holds the library's slot right now: every call into the library
// takes the next number. Asking "did anyone start a ceremony after mine" is
// what the upgrade's deadline needs; a person's request that failed before
// reaching the browser (a wrong password) took no number.
let ceremonies = 0;
const claimSlot = () => ++ceremonies;

// `ensureCurrent` throws once the page has signed in or out since the
// request began. Asked after each wait, before the browser's ceremony starts
// and before its answer is submitted: a late response for an ended session
// would otherwise take the library's slot from the next one's ceremony (a
// passkey sign-in on /login) or register under the wrong account.
async function asForeground<T>(
  fn: (ensureCurrent: () => void) => Promise<T>,
): Promise<T> {
  foreground.active += 1;
  foreground.started += 1;
  const startedIn = currentPasskeySession();
  const ensureCurrent = () => {
    if (currentPasskeySession() !== startedIn) throw new PasskeyCancelled();
  };
  try {
    return await fn(ensureCurrent);
  } finally {
    foreground.active -= 1;
  }
}

/** The person closed the browser's dialog: nothing to show. */
export class PasskeyCancelled extends Error {}

/** This authenticator already holds a passkey for this account. */
export class PasskeyAlreadyRegistered extends Error {}

// `value` is the server's refusal body as Eden hands it, so `apiErrorMessage` reads it like any other
// failed call; null when the failure was the browser's.
export class PasskeyFailed extends Error {
  constructor(
    readonly value: ApiErrorPayload | null,
    readonly status: number | null = null,
  ) {
    super(value?.error ?? "passkey failed");
  }
}

// The ceremony errors come from the browser, wrapped by
// @simplewebauthn/browser in a WebAuthnError whose `cause` is the original
// DOMException, so both names are read.
async function inBrowser<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (error) {
    const e = error as { name?: string; cause?: { name?: string } };
    const names = [e.name, e.cause?.name];
    // NOTE: NotAllowedError covers cancelled, timed out and "no passkey for
    // this site"; AbortError is a request the app or the browser cancelled
    // (switching tabs). None of them is the person's mistake.
    if (names.includes("NotAllowedError") || names.includes("AbortError")) {
      throw new PasskeyCancelled();
    }
    // NOTE: the browser refuses a second passkey for the same account on the
    // same authenticator (`excludeCredentials`) with InvalidStateError.
    if (names.includes("InvalidStateError")) {
      throw new PasskeyAlreadyRegistered();
    }
    throw new PasskeyFailed(null);
  }
}

// `signal` is the page that asked going away: before the browser's dialog it
// stops the request, during it closes the dialog, and after it keeps the
// answer from being submitted. A verify already sent has opened a session,
// so its user still comes back.
export function signInWithPasskey(signal?: AbortSignal) {
  return asForeground((ensureCurrent) =>
    signInWithPasskeyNow(() => {
      if (signal?.aborted) throw new PasskeyCancelled();
      ensureCurrent();
    }, signal),
  );
}

async function signInWithPasskeyNow(
  ensureCurrent: () => void,
  signal?: AbortSignal,
) {
  const o = await api.api.auth.passkeys.login.options.post();
  if (o.error || !o.data) {
    throw new PasskeyFailed(
      (o.error?.value as ApiErrorPayload | null) ?? null,
      o.error?.status,
    );
  }
  const { challengeId, options } = o.data;
  ensureCurrent();
  const mine = claimSlot();
  const closeDialog = () => {
    if (ceremonies === mine) WebAuthnAbortService.cancelCeremony();
  };
  signal?.addEventListener("abort", closeDialog, { once: true });
  const response = await inBrowser(() =>
    startAuthentication({ optionsJSON: options }),
  ).finally(() => signal?.removeEventListener("abort", closeDialog));
  ensureCurrent();
  const r = await api.api.auth.passkeys.login.post({ challengeId, response });
  if (r.error || !r.data) {
    throw new PasskeyFailed(
      (r.error?.value as ApiErrorPayload | null) ?? null,
      r.error?.status,
    );
  }
  return r.data.user;
}

/** The browser can offer passkeys in the email field's autofill. */
export const passkeyAutofillSupported = () =>
  browserSupportsWebAuthnAutofill().catch(() => false);

// A sign-in challenge lives 5 minutes on the server, and a conditional
// request can wait far longer than that for the person to pick a passkey, so
// the request is re-armed with fresh options before its challenge runs out.
export const AUTOFILL_REFRESH_MS = 4 * 60 * 1000;

// The browser's answer, in the shape the server's verify takes. Done
// here rather than through `startAuthentication` because that call awaits
// a capability check before it creates its abort signal, and a stop landing
// in that gap could not reach it: the request would start afterwards and,
// through the library's one-ceremony rule, abort the button's.
function toAuthenticationJSON(
  credential: PublicKeyCredential,
): AuthenticationResponseJSON {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64URLString(credential.rawId),
    type: "public-key",
    response: {
      authenticatorData: bufferToBase64URLString(response.authenticatorData),
      clientDataJSON: bufferToBase64URLString(response.clientDataJSON),
      signature: bufferToBase64URLString(response.signature),
      ...(response.userHandle
        ? { userHandle: bufferToBase64URLString(response.userHandle) }
        : {}),
    },
    clientExtensionResults: credential.getClientExtensionResults(),
    ...(credential.authenticatorAttachment
      ? {
          authenticatorAttachment:
            credential.authenticatorAttachment as AuthenticatorAttachment,
        }
      : {}),
  };
}

// The passkey offered in the email field's autofill on /login: a `navigator.credentials.get({
// mediation: "conditional" })` that waits, with nothing on screen, until the person picks a passkey
// from the suggestions. A page holds one WebAuthn request at a time, so the page stops this one before
// any other way in starts. It owns its abort controller and stays outside the library's ceremony slot,
// so `stop` reaches it at any point and never aborts a ceremony that is not its own. `onPicked` runs
// once the browser answers, before the answer is sent; returning false drops it (another way in
// started). `schedule` is the timer a test injects.
export function passkeyAutofill({
  refreshMs = AUTOFILL_REFRESH_MS,
  schedule = (fn: () => void, ms: number) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
}: {
  refreshMs?: number;
  schedule?: (fn: () => void, ms: number) => () => void;
} = {}) {
  let stopped = false;
  let current: AbortController | null = null;
  const stop = () => {
    stopped = true;
    current?.abort();
  };
  const attempt = async () => {
    const controller = new AbortController();
    current = controller;
    let refreshed = false;
    // every wait below re-checks `stopped` before reading what came
    // back: a stopped request stays silent whatever its answer, so a late
    // failure cannot overwrite the error of the attempt that stopped it.
    const o = await api.api.auth.passkeys.login.options.post();
    if (stopped) throw new PasskeyCancelled();
    if (o.error || !o.data) {
      throw new PasskeyFailed(
        (o.error?.value as ApiErrorPayload | null) ?? null,
        o.error?.status,
      );
    }
    const { challengeId, options } = o.data;
    const cancelRefresh = schedule(() => {
      refreshed = true;
      controller.abort();
    }, refreshMs);
    let credential: Credential | null;
    try {
      credential = await inBrowser(() =>
        navigator.credentials.get({
          publicKey: {
            ...options,
            challenge: base64URLStringToBuffer(options.challenge),
            allowCredentials: [],
          } as PublicKeyCredentialRequestOptions,
          mediation: "conditional",
          signal: controller.signal,
        } as CredentialRequestOptions),
      );
    } catch (error) {
      if (stopped) throw new PasskeyCancelled();
      if (refreshed) return null;
      throw error;
    } finally {
      cancelRefresh();
    }
    if (!credential || stopped) throw new PasskeyCancelled();
    return { challengeId, credential: credential as PublicKeyCredential };
  };
  const run = async (onPicked: () => boolean) => {
    let picked: Awaited<ReturnType<typeof attempt>> = null;
    while (!picked) picked = await attempt();
    if (stopped || !onPicked()) throw new PasskeyCancelled();
    const r = await api.api.auth.passkeys.login.post({
      challengeId: picked.challengeId,
      response: toAuthenticationJSON(picked.credential),
    });
    // NOTE: stopped while the answer was on its way (the person followed a
    // link off the page): a late failure stays silent, but a late success has
    // opened a session on the server and still comes back, so the page can
    // record it; not navigating is the page's call.
    if (r.error || !r.data) {
      if (stopped) throw new PasskeyCancelled();
      throw new PasskeyFailed(
        (r.error?.value as ApiErrorPayload | null) ?? null,
        r.error?.status,
      );
    }
    return r.data.user;
  };
  return { run, stop };
}

// The proof is the credential the account already has (the current
// password, or a fresh Google sign-in); the server refuses a session alone.
export function registerPasskey(
  proof: { password?: string; googleCredential?: string },
  name?: string,
) {
  return asForeground((ensureCurrent) =>
    registerPasskeyNow(proof, name, ensureCurrent),
  );
}

async function registerPasskeyNow(
  proof: { password?: string; googleCredential?: string },
  name: string | undefined,
  ensureCurrent: () => void,
) {
  const startedIn = currentPasskeySession();
  const o = await api.api.auth.passkeys.register.options.post(proof);
  if (o.error || !o.data) {
    throw new PasskeyFailed(
      (o.error?.value as ApiErrorPayload | null) ?? null,
      o.error?.status,
    );
  }
  const { challengeId, options } = o.data;
  ensureCurrent();
  const response = await inBrowser(() => {
    claimSlot();
    return startRegistration({ optionsJSON: options });
  });
  ensureCurrent();
  const r = await api.api.auth.passkeys.register.post({
    challengeId,
    response,
    ...(name ? { name } : {}),
  });
  if (r.error || !r.data) {
    throw new PasskeyFailed(
      (r.error?.value as ApiErrorPayload | null) ?? null,
      r.error?.status,
    );
  }
  announcePasskeysChanged(startedIn);
  return r.data.passkey;
}

// The browser's silent upgrade after a password sign-in. Only
// the capability says whether it exists: Safari 18+ and Chrome 136+ report
// `conditionalCreate`, and calling it elsewhere would open a dialog.
export async function conditionalCreateAvailable(): Promise<boolean> {
  const pkc = (
    globalThis as {
      PublicKeyCredential?: {
        getClientCapabilities?: () => Promise<Record<string, boolean>>;
      };
    }
  ).PublicKeyCredential;
  if (typeof pkc?.getClientCapabilities !== "function") return false;
  try {
    return (await pkc.getClientCapabilities()).conditionalCreate === true;
  } catch {
    return false;
  }
}

// How long the browser gets to decide on the silent upgrade. Measured
// in Chromium under automation: with no password manager to answer, the
// conditional create never settles, which would leave the card unshown and
// the ceremony holding the one WebAuthn request a page may have open.
export const CONDITIONAL_CREATE_TIMEOUT_MS = 5_000;

// Best effort. The password manager decides, and a refusal comes back
// as NotAllowedError with nothing shown; the caller treats any throw as "no
// passkey was made". `isCurrent` is asked once the options arrive: starting
// the ceremony for a session that has ended would abort whatever ceremony
// the page started since (the library keeps one at a time), such as a
// passkey sign-in on /login.
export async function upgradeToPasskey(
  isCurrent: () => boolean = () => true,
  timeoutMs = CONDITIONAL_CREATE_TIMEOUT_MS,
) {
  const startedAt = foreground.started;
  const startedIn = currentPasskeySession();
  const o = await api.api.auth.passkeys.register.options.post({
    conditional: true,
  });
  if (o.error || !o.data) {
    throw new PasskeyFailed(
      (o.error?.value as ApiErrorPayload | null) ?? null,
      o.error?.status,
    );
  }
  const { challengeId, options } = o.data;
  // NOTE: two questions, kept apart. Before starting: has a person asked for
  // a ceremony (running, or since this upgrade began)? Then yield to them.
  // At the deadline: does the slot still hold this upgrade's ceremony? Only
  // then may `cancelCeremony()` run, since it aborts whoever holds the slot.
  if (
    !isCurrent() ||
    foreground.active > 0 ||
    foreground.started !== startedAt
  ) {
    throw new PasskeyCancelled();
  }
  const mine = claimSlot();
  const timer = setTimeout(() => {
    if (ceremonies === mine) WebAuthnAbortService.cancelCeremony();
  }, timeoutMs);
  const response = await inBrowser(() =>
    startRegistration({ optionsJSON: options, useAutoRegister: true }),
  ).finally(() => clearTimeout(timer));
  if (!isCurrent()) throw new PasskeyCancelled();
  const r = await api.api.auth.passkeys.register.post({
    challengeId,
    response,
  });
  if (r.error || !r.data) {
    throw new PasskeyFailed(
      (r.error?.value as ApiErrorPayload | null) ?? null,
      r.error?.status,
    );
  }
  announcePasskeysChanged(startedIn);
  return r.data.passkey;
}
