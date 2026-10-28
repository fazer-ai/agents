/// <reference lib="dom" />

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { WebAuthnAbortService } from "@simplewebauthn/browser";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import * as GoogleButtonModule from "@/client/components/GoogleSignInButton";
import { withI18n } from "@/tests/utils/i18n";
import { stubExports } from "@/tests/utils/module-stub";
import { until } from "@/tests/utils/poll";

type Passkey = {
  id: string;
  name: string | null;
  provider: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

let stored: Passkey[] = [];
const mockList = mock(async () => ({
  data: { passkeys: stored },
  error: null as { status: number } | null,
}));
const mockPatch = mock(async (_body: { name: string | null }) => ({
  data: { success: true },
  error: null as { status: number; value: unknown } | null,
}));
const mockDelete = mock(async () => ({
  data: { success: true },
  error: null as { status: number; value: unknown } | null,
}));
const mockRegisterOptions = mock(async (_proof: unknown) => ({
  data: {
    challengeId: "c1",
    options: {
      challenge: "Y2hhbGxlbmdl",
      rp: { id: "localhost", name: "localhost" },
      user: { id: "MQ", name: "a@example.com", displayName: "Ana" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    },
  },
  error: null as { status: number; value: unknown } | null,
}));
const mockRegister = mock(async () => ({ data: null, error: null }));
const passkeyById = mock((_: { passkeyId: string }) => ({
  patch: mockPatch,
  delete: mockDelete,
}));

// The section talks to the server through the real Eden client; `fetch` is answered by the mocks
// above, so each test shapes a route's answer the way the server would. Restored after the file:
// `mock.module` on the client would be process-wide and reach every other screen's tests.
const realFetch = globalThis.fetch;
type Answer = {
  data: unknown;
  error: { status: number; value?: unknown } | null;
};
const respond = ({ data, error }: Answer) =>
  new Response(JSON.stringify(error ? (error.value ?? {}) : (data ?? null)), {
    status: error ? error.status : 200,
    headers: { "content-type": "application/json" },
  });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input as RequestInfo, init);
  const path = new URL(request.url).pathname;
  const text = await request.clone().text();
  const body = text ? JSON.parse(text) : undefined;
  if (path === "/api/auth/passkeys" && request.method === "GET") {
    return respond(await mockList());
  }
  if (path === "/api/auth/passkeys/register/options") {
    return respond(await mockRegisterOptions(body));
  }
  if (path === "/api/auth/passkeys/register") {
    return respond(await mockRegister());
  }
  const one = /^\/api\/auth\/passkeys\/([^/]+)$/.exec(path);
  if (one?.[1]) {
    const target = passkeyById({ passkeyId: decodeURIComponent(one[1]) });
    return respond(
      request.method === "PATCH"
        ? await target.patch(body)
        : await target.delete(),
    );
  }
  return realFetch(input as RequestInfo | URL, init);
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

// The real button needs Google's script; the stub hands the test the credential callback.
let googleOnCredential: ((credential: string) => void) | undefined;
stubExports(GoogleButtonModule, {
  GoogleSignInButton: (({
    onCredential,
  }: {
    onCredential: (credential: string) => void;
  }) => {
    googleOnCredential = onCredential;
    return null;
  }) as never,
});

const { ToastProvider } = await import("@/client/components");
const { PASSKEYS_CHANGED_EVENT, resetPasskeyOffer } = await import(
  "@/client/lib/passkeyOffer"
);
const { PasskeyCancelled, registerPasskey, upgradeToPasskey } = await import(
  "@/client/lib/passkey"
);
const { SecurityPasskeysSection } = await import(
  "@/client/pages/settings/SecurityPasskeysSection"
);

const onCountChange = mock((_: number | null) => {});

function renderSection({
  hasPassword = true,
  googleClientId = null as string | null,
  otherWayIn = true,
} = {}) {
  return render(
    withI18n(
      <ToastProvider>
        <SecurityPasskeysSection
          hasPassword={hasPassword}
          googleClientId={googleClientId}
          otherWayIn={otherWayIn}
          onCountChange={onCountChange}
        />
      </ToastProvider>,
    ),
  );
}

async function openAddWithPassword(password = "my-password") {
  fireEvent.click(screen.getByRole("button", { name: "Add passkey" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(
    dialog.querySelector("input[type=password]") as HTMLInputElement,
    { target: { value: password } },
  );
  await act(async () => {
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create passkey" }),
    );
  });
  return dialog;
}

function stubWebAuthn(
  create: (options?: { signal?: AbortSignal }) => Promise<unknown>,
) {
  (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential =
    class {};
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: { create },
  });
}

beforeEach(() => {
  stored = [
    {
      id: "p1",
      name: null,
      provider: "iCloud Keychain",
      createdAt: "2026-03-01T12:00:00.000Z",
      lastUsedAt: null,
    },
    {
      id: "p2",
      name: "Work laptop",
      provider: "Chrome · macOS",
      createdAt: "2026-04-01T12:00:00.000Z",
      lastUsedAt: "2026-04-02T12:00:00.000Z",
    },
  ];
  for (const m of [
    mockList,
    mockPatch,
    mockDelete,
    mockRegister,
    mockRegisterOptions,
    onCountChange,
  ]) {
    m.mockClear();
  }
});

afterEach(() => {
  cleanup();
  delete (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: undefined,
  });
});

test("lists each passkey by its name, or by provider and date when it has none, and reports the count", async () => {
  renderSection();
  await waitFor(() => expect(screen.getByText("Work laptop")).toBeDefined());
  expect(screen.getByText(/^iCloud Keychain, /)).toBeDefined();
  expect(screen.getByText(/never used/)).toBeDefined();
  expect(onCountChange).toHaveBeenLastCalledWith(2);
});

// The offer after sign-in, or the browser's silent upgrade, can make a passkey while this list is
// on screen, and the list shows it.
test("a passkey made outside this section shows up in the list", async () => {
  stored = [];
  renderSection();
  await screen.findByText("No passkeys yet");
  stored = [
    {
      id: "new",
      name: "From the offer",
      provider: null,
      createdAt: "2026-10-14T12:00:00.000Z",
      lastUsedAt: null,
    },
  ];
  act(() => {
    window.dispatchEvent(new Event(PASSKEYS_CHANGED_EVENT));
  });
  expect(await screen.findByText("From the offer")).toBeTruthy();
});

// The library aborts the previous ceremony whenever a new one
// starts, so a background upgrade whose options land late would cancel the
// registration the person just started on this screen.
test("a background upgrade yields to a registration the person started while it waited", async () => {
  let release = () => {};
  const firstOptions = (await mockRegisterOptions({})).data;
  mockRegisterOptions.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { data: firstOptions, error: null };
  });
  const create = mock(async () => {
    throw Object.assign(new Error("closed"), { name: "NotAllowedError" });
  });
  stubWebAuthn(create);

  const upgrade = upgradeToPasskey();
  await registerPasskey({ password: "my-password" }).catch(() => {});
  release();

  await expect(upgrade).rejects.toBeInstanceOf(PasskeyCancelled);
  expect(create).toHaveBeenCalledTimes(1);
});

