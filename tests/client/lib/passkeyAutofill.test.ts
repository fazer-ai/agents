import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// The server side of the sign-in, answered at `fetch` under the real Eden client and restored after
// the file: `mock.module` on the client would be process-wide.
let optionsCalls = 0;
let optionsGate: Promise<void> = Promise.resolve();
let optionsFail = false;
const mockOptions = mock(async () => {
  optionsCalls += 1;
  await optionsGate;
  if (optionsFail) {
    return {
      data: null,
      error: { status: 503, value: { error: "Service unavailable" } },
    };
  }
  return {
    data: {
      challengeId: `token-${optionsCalls}`,
      options: { challenge: "Y2hhbGxlbmdl", rpId: "localhost" },
    },
    error: null,
  };
});
let loginGate: Promise<void> = Promise.resolve();
const mockLogin = mock(async (_body: { challengeId: string }) => {
  await loginGate;
  return {
    data: { user: { id: "u1", email: "a@example.com" } },
    error: null,
  };
});
const realFetch = globalThis.fetch;
type Answer = {
  data: unknown;
  error: { status: number; value?: unknown } | null;
};
const respond = ({ data, error }: Answer) =>
  new Response(JSON.stringify(error ? (error.value ?? {}) : data), {
    status: error ? error.status : 200,
    headers: { "content-type": "application/json" },
  });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input as RequestInfo, init);
  const path = new URL(request.url).pathname;
  if (path === "/api/auth/passkeys/login/options") {
    return respond(await mockOptions());
  }
  if (path === "/api/auth/passkeys/login") {
    return respond(await mockLogin(JSON.parse(await request.text())));
  }
  return realFetch(input as RequestInfo | URL, init);
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

const { passkeyAutofill, PasskeyCancelled } = await import(
  "@/client/lib/passkey"
);

type GetCall = { signal?: AbortSignal; resolve: (value: unknown) => void };
let calls: GetCall[] = [];

const bytes = (text: string) => new TextEncoder().encode(text).buffer;
const credential = () => ({
  id: "cred",
  rawId: bytes("cred"),
  type: "public-key",
  response: {
    authenticatorData: bytes("ad"),
    clientDataJSON: bytes("cd"),
    signature: bytes("sig"),
    userHandle: bytes("1"),
  },
  getClientExtensionResults: () => ({}),
  authenticatorAttachment: "platform",
});

beforeEach(() => {
  calls = [];
  optionsCalls = 0;
  optionsGate = Promise.resolve();
  optionsFail = false;
  loginGate = Promise.resolve();
  mockLogin.mockClear();
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: {
      get: (opts: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          calls.push({ signal: opts.signal, resolve });
          opts.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    },
  });
});
afterEach(() => {
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: undefined,
  });
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("passkeyAutofill", () => {
  // NOTE: the server refuses a sign-in challenge after 5 minutes, and a
  // conditional request can wait for hours: picking a passkey from a stale
  // request would fail although the passkey is fine.
  test("re-arms with fresh options before the challenge runs out, and signs in with the fresh one", async () => {
    const timers: (() => void)[] = [];
    const autofill = passkeyAutofill({
      schedule: (fn) => {
        timers.push(fn);
        return () => {};
      },
    });
    const signedIn = autofill.run(() => true);
    await flush();
    expect(calls).toHaveLength(1);
    timers[0]?.();
    await flush();
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(calls).toHaveLength(2);
    calls[1]?.resolve(credential());
    await signedIn;
    expect(mockLogin.mock.calls[0]?.[0].challengeId).toBe("token-2");
  });

  // NOTE: a stop that lands while the options are still on the way must keep
  // the request from ever starting: started later, it would take the page's
  // one WebAuthn request from the button that stopped it.
  test("stopped while its options are in flight, it never asks the browser", async () => {
    let release: () => void = () => {};
    optionsGate = new Promise((r) => {
      release = r;
    });
    const autofill = passkeyAutofill();
    const run = autofill.run(() => true);
    autofill.stop();
    release();
    await expect(run).rejects.toBeInstanceOf(PasskeyCancelled);
    expect(calls).toHaveLength(0);
  });

  // NOTE: the attempt that stopped it shows its own error; a stopped request
  // answering with a failure must not replace it.
  test("stopped while its options are in flight, a failed answer stays silent", async () => {
    let release: () => void = () => {};
    optionsGate = new Promise((r) => {
      release = r;
    });
    optionsFail = true;
    const autofill = passkeyAutofill();
    const run = autofill.run(() => true);
    autofill.stop();
    release();
    await expect(run).rejects.toBeInstanceOf(PasskeyCancelled);
  });

  test("stopped while the browser waits, it aborts its own request and signs nobody in", async () => {
    const autofill = passkeyAutofill();
    const run = autofill.run(() => true);
    await flush();
    autofill.stop();
    await expect(run).rejects.toBeInstanceOf(PasskeyCancelled);
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(mockLogin).not.toHaveBeenCalled();
  });

  // NOTE: the person picked a passkey and then followed a link off /login
  // while the verify was on its way; the late success must not pull them back.
  test("stopped while the verify is on its way, a late success is dropped", async () => {
    let release: () => void = () => {};
    loginGate = new Promise((r) => {
      release = r;
    });
    const autofill = passkeyAutofill();
    const run = autofill.run(() => true);
    await flush();
    calls[0]?.resolve(credential());
    await flush();
    expect(mockLogin).toHaveBeenCalled();
    autofill.stop();
    release();
    await expect(run).rejects.toBeInstanceOf(PasskeyCancelled);
  });
});
