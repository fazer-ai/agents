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

// `secretRef` is three-valued on the wire (absent leaves it, null clears it, a value sets it), and
// an untouched save of a signed channel must leave it signed. All three states are driven here, the
// clear through the picker's own menu, because "leave it" and "clear it" differ by one comparison
// in the component and a test that only asserts omission is satisfied by a form that can no longer
// clear.
//
// Every assertion reduces to a boolean or a string BEFORE expect: a failing expectation that holds
// a DOM node serializes a cyclic happy-dom tree and stalls the runner.

const VAULT_ENTRY = {
  id: "7",
  name: "ops-hmac",
  kind: "generic",
  baseUrl: null,
  paramName: null,
  status: "active",
};

// The tenant's agents, for the exclusion chips.
const ROSTER = [
  { id: "11", name: "Battery agent" },
  { id: "12", name: "Production agent" },
];

function channel(over: Record<string, unknown> = {}) {
  return {
    id: "3",
    name: "Ops webhook",
    type: "webhook",
    urlMasked: "https://ops.example.com/…",
    enabled: true,
    minLevel: "error",
    stages: [],
    excludeAgentIds: [] as string[],
    hasSecret: true,
    secretRef: "vault:7",
    signingState: "signed",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

describe("AlertChannelsSection", () => {
  // Stubbing `globalThis.fetch` rather than the api module: `mock.module` is global to the
  // process and leaks into whatever else shares the worker. The stub is process-global too, so
  // every call is recorded WITH its url and the assertions look up the one the form is responsible
  // for: a stray request from elsewhere lands in `calls` where it can be named instead of
  // overwriting the answer.
  const realFetch = globalThis.fetch;
  const calls: { method: string; url: string; body: unknown }[] = [];
  let channels: ReturnType<typeof channel>[] = [];
  let testResult: Record<string, unknown> = {
    ok: true,
    status: 204,
    error: null,
    signed: true,
    enabled: true,
    durationMs: 12,
    warning: null,
  };

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
    if (url.includes("/api/v1/agents"))
      return json({
        agents: ROSTER,
        total: ROSTER.length,
        page: 1,
        pageSize: 100,
      });
    if (url.includes("/api/v1/alert-channels")) {
      if (method === "GET") return json({ channels });
      if (url.endsWith("/test")) return json({ result: testResult });
      return json({ channel: channels[0] });
    }
    return json({});
  }) as unknown as typeof globalThis.fetch;

  beforeEach(() => {
    invalidateVault();
    channels = [channel()];
    testResult = {
      ok: true,
      status: 204,
      error: null,
      signed: true,
      enabled: true,
      durationMs: 12,
      warning: null,
    };
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
    // NOTE: `hidden: true` because an open Radix menu takes the rest of the dialog out of the
    // accessibility tree, and two of these tests press Save with the credential menu still on
    // screen, which is what an operator does.
    screen
      .getByRole("button", { name: /^(Save|Salvar)$/, hidden: true })
      .click();
    await waitFor(() => expect(patches().length).toBe(1));
    return patches()[0]?.body as Record<string, unknown>;
  };

  // ── what the LIST says the channel does ──
  //
  // NOTE: a delivery carries an HMAC only when three things line up: type `webhook`, a secret
  // configured, and a ref that names a vault entry. The other cases are reachable: a channel
  // switched to Discord keeps its ref (the editor omits an untouched picker), and a legacy ref may
  // name nothing.
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

  // NOTE: the server computes `signingState` (one of its four cases needs the vault, so the client
  // cannot rebuild it from the row). What is checked here is that every state renders as its own
  // sentence: a state the switch does not know falls through to the empty string, which is silence.
  test("only a resolvable ref on a webhook is called Signed", async () => {
    const text = await listShows({});
    expect(text.includes("Signed")).toBe(true);
    expect(text.includes("unsigned")).toBe(false);
    expect(text.includes("ignored on this channel type")).toBe(false);
  });

  test("a Discord channel holding a stranded ref is not called Signed", async () => {
    const text = await listShows({ type: "discord", signingState: "ignored" });
    expect(text.includes("ignored on this channel type")).toBe(true);
    expect(/·\s*Signed\b/.test(text)).toBe(false);
  });

  test("a stored value that names no credential is not called Signed", async () => {
    const text = await listShows({
      secretRef: null,
      hasSecret: true,
      signingState: "unreadable",
    });
    expect(text.includes("not in the vault")).toBe(true);
    expect(text.includes("deliveries go unsigned")).toBe(true);
    expect(/·\s*Signed\b/.test(text)).toBe(false);
  });

  // NOTE: separate lines because they are separate errands: recreate a credential that is gone, or
  // fill in one that is empty.
  test("a deleted credential says so, and says it was deleted", async () => {
    const text = await listShows({ signingState: "missing" });
    expect(text.includes("was deleted")).toBe(true);
    expect(text.includes("deliveries go unsigned")).toBe(true);
    expect(/·\s*Signed\b/.test(text)).toBe(false);
  });

  test("a credential with no value yet says that instead", async () => {
    const text = await listShows({ signingState: "pending" });
    expect(text.includes("no value yet")).toBe(true);
    expect(text.includes("was deleted")).toBe(false);
    expect(/·\s*Signed\b/.test(text)).toBe(false);
  });

  test("and a channel with no secret says nothing about signing", async () => {
    const text = await listShows({
      secretRef: null,
      hasSecret: false,
      signingState: "none",
    });
    expect(text.includes("Signed")).toBe(false);
    expect(text.includes("unsigned")).toBe(false);
  });

  test("a save that changed nothing does not mention the secret at all", async () => {
    await openEditor();
    const body = await save();
    // NOTE: `null` is the service's spelling of "clear it"; omitted is "leave it", and it is the
    // one that does not depend on the stored value being re-writable.
    expect(Object.hasOwn(body ?? {}, "secretRef")).toBe(false);
    // NOTE: the rest of the form is still sent, so this is an omission and not a save that gave up.
    expect(String(body?.name)).toBe("Ops webhook");
  });

  test("an unshowable secret can still be taken away on purpose", async () => {
    // NOTE: the interaction is tracked, not the VALUE. This channel arrives as `hasSecret` with no
    // ref to show, so the picker opens empty and choosing "None" moves nothing: a value comparison
    // calls that unchanged and the operator could never clear the secret.
    channels = [channel({ hasSecret: true, secretRef: null })];
    await openEditor();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: /Signing secret/ }),
      {
        button: 0,
        pointerType: "mouse",
      },
    );
    // NOTE: inside the MENU, never `screen`: the trigger renders "None" as its own label when
    // nothing is selected, so a bare text query clicks the button that opened the menu and the
    // picker never hears an onChange.
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
    // NOTE: and it says what that COSTS, the half an operator acts on: such a ref resolves to no
    // row, so the worker signs nothing. "Cannot be shown" alone reads like a display quirk.
    expect(
      screen.queryAllByText(
        /deliveries go unsigned|entregas saem sem assinatura/,
      ).length > 0,
    ).toBe(true);
  });

  test("clearing the picker still unsigns the channel", async () => {
    await openEditor();
    await waitFor(() =>
      expect(screen.queryAllByText("ops-hmac").length > 0).toBe(true),
    );
    // NOTE: Radix opens on pointerdown, not click, and the FormField group carries the same
    // accessible name, so this asks for the BUTTON.
    fireEvent.pointerDown(
      screen.getByRole("button", { name: /Signing secret/ }),
      {
        button: 0,
        pointerType: "mouse",
      },
    );
    // NOTE: inside the MENU, never `screen` (see the test above).
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
    // NOTE: the picker is drawn only for a webhook, so a save that switches the type leaves it
    // untouched and omits the key. The credential survives the round trip back to `webhook`, where
    // the worker signs again (`secretRef && type === "webhook"`); sending the blanked picker
    // instead would silently erase it.
    await openEditor();
    const select = screen.getByLabelText(/^(Type|Tipo)$/) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "discord" } });

    const body = await save();
    expect(String(body?.type)).toBe("discord");
    expect(Object.hasOwn(body ?? {}, "secretRef")).toBe(false);
  });

  // ── the Test button ──
  //
  // NOTE: the three tests here are not "the button posts"; they are the three answers a bare
  // "delivered" would let the operator read wrongly.

  const pressTest = async (over: Record<string, unknown> = {}) => {
    testResult = { ...testResult, ...over };
    render(
      <ToastProvider>
        <AlertChannelsSection />
      </ToastProvider>,
    );
    await waitFor(() =>
      expect(screen.queryAllByText("Ops webhook").length > 0).toBe(true),
    );
    screen.getByRole("button", { name: /^(Test|Testar)$/ }).click();
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "POST" && c.url.endsWith("/alert-channels/3/test"),
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect((document.body.textContent ?? "").includes("204")).toBe(true),
    );
    return (document.body.textContent ?? "").toString();
  };

  test("a delivered sample says so, with the status the destination gave", async () => {
    const text = await pressTest();
    expect(/delivered|entregue/i.test(text)).toBe(true);
  });

  test("a delivered sample on a DISABLED channel does not read as watching", async () => {
    // The operator tests before enabling, which is the normal order; a green toast alone
    // would leave them believing production is watched by a channel that is off.
    const text = await pressTest({ enabled: false });
    expect(/still disabled|continua desabilitado/i.test(text)).toBe(true);
  });

  test("a delivered sample that went out UNSIGNED says that instead of success", async () => {
    // The destination took it, so the channel is reachable, and a receiver that verifies
    // signatures will still drop every real alert.
    const text = await pressTest({
      signed: false,
      warning: "the configured signing secret did not resolve",
    });
    expect(/UNSIGNED|SEM ASSINATURA/i.test(text)).toBe(true);
  });

  test("a refusal from the destination carries its reason, not just a failure", async () => {
    render(
      <ToastProvider>
        <AlertChannelsSection />
      </ToastProvider>,
    );
    await waitFor(() =>
      expect(screen.queryAllByText("Ops webhook").length > 0).toBe(true),
    );
    testResult = {
      ok: false,
      status: 404,
      error: "non-2xx response: 404",
      signed: false,
      enabled: true,
      durationMs: 8,
      warning: null,
    };
    screen.getByRole("button", { name: /^(Test|Testar)$/ }).click();
    // NOTE: without the WHY the operator learns the channel is broken and still cannot tell a
    // deleted Discord webhook from a blocked host.
    await waitFor(() =>
      expect(
        (document.body.textContent ?? "").includes("non-2xx response: 404"),
      ).toBe(true),
    );
  });

  test("two channels tested at once do not clear each other's spinner", async () => {
    // NOTE: the in-flight state is per channel. A single `testingId` for the whole list would
    // re-enable A while B is tested, and the first response to land would clear the other's spinner
    // while it still runs; both cost a real external send.
    channels = [channel(), channel({ id: "4", name: "Second webhook" })];
    const release: Array<() => void> = [];
    const realFetch2 = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url =
        typeof input === "string"
          ? input
          : String((input as Request).url ?? input);
      if (url.endsWith("/test")) {
        // NOTE: held open on purpose: the case only exists while two are in flight together.
        return await new Promise<Response>((resolve) => {
          release.push(() =>
            resolve(
              new Response(JSON.stringify({ result: testResult }), {
                headers: { "content-type": "application/json" },
              }),
            ),
          );
        });
      }
      return await (realFetch2 as typeof globalThis.fetch)(input, init);
    }) as unknown as typeof globalThis.fetch;

    try {
      render(
        <ToastProvider>
          <AlertChannelsSection />
        </ToastProvider>,
      );
      await waitFor(() =>
        expect(screen.queryAllByText("Second webhook").length > 0).toBe(true),
      );
      const buttons = () =>
        screen.getAllByRole("button", { name: /^(Test|Testar)$/ });
      expect(buttons().length).toBe(2);

      buttons()[0]?.click();
      await waitFor(() => expect(release.length).toBe(1));
      // NOTE: B is still pressable, and A must NOT be.
      expect((buttons()[0] as HTMLButtonElement).disabled).toBe(true);
      expect((buttons()[1] as HTMLButtonElement).disabled).toBe(false);

      buttons()[1]?.click();
      await waitFor(() => expect(release.length).toBe(2));
      expect((buttons()[0] as HTMLButtonElement).disabled).toBe(true);

      // NOTE: A answers, B has not, and B's spinner stays.
      release[0]?.();
      await waitFor(() =>
        expect((buttons()[0] as HTMLButtonElement).disabled).toBe(false),
      );
      expect((buttons()[1] as HTMLButtonElement).disabled).toBe(true);

      release[1]?.();
      await waitFor(() =>
        expect((buttons()[1] as HTMLButtonElement).disabled).toBe(false),
      );
    } finally {
      globalThis.fetch = realFetch2;
      for (const r of release) r();
    }
  });

  // ── excluded agents ──
  //
  // NOTE: the dialog sends the whole list on every save, so what it opens with is what it keeps: an
  // untouched save must send back exactly the stored ids, including one whose agent is gone (the
  // server accepts a kept id), and a toggle must add or drop exactly one.
  test("an untouched save sends the stored exclusions back, a deleted agent's included", async () => {
    channels = [channel({ excludeAgentIds: ["11", "99"] })];
    await openEditor();
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Battery agent", hidden: true })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    expect(
      screen
        .getByRole("button", { name: "Production agent", hidden: true })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    // NOTE: the id with no agent behind it is on screen, so it can be seen and dropped.
    expect(
      screen.getByRole("button", { name: /#99/, hidden: true }),
    ).toBeTruthy();
    const body = await save();
    expect(body.excludeAgentIds).toEqual(["11", "99"]);
  });

  test("picking an agent excludes it, and dropping the deleted one removes it", async () => {
    channels = [channel({ excludeAgentIds: ["99"] })];
    await openEditor();
    await waitFor(() =>
      expect(
        screen.queryAllByRole("button", {
          name: "Production agent",
          hidden: true,
        }).length,
      ).toBe(1),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Production agent", hidden: true }),
    );
    fireEvent.click(screen.getByRole("button", { name: /#99/, hidden: true }));
    const body = await save();
    expect(body.excludeAgentIds).toEqual(["12"]);
  });

  test("the list says how many agents a channel leaves out", async () => {
    const text = await listShows({ excludeAgentIds: ["11", "12"] });
    expect(text).toMatch(/2 (agents excluded|agentes excluídos)/);
  });
});