test("a background upgrade does not start while a registration the person asked for is still under way", async () => {
  let release = () => {};
  const firstOptions = (await mockRegisterOptions({})).data;
  mockRegisterOptions.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { data: firstOptions, error: null };
  });
  const create = mock(async () => {
    throw Object.assign(new Error("closed"), { name: "NotAllowedError" });
  });
  stubWebAuthn(create);

  const person = registerPasskey({ password: "my-password" }).catch(() => {});
  await expect(upgradeToPasskey()).rejects.toBeInstanceOf(PasskeyCancelled);
  expect(create).not.toHaveBeenCalled();
  release();
  await person;
  expect(create).toHaveBeenCalledTimes(1);
});

// NOTE: the upgrade's deadline calls the library's cancelCeremony(), which
// aborts whatever ceremony holds the slot. A person's registration started
// before it fires holds the slot by then and must not be the one aborted.
test("the upgrade's deadline does not abort a registration the person started meanwhile", async () => {
  const signals: AbortSignal[] = [];
  let calls = 0;
  stubWebAuthn(
    (opts?: { signal?: AbortSignal }) =>
      new Promise((_, reject) => {
        calls += 1;
        // NOTE: the conditional request does not settle on its own (as in
        // Chromium without a password manager); the person's honors its signal.
        if (calls === 1) return;
        const signal = opts?.signal as AbortSignal;
        signals.push(signal);
        signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      }),
  );

  void upgradeToPasskey(() => true, 20).catch(() => {});
  await until("the silent upgrade asked the browser", () => calls === 1);
  const person = registerPasskey({ password: "my-password" }).catch(() => {});
  await until(
    "the person's registration reached the browser",
    () => calls === 2,
  );
  // NOTE: past the 20 ms deadline.
  await new Promise((resolve) => setTimeout(resolve, 40));

  expect(signals[0]?.aborted).toBe(false);
  // NOTE: settle the person's ceremony, so the next test does not start with
  // one still counted as running.
  WebAuthnAbortService.cancelCeremony();
  await person;
});

