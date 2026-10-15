/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components";
import en from "@/client/locales/en.json";
import ptBR from "@/client/locales/pt-BR.json";
import { WebhooksPage } from "@/client/pages/WebhooksPage";
import { createTestI18n, withI18n } from "@/tests/utils/i18n";

// The subscriptions list summarizes what each subscription receives per family ("Conversations
// (all)", "Documents 2 of 3") instead of one badge per event. Every assertion reduces to a string or a
// boolean before expect.

const URL_MARK = "https://ops.example.com/event-summary";

const FAMILIES = [
  {
    family: "conversation",
    wildcard: "conversation.*",
    events: [
      "conversation.created",
      "conversation.status_changed",
      "conversation.handoff",
    ],
  },
  {
    family: "document",
    wildcard: "document.*",
    events: [
      "document.approval_requested",
      "document.approval_decided",
      "document.approval_outcome",
    ],
  },
  { family: null, wildcard: null, events: ["heartbeat"] },
];

describe("the webhooks list's event summary", () => {
  const realFetch = globalThis.fetch;
  let events: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : String((input as Request).url ?? input);
    const body = url.includes("/webhooks/subscriptions")
      ? {
          subscriptions: [
            {
              id: "8",
              url: URL_MARK,
              secretRef: null,
              hasSecret: false,
              signingState: "none",
              events,
              enabled: true,
              createdAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-01T00:00:00.000Z",
            },
          ],
        }
      : url.includes("/webhooks/events")
        ? {
            events: FAMILIES.flatMap((f) => f.events),
            families: FAMILIES,
          }
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

  const show = async (lng = "en") => {
    const i18n = createTestI18n(lng, {
      en: { translation: en },
      "pt-BR": { translation: ptBR },
    });
    const { container } = render(
      withI18n(
        <MemoryRouter>
          <TooltipPrimitive.Provider>
            <ToastProvider>
              <WebhooksPage />
            </ToastProvider>
          </TooltipPrimitive.Provider>
        </MemoryRouter>,
        i18n,
      ),
    );
    await waitFor(() =>
      expect(within(container).queryAllByText(URL_MARK).length > 0).toBe(true),
    );
    // The badges render once the catalog is in, and each case names at least one family.
    await waitFor(() =>
      expect(
        [
          "Conversation",
          "Document",
          "System",
          "Conversas",
          "Documentos",
          "Sistema",
        ].some((w) => container.textContent?.includes(w)),
      ).toBe(true),
    );
    return container.textContent ?? "";
  };

  test("one badge per family, all or N of M, and no raw event badge", async () => {
    events = [
      "conversation.*",
      "document.approval_requested",
      "document.approval_decided",
    ];
    const text = await show();
    expect(text.includes("Conversations (all)")).toBe(true);
    expect(text.includes("Documents 2 of 3")).toBe(true);
    expect(text.includes("Conversation created")).toBe(false);
  });

  test("a family with no wildcard reads by its name when it is all there", async () => {
    events = ["heartbeat"];
    const text = await show();
    expect(text.includes("System")).toBe(true);
    expect(text.includes("1 of 1")).toBe(false);
  });

  test("in Portuguese", async () => {
    events = ["conversation.*", "document.approval_decided"];
    const text = await show("pt-BR");
    expect(text.includes("Conversas (todos)")).toBe(true);
    expect(text.includes("Documentos 1 de 3")).toBe(true);
    expect(text.includes("webhooks.")).toBe(false);
  });
});
