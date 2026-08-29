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
import { useEffect } from "react";
import { useModalController } from "@/client/components/Modal";
import { ToastProvider } from "@/client/components/Toast";
import {
  type WebhookModalPayload,
  WebhookSubscriptionModal,
} from "@/client/components/webhooks/WebhookSubscriptionModal";
import { invalidateVault } from "@/client/lib/vaultCache";

// The sibling of `AlertChannelsSection`, and it inherited the same obligation the moment the read
// started redacting: `readableVaultRef` hides a `secret_ref` that names no vault entry (the column
// took any string until #126), so a subscription can arrive as `hasSecret` with no ref to show. This
// modal sent `secretRef` on every save, so opening one to change its url would have deleted a signing
// secret it could not display — #435 reproduced at the site this PR cites as the norm.
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

function subscription(over: Record<string, unknown> = {}) {
  return {
    id: "5",
    url: "https://ops.example.com/hook",
    secretRef: "vault:7",
    hasSecret: true,
    events: ["conversation.created"],
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

// Opens the modal on mount with the payload under test — the controller is the component's contract,
// so the harness drives it rather than reaching past it.
function Harness({ payload }: { payload: WebhookModalPayload }) {
  const modal = useModalController<WebhookModalPayload>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: open once, on mount
  useEffect(() => {
    modal.open(payload);
  }, []);
  return (
    <ToastProvider>
      <WebhookSubscriptionModal
        modal={modal}
        events={["conversation.created", "conversation.handoff"]}
        onSaved={() => {}}
      />
    </ToastProvider>
  );
}

describe("WebhookSubscriptionModal", () => {
  const realFetch = globalThis.fetch;
  const calls: { method: string; url: string; body: unknown }[] = [];

  const patches = () =>
    calls.filter(
      (c) => c.method === "PATCH" && c.url.includes("/webhooks/subscriptions/"),
    );

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : String((input as Request).url ?? input);
    calls.push({
      method: String(init?.method ?? "GET"),
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const body = url.includes("/api/v1/vault")
      ? { entries: [VAULT_ENTRY] }
      : {};
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;

  beforeEach(() => invalidateVault());
  afterEach(() => {
    cleanup();
    calls.length = 0;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  const open = async (over: Record<string, unknown> = {}) => {
    render(
      <Harness
        payload={
          { subscription: subscription(over) } as unknown as WebhookModalPayload
        }
      />,
    );
    await waitFor(() =>
      expect(
        screen.queryAllByRole("button", {
          name: /^(Save|Salvar)$/,
          hidden: true,
        }).length,
      ).toBe(1),
    );
  };

  const save = async () => {
    // `hidden: true` because an open Radix menu takes the rest of the dialog out of the accessibility
    // tree, and the clearing test presses Save with that menu still on screen.
    screen
      .getByRole("button", { name: /^(Save|Salvar)$/, hidden: true })
      .click();
    await waitFor(() => expect(patches().length).toBe(1));
    return patches()[0]?.body as Record<string, unknown>;
  };

  const chooseNone = async () => {
    fireEvent.pointerDown(
      screen.getByRole("button", { name: /Signing secret/ }),
      { button: 0, pointerType: "mouse" },
    );
    // Inside the MENU, never `screen`: the trigger renders "None" as its own label when nothing is
    // selected, so a bare text query clicks the button that opened the menu.
    await waitFor(() =>
      expect(screen.queryAllByRole("menu", { hidden: true }).length).toBe(1),
    );
    fireEvent.click(
      within(screen.getByRole("menu", { hidden: true })).getByText(
        /^(None|Nenhuma)$/,
      ),
    );
  };

  test("a save that changed nothing does not mention the secret", async () => {
    await open();
    const body = await save();
    expect(Object.hasOwn(body ?? {}, "secretRef")).toBe(false);
    expect(String(body?.url)).toBe("https://ops.example.com/hook");
  });

  test("a secret the read cannot show survives an unrelated save", async () => {
    await open({ hasSecret: true, secretRef: null });
    const body = await save();
    expect(Object.hasOwn(body ?? {}, "secretRef")).toBe(false);
  });

  test("and the modal says so instead of reading as None", async () => {
    await open({ hasSecret: true, secretRef: null });
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

  test("clearing the picker still unsigns the subscription", async () => {
    await open();
    await waitFor(() =>
      expect(screen.queryAllByText("ops-hmac").length > 0).toBe(true),
    );
    await chooseNone();
    const body = await save();
    expect(JSON.stringify(body?.secretRef)).toBe(JSON.stringify(null));
  });

  test("an unshowable secret can still be taken away on purpose", async () => {
    // The trap in comparing VALUES: this picker opens empty, so choosing "None" moves nothing and a
    // value comparison would call it unchanged — leaving no way to clear a secret at all.
    await open({ hasSecret: true, secretRef: null });
    await chooseNone();
    const body = await save();
    expect(Object.hasOwn(body ?? {}, "secretRef")).toBe(true);
    expect(JSON.stringify(body?.secretRef)).toBe(JSON.stringify(null));
  });
});