test("a person's request that fails before reaching the browser leaves the upgrade's deadline armed", async () => {
  let conditional: AbortSignal | undefined;
  stubWebAuthn(
    (opts?: { signal?: AbortSignal }) =>
      new Promise((_, reject) => {
        conditional = opts?.signal;
        conditional?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      }),
  );
  const upgrade = upgradeToPasskey(() => true, 20).catch((e) => e);
  await until("the silent upgrade asked the browser", () => conditional);
  mockRegisterOptions.mockImplementationOnce(async () => ({
    data: null as never,
    error: { status: 400, value: { error: "wrong password" } },
  }));
  await registerPasskey({ password: "wrong" }).catch(() => {});

  expect(await upgrade).toBeInstanceOf(PasskeyCancelled);
  expect(conditional?.aborted).toBe(true);
});

// NOTE: the offer's card leaves sign-out reachable while its registration
// waits for options; the late answer must not start a ceremony that would
// take the slot from the next session's passkey sign-in.
test("a registration whose session ended while it waited never reaches the browser", async () => {
  let release = () => {};
  const firstOptions = (await mockRegisterOptions({})).data;
  mockRegisterOptions.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { data: firstOptions, error: null };
  });
  const create = mock(async () => ({}));
  stubWebAuthn(create);

  const pending = registerPasskey({}).catch((e) => e);
  await until("the options request went out", () =>
    mockRegisterOptions.mock.calls.length >= 2 ? true : null,
  );
  resetPasskeyOffer();
  release();

  expect(await pending).toBeInstanceOf(PasskeyCancelled);
  expect(create).not.toHaveBeenCalled();
});

test("without WebAuthn the add control is not offered", async () => {
  stored = [];
  renderSection();
  await waitFor(() =>
    expect(
      screen.getByText("This browser does not support passkeys."),
    ).toBeDefined(),
  );
  expect(screen.queryByRole("button", { name: "Add passkey" })).toBeNull();
});

test("a rename is saved and shown, and an empty name goes back to the provider", async () => {
  renderSection();
  await waitFor(() => expect(screen.getByText("Work laptop")).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Rename Work laptop" }));
  const dialog = await screen.findByRole("dialog");
  const field = within(dialog).getByLabelText("Passkey name");
  fireEvent.change(field, { target: { value: "" } });
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  });
  expect(passkeyById).toHaveBeenLastCalledWith({ passkeyId: "p2" });
  expect(mockPatch).toHaveBeenLastCalledWith({ name: null });
  await waitFor(() => expect(screen.queryByText("Work laptop")).toBeNull());
  expect(screen.getByText(/^Chrome · macOS, /)).toBeDefined();
});

test("removing goes through the confirmation, and a passkey already gone in another tab just leaves the list", async () => {
  // The first read still lists it; by the reload after the removal it
  // is gone on the server too.
  const removed = stored.filter((p) => p.id === "p2");
  stored = stored.filter((p) => p.id !== "p2");
  mockDelete.mockImplementationOnce(async () => ({
    data: null as never,
    error: { status: 404, value: { error: "Passkey not found" } },
  }));
  const listed = [...stored];
  mockList.mockImplementationOnce(async () => ({
    data: { passkeys: [...listed, ...removed] },
    error: null,
  }));
  renderSection();
  await waitFor(() => expect(screen.getByText("Work laptop")).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Remove Work laptop" }));
  expect(mockDelete).not.toHaveBeenCalled();
  const dialog = await screen.findByRole("dialog");
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
  });
  expect(passkeyById).toHaveBeenLastCalledWith({ passkeyId: "p2" });
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Remove Work laptop" }),
    ).toBeNull(),
  );
});

test("a failed removal keeps the passkey and the dialog, and says what the server said", async () => {
  mockDelete.mockImplementationOnce(async () => ({
    data: null as never,
    error: { status: 503, value: { error: "Service unavailable" } },
  }));
  renderSection();
  await waitFor(() => expect(screen.getByText("Work laptop")).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Remove Work laptop" }));
  const dialog = await screen.findByRole("dialog");
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
  });
  await waitFor(() =>
    expect(screen.getByText("Service unavailable")).toBeDefined(),
  );
  expect(screen.getByRole("dialog")).toBeDefined();
  expect(screen.getByText("Work laptop")).toBeDefined();
});

