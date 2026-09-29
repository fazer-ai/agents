/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components";
import { WebhooksPage } from "@/client/pages/WebhooksPage";

// THE PROBE DOES NOT REFUSE, SO THE TOAST CARRIES THE WARNING. `sendWebhookTest` takes the real
// send's path (a probe on another path condemns what works and approves what does not), so an
// unusable signing credential answers 2xx, and a green "Test delivered" alone would hide what the
// button is pressed for. Its own file: WebhooksPageSigningLabel.test.tsx installs its fetch stub in
// the describe BODY, at collection time, so a second such stub would replace it for both blocks.
//
// Every assertion reduces to a boolean or a string BEFORE expect: a failing expectation holding a
// DOM node serializes a cyclic happy-dom tree and stalls the runner.

const URL_ = "https://ops.example.com/page-toast";

describe("the webhooks test button's toast", () => {
  const realFetch = globalThis.fetch;
  let result: Record<string, unknown> = {};

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : String((input as Request).url ?? input);
    const body =
      init?.method === "POST" && url.includes("/test")
        ? { result }
        : url.includes("/webhooks/subscriptions")
          ? {
              subscriptions: [
                {
                  id: "5",
                  url: URL_,
                  secretRef: "vault:7",
                  hasSecret: true,
                  events: ["conversation.created"],
                  enabled: true,
                  createdAt: "2026-08-01T00:00:00.000Z",
                  updatedAt: "2026-08-01T00:00:00.000Z",
                },
              ],
            }
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

  const press = async () => {
    const { container } = render(
      <MemoryRouter>
        <TooltipPrimitive.Provider>
          <ToastProvider>
            <WebhooksPage />
          </ToastProvider>
        </TooltipPrimitive.Provider>
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(within(container).queryAllByText(URL_).length > 0).toBe(true),
    );
    const button = within(container).getAllByRole("button", {
      name: /Test|Testar/,
    })[0];
    if (button) fireEvent.click(button);
    // The toast portals out of this container, so it is read off the document, and the wait is for
    // the STATUS the probe answered rather than for any of the words under test — waiting for one of
    // those would make each assertion a restatement of its own wait.
    await waitFor(() =>
      expect((document.body.textContent ?? "").includes("(200)")).toBe(true),
    );
    return (document.body.textContent ?? "").toString();
  };

  test("a sample that went out unsigned says so instead of reporting success", async () => {
    result = {
      ok: true,
      status: 200,
      error: null,
      signed: false,
      warning:
        "sent UNSIGNED: the signing credential this points at is no longer in the vault",
    };
    const text = await press();
    expect(/UNSIGNED|SEM ASSINATURA/.test(text)).toBe(true);
  });

  test("and a sample that really was signed still reports plain success", async () => {
    result = {
      ok: true,
      status: 200,
      error: null,
      signed: true,
      warning: null,
    };
    const text = await press();
    expect(/UNSIGNED|SEM ASSINATURA/.test(text)).toBe(false);
    expect(/delivered|Entregue|entregue/.test(text)).toBe(true);
  });
});
