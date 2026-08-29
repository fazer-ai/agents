/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components";
import { WebhooksPage } from "@/client/pages/WebhooksPage";

// THE LIST HAS THREE STATES NOW, AND IT USED TO DECIDE BETWEEN TWO.
//
// `hasSecret` says a signing secret is CONFIGURED; `secretRef` says which credential it is. They came
// apart the moment the read started refusing to hand out a `secret_ref` that names no vault entry —
// the column took any string until #126, so such rows exist and their value must not be published.
// Deciding on the ref alone then labels a subscription that signs every delivery "Unsigned", which is
// worse than saying nothing: it is the console asserting the opposite of what the worker does.
//
// NOTE: every assertion reduces to a boolean or a string BEFORE expect. A failing expectation that
// holds a DOM node serializes a cyclic happy-dom tree and stalls the runner.

function subscription(over: Record<string, unknown> = {}) {
  return {
    id: "5",
    // Distinct from every other fixture in the suite. `screen` is document-wide and `bun test` runs
    // many files in one worker, so a URL shared with `WebhookSubscriptionModal.test.tsx` let this
    // file's first wait resolve against THAT file's DOM — green locally, red in CI, and pointing at
    // the assertion after the wait rather than at the wait. The queries below are scoped to this
    // render's own container for the same reason; the shared name is the belt.
    url: "https://ops.example.com/page-label",
    secretRef: "vault:7",
    hasSecret: true,
    events: ["conversation.created"],
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

describe("the webhooks list's signing label", () => {
  const realFetch = globalThis.fetch;
  let subs: ReturnType<typeof subscription>[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : String((input as Request).url ?? input);
    const body = url.includes("/webhooks/subscriptions")
      ? { subscriptions: subs }
      : url.includes("/webhooks/events")
        ? { events: ["conversation.created"] }
        : url.includes("/api/v1/vault")
          ? { entries: [] }
          : { channels: [], deliveries: [], items: [] };
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;

  afterEach(cleanup);
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  let root: HTMLElement;

  const show = async () => {
    const { container } = render(
      // The event badges are tooltips, so the provider is part of the page's real mount.
      <MemoryRouter>
        <TooltipPrimitive.Provider>
          <ToastProvider>
            <WebhooksPage />
          </ToastProvider>
        </TooltipPrimitive.Provider>
      </MemoryRouter>,
    );
    root = container;
    await waitFor(() =>
      expect(
        within(container).queryAllByText("https://ops.example.com/page-label")
          .length > 0,
      ).toBe(true),
    );
  };

  const says = (re: RegExp) => within(root).queryAllByText(re).length > 0;

  test("names the credential when there is one to name", async () => {
    subs = [subscription()];
    await show();
    expect(says(/vault:7/)).toBe(true);
  });

  test("says plain unsigned only when nothing is configured", async () => {
    subs = [subscription({ secretRef: null, hasSecret: false })];
    await show();
    expect(says(/Unsigned|Sem assinatura/)).toBe(true);
    expect(
      says(/credential is not in the vault|credencial não está no cofre/),
    ).toBe(false);
  });

  test("says a hidden ref is SET without claiming the deliveries are signed", async () => {
    // Both halves, and the second is why the word "Signed" cannot lead this sentence: such a ref
    // resolves to no row, so the worker builds headers with a null secret and the delivery goes out
    // unsigned. Saying "Signed" would be the console asserting the opposite of what leaves the
    // installation — the same error as the "Unsigned" it replaced, pointing the other way.
    subs = [subscription({ secretRef: null, hasSecret: true })];
    await show();
    expect(
      says(/credential is not in the vault|credencial não está no cofre/),
    ).toBe(true);
    expect(says(/deliveries go unsigned|entregas saem sem assinatura/)).toBe(
      true,
    );
    // …and it is not the plain "Unsigned" of a subscription that has nothing configured.
    expect(says(/^(Unsigned|Sem assinatura)$/)).toBe(false);
  });
});
