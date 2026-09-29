/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components";
import { WebhooksPage } from "@/client/pages/WebhooksPage";

// THE LIST HAS FOUR STATES, AND THE SERVER DECIDES THEM. `hasSecret` + `secretRef` answer three;
// the fourth, a well-formed ref whose vault entry was DELETED or never filled, resolves to nothing
// in the worker and the row cannot see it. So the label reads `signingState` from the server rather
// than deriving it, or a dead ref reads "Signed with: vault:11" beside a delivery that went out
// unsigned.
//
// Every assertion reduces to a boolean or a string BEFORE expect: a failing expectation that holds
// a DOM node serializes a cyclic happy-dom tree and stalls the runner.

function subscription(over: Record<string, unknown> = {}) {
  return {
    id: "5",
    // NOTE: distinct from every other fixture in the suite. `screen` is document-wide and `bun
    // test` runs many files in one worker, so a URL shared with another file lets this file's first
    // wait resolve against THAT file's DOM. The queries below are scoped to this render's own
    // container for the same reason; the distinct name is the belt.
    url: "https://ops.example.com/page-label",
    secretRef: "vault:7",
    hasSecret: true,
    signingState: "signed",
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
    subs = [
      subscription({
        secretRef: null,
        hasSecret: false,
        signingState: "none",
      }),
    ];
    await show();
    expect(says(/Unsigned|Sem assinatura/)).toBe(true);
    expect(
      says(/credential is not in the vault|credencial não está no cofre/),
    ).toBe(false);
  });

  test("says a hidden ref is SET without claiming the deliveries are signed", async () => {
    // NOTE: both halves, and the second is why "Signed" cannot lead this sentence: such a ref
    // resolves to no row, so the worker builds headers with a null secret and the delivery goes out
    // unsigned.
    subs = [
      subscription({
        secretRef: null,
        hasSecret: true,
        signingState: "unreadable",
      }),
    ];
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

  // NOTE: the two the row can never answer. Each gets its own sentence because they are different
  // errands: recreate a credential that is gone, or fill in one that is empty. Neither names the
  // ref: there is nothing at that name to go look at, and naming it reads as reassurance.
  test("a deleted credential is not still labelled Signed with its ref", async () => {
    subs = [subscription({ signingState: "missing" })];
    await show();
    expect(says(/was deleted|foi apagada/)).toBe(true);
    expect(says(/deliveries go unsigned|entregas saem sem assinatura/)).toBe(
      true,
    );
    expect(says(/vault:7/)).toBe(false);
  });

  test("and a credential with no value yet says that instead", async () => {
    subs = [subscription({ signingState: "pending" })];
    await show();
    expect(says(/no value yet|ainda não tem valor/)).toBe(true);
    expect(says(/was deleted|foi apagada/)).toBe(false);
    expect(says(/vault:7/)).toBe(false);
  });
});