// NOTE: `excludeCredentials` makes the browser refuse a second passkey for
// the same account on the same authenticator with InvalidStateError.
test("a device that already holds a passkey for the account says so instead of failing", async () => {
  stubWebAuthn(() =>
    Promise.reject(new DOMException("exists", "InvalidStateError")),
  );
  renderSection();
  await waitFor(() => expect(screen.getByText("Work laptop")).toBeDefined());
  const dialog = await openAddWithPassword();
  expect(mockRegisterOptions).toHaveBeenLastCalledWith({
    password: "my-password",
  });
  await waitFor(() =>
    expect(
      within(dialog).getByText(/already has a passkey for this account/),
    ).toBeDefined(),
  );
  expect(mockRegister).not.toHaveBeenCalled();
});

test("closing the browser's dialog while adding shows nothing and keeps the dialog for another try", async () => {
  stubWebAuthn(() =>
    Promise.reject(new DOMException("cancelled", "NotAllowedError")),
  );
  renderSection();
  await waitFor(() => expect(screen.getByText("Work laptop")).toBeDefined());
  const dialog = await openAddWithPassword();
  await waitFor(() =>
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Create passkey",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  expect(mockRegister).not.toHaveBeenCalled();
  expect(within(dialog).queryByText(/could not/i)).toBeNull();
});

// NOTE: a stolen session must not be enough to add a passkey, so the server
// refuses without the current password; the dialog shows why and stays.
test("a wrong password is reported in the dialog and nothing is created", async () => {
  stubWebAuthn(() => Promise.reject(new Error("must not be reached")));
  mockRegisterOptions.mockImplementationOnce(async () => ({
    data: null as never,
    error: { status: 400, value: { error: "Could not confirm it is you." } },
  }));
  renderSection();
  await waitFor(() => expect(screen.getByText("Work laptop")).toBeDefined());
  const dialog = await openAddWithPassword("wrong");
  await waitFor(() =>
    expect(
      within(dialog).getByText("Could not confirm it is you."),
    ).toBeDefined(),
  );
  expect(mockRegister).not.toHaveBeenCalled();
});

test("an account without a password confirms with Google before creating", async () => {
  stubWebAuthn(() =>
    Promise.reject(new DOMException("cancelled", "NotAllowedError")),
  );
  renderSection({ hasPassword: false, googleClientId: "cid" });
  await waitFor(() => expect(screen.getByText("Work laptop")).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Add passkey" }));
  const dialog = await screen.findByRole("dialog");
  const create = within(dialog).getByRole("button", {
    name: "Create passkey",
  }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  act(() => googleOnCredential?.("google-id-token"));
  await waitFor(() => expect(create.disabled).toBe(false));
  await act(async () => {
    fireEvent.click(create);
  });
  expect(mockRegisterOptions).toHaveBeenLastCalledWith({
    googleCredential: "google-id-token",
  });
});

test("closing the add dialog with a name typed asks before discarding it", async () => {
  stubWebAuthn(() => Promise.reject(new Error("unused")));
  renderSection();
  await waitFor(() => expect(screen.getByText("Work laptop")).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Add passkey" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByPlaceholderText("Name (optional)"), {
    target: { value: "Phone" },
  });
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() =>
    expect(screen.getByText("Discard changes?")).toBeDefined(),
  );
});

test("the rename field is locked while the save runs", async () => {
  let finish: (value: unknown) => void = () => {};
  mockPatch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }) as never,
  );
  renderSection();
  await waitFor(() => expect(screen.getByText("Work laptop")).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Rename Work laptop" }));
  const dialog = await screen.findByRole("dialog");
  const field = within(dialog).getByLabelText(
    "Passkey name",
  ) as HTMLInputElement;
  fireEvent.change(field, { target: { value: "Desk" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(field.disabled).toBe(true));
  await act(async () => {
    finish({ data: { success: true }, error: null });
  });
});

test("the last way in cannot be removed, and the row says why", async () => {
  stored = stored.slice(0, 1);
  renderSection({ hasPassword: false, otherWayIn: false });
  await waitFor(() =>
    expect(screen.getByText(/only way into your account/)).toBeDefined(),
  );
  const remove = screen.getByRole("button", {
    name: /^Remove /,
  }) as HTMLButtonElement;
  expect(remove.disabled).toBe(true);
});
