/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { AlertChannelsSection } from "@/client/components/alerts/AlertChannelsSection";
import { ToastProvider } from "@/client/components/Toast";
import { invalidateVault } from "@/client/lib/vaultCache";

// `secretRef` is three-valued on the wire — absent leaves it, null clears it, a value sets it — and
// the edit modal used to be able to spell only two of those: it sent the key on EVERY save, holding
// whatever the picker had, and the picker was blanked on open. So opening a signed channel and
// pressing Save was not a no-op, it unsigned the channel, and nothing on screen said so (#435).
//
// All three states are driven here, the clear through the picker's own menu rather than around it,
// because "leave it" and "clear it" differ by one comparison in the component and a test that only
// ever asserts omission is satisfied by a form that can no longer clear anything.
//
// NOTE: every assertion reduces to a boolean or a string BEFORE expect. A failing expectation that
// holds a DOM node serializes a cyclic happy-dom tree and stalls the runner.

const VAULT_ENTRY = {
  id: "7",
  name: "ops-hmac",
  kind: "generic",
  baseUrl: null,
  paramName: null,
  status: "active",
};

function channel(over: Record<string, unknown> = {}) {
  return {
    id: "3",
    name: "Ops webhook",
    type: "webhook",
    urlMasked: "https://ops.example.com/…",
    enabled: true,
    minLevel: "error",
    stages: [],
    hasSecret: true,
    secretRef: "vault:7",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

describe("AlertChannelsSection", () => {
  // Stubbing `globalThis.fetch` rather than the api module: `mock.module` is global to the process
  // and leaks into whatever else shares the worker. The stub is process-global too, in a different
  // way, so every call is recorded WITH its url and the assertions look up the one the form is
  // responsible for — a stray request from elsewhere lands in `calls` where it can be named instead
  // of overwriting the answer (the lesson `BusinessHoursForm.test.tsx` carries).
  const realFetch = globalThis.fetch;
  const calls: { method: string; url: string; body: unknown }[] = [];
  let channels: ReturnType<typeof channel>[] = [];

  const patches = () =>
    calls.filter(
      (c) => c.method === "PATCH" && c.url.includes("/alert-channels/"),
    );

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : String((input as Request).url ?? input);
    const method = String(init?.method ?? "GET");
    calls.push({
      method,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.includes("/api/v1/vault")) return json({ entries: [VAULT_ENTRY] });
    if (url.includes("/api/v1/alert-channels")) {
      if (method === "GET") return json({ channels });
      return json({ channel: channels[0] });
    }
    return json({});
  }) as unknown as typeof globalThis.fetch;

  beforeEach(() => {
    invalidateVault();
    channels = [channel()];
  });
  afterEach(() => {
    cleanup();
    calls.length = 0;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  const openEditor = async () => {
    render(
      <ToastProvider>
        <AlertChannelsSection />
      </ToastProvider>,
    );
    await waitFor(() =>
      expect(screen.queryAllByText("Ops webhook").length > 0).toBe(true),
    );
    screen.getByRole("button", { name: /^(Edit|Editar)$/ }).click();
    await waitFor(() =>
      expect(
        screen.queryAllByRole("button", { name: /^(Save|Salvar)$/ }).length,
      ).toBe(1),
    );
  };

  const save = async () => {
    // `hidden: true` because an open Radix menu takes the rest of the dialog out of the accessibility
    // tree, and two of these tests press Save with the credential menu still on screen — which is what
    // an operator does.
    screen
      .getByRole("button", { name: /^(Save|Salvar)$/, hidden: true })
      .click();
    await waitFor(() => expect(patches().length).toBe(1));
    return patches()[0]?.body as Record<string, unknown>;
  };

  // ── what the LIST says the channel does ──
  //
  // Three things have to line up for a delivery to carry an HMAC: type `webhook`, a secret
  // configured, and a ref that names a vault entry. The badge reported only the middle one, and both
  // other cases are reachable — a channel switched to Discord keeps its ref because the editor omits
  // an untouched picker, and a ref stored before #126 may name nothing. Both read as "Signed" while
  // the worker sent no signature.
  const listShows = async (over: Record<string, unknown>) => {
    channels = [channel(over)];
    render(
      <ToastProvider>
        <AlertChannelsSection />
      </ToastProvider>,
    );
    await waitFor(() =>
      expect(screen.queryAllByText("Ops webhook").length > 0).toBe(true),
    );
    return (document.body.textContent ?? "").toString();
  };

  test("a webhook with a resolvable ref is the only thing called Signed", async () => {
    const text = await listShows({});
    expect(text.includes("Signed")).toBe(true);
    expect(text.includes("not in the vault")).toBe(false);
    expect(text.includes("ignored on this channel type")).toBe(false);
  });

  test("a Discord channel holding a stranded ref is not called Signed", async () => {
    const text = await listShows({ type: "discord" });
    expect(text.includes("ignored on this channel type")).toBe(true);
    expect(/·\s*Signed\b/.test(text)).toBe(false);
  });

  test("a configured secret that names no credential is not called Signed", async () => {
    const text = await listShows({ secretRef: null, hasSecret: true });
    expect(text.includes("deliveries go unsigned")).toBe(true);
    expect(/·\s*Signed\b/.test(text)).toBe(false);
  });

  test("and a channel with no secret says nothing about signing", async () => {
    const text = await listShows({ secretRef: null, hasSecret: false });
    expect(text.includes("Signed")).toBe(false);
    expect(text.includes("unsigned")).toBe(false);
  });

  test("a save that changed nothing does not mention the secret at all", async () => {
    await openEditor();
    const body = await save();
    // The whole defect in one line: the key was always present, and `null` is the service's spelling
    // of "clear it". Omitted is the spelling of "leave it", and it is the one that does not depend on
    // the stored value being re-writable.
    expect(Object.hasOwn(body ?? {}, "secretRef")).toBe(false);
    // …and the rest of the form is still sent, so this is an omission and not a save that gave up.
    expect(String(body?.name)).toBe("Ops webhook");
  });

  test("an unshowable secret can still be taken away on purpose", async () => {
    // The trap in comparing VALUES instead of tracking the interaction. This channel arrives as
    // `hasSecret` with no ref to show, so the picker opens empty and choosing "None" moves nothing —
    // a value comparison calls that unchanged and the operator can never clear a secret the list is
    // calling Signed.
    channels = [channel({ hasSecret: true, secretRef: null })];
    await openEditor();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: /Signing secret/ }),
      {
        button: 0,
        pointerType: "mouse",
      },
    );
    // Inside the MENU, never `screen`: the trigger renders "None" as its own label when nothing is
    // selected, so a bare text query clicks the button that opened the menu and the picker never
    // hears an onChange — which reads exactly like the fix not working.
    await waitFor(() =>
      expect(screen.queryAllByRole("menu", { hidden: true }).length).toBe(1),
    );
    fireEvent.click(
      within(screen.getByRole("menu", { hidden: true })).getByText(
        /^(None|Nenhuma)$/,
      ),
    );

    const body = await save();
    expect(Object.hasOwn(body ?? {}, "secretRef")).toBe(true);
    expect(JSON.stringify(body?.secretRef)).toBe(JSON.stringify(null));
  });

  test("and the modal says so instead of reading as None", async () => {
    channels = [channel({ hasSecret: true, secretRef: null })];
    await openEditor();
    expect(
      screen.queryAllByText(
        /does not point at a credential|não aponta para uma credencial/,
      ).length > 0,
    ).toBe(true);
    // …and it says what that COSTS, which is the half an operator acts on: such a ref resolves to no
    // row, so the worker signs nothing. A sentence that only says "cannot be shown" reads like a
    // display quirk.
    expect(
      screen.queryAllByText(
        /deliveries go unsigned|entregas saem sem assinatura/,
      ).length > 0,
    ).toBe(true);
  });

  test("a configured secret the read cannot show is still not cleared", async () => {
    // `alert_channels.secret_ref` took any string up to 128 chars until #126 guarded both writers, so
    // a row can hold text that names no vault entry. The read refuses to hand that out — it would
    // publish whatever was typed there — so this pair reaches the modal: `hasSecret` true with no ref
    // to show. Echoing the blank picker back is exactly the erasure this PR is about, and the
    // omission is what makes the unshowable case safe rather than merely invisible.
    channels = [channel({ hasSecret: true, secretRef: null })];
    await openEditor();
    const body = await save();
    expect(Object.hasOwn(body ?? {}, "secretRef")).toBe(false);
  });

  test("clearing the picker still unsigns the channel", async () => {
    await openEditor();
    await waitFor(() =>
      expect(screen.queryAllByText("ops-hmac").length > 0).toBe(true),
    );
    // Radix opens on pointerdown, not click.
    // The FormField group carries the same accessible name, so this asks for the BUTTON.
    fireEvent.pointerDown(
      screen.getByRole("button", { name: /Signing secret/ }),
      {
        button: 0,
        pointerType: "mouse",
      },
    );
    // Inside the MENU, never `screen`: the trigger renders "None" as its own label when nothing is
    // selected, so a bare text query clicks the button that opened the menu and the picker never
    // hears an onChange — which reads exactly like the fix not working.
    await waitFor(() =>
      expect(screen.queryAllByRole("menu", { hidden: true }).length).toBe(1),
    );
    fireEvent.click(
      within(screen.getByRole("menu", { hidden: true })).getByText(
        /^(None|Nenhuma)$/,
      ),
    );

    const body = await save();
    expect(Object.hasOwn(body ?? {}, "secretRef")).toBe(true);
    expect(JSON.stringify(body?.secretRef)).toBe(JSON.stringify(null));
  });

  test("switching the channel to Discord strands the ref instead of clearing it", async () => {
    // The picker is drawn only for a webhook, so a save that switches the type has no picker on
    // screen to have been touched. The stored ref is therefore untouched, the key is omitted, and the
    // credential survives the round trip back to `webhook` — where the worker signs again, since it
    // reads `secretRef && type === "webhook"`. The alternative, sending the blanked picker, is the
    // same silent erasure this PR is about, reached through a different door.
    await openEditor();
    const select = screen.getByLabelText(/^(Type|Tipo)$/) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "discord" } });

    const body = await save();
    expect(String(body?.type)).toBe("discord");
    expect(Object.hasOwn(body ?? {}, "secretRef")).toBe(false);
  });

  test("the modal says WHICH credential signs, not just that one does", async () => {
    await openEditor();
    // The list badge only ever said "Signed". The picker resolving the ref to its vault entry is
    // what lets the operator see, and keep, the credential they configured.
    await waitFor(() =>
      expect(screen.queryAllByText("ops-hmac").length > 0).toBe(true),
    );
  });

  test("an unsigned channel is left alone too", async () => {
    channels = [channel({ hasSecret: false, secretRef: null })];
    await openEditor();
    const body = await save();
    // The other half of the prefill: an untouched empty picker is still untouched, so it must not
    // send a stale ref from the component's last session either.
    expect(Object.hasOwn(body ?? {}, "secretRef")).toBe(false);
  });
});
