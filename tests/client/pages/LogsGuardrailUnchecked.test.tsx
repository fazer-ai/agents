/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components";
import en from "@/client/locales/en.json";
import ptBR from "@/client/locales/pt-BR.json";
import { LogsPage } from "@/client/pages/LogsPage";
import { createTestI18n, withI18n } from "@/tests/utils/i18n";

// A guardrail line that could not judge says on the Logs page, in words and without expanding it,
// that the message went on unchecked, in which direction and under which classifier. Every assertion
// reduces to a string or a boolean before expect.
const realFetch = globalThis.fetch;
let items: unknown[] = [];

function guardrailLine(id: string, detail: Record<string, unknown>): unknown {
  return {
    id,
    turnId: `t-${id}`,
    conversationId: "12",
    agentId: null,
    inboxId: null,
    threadId: null,
    stage: "guardrail",
    level: "warn",
    status: "error",
    provider: null,
    model: null,
    durationMs: null,
    source: "inbox",
    detail,
    errorMessage: "provider error",
    createdAt: "2026-10-10T12:00:00.000Z",
  };
}

const stubFetch = (async (input: unknown) => {
  const url = String(
    typeof input === "string" ? input : ((input as Request).url ?? input),
  );
  if (url.includes("/logs"))
    return new Response(JSON.stringify({ items, nextCursor: null }), {
      headers: { "content-type": "application/json" },
    });
  return new Response("{}", { status: 500 });
}) as unknown as typeof globalThis.fetch;

async function pageText(rows: unknown[], lng = "en"): Promise<string> {
  items = rows;
  const i18n = createTestI18n(lng, {
    en: { translation: en },
    "pt-BR": { translation: ptBR },
  });
  const { container } = render(
    withI18n(
      <MemoryRouter initialEntries={["/logs"]}>
        <TooltipPrimitive.Provider>
          <ToastProvider>
            <LogsPage />
          </ToastProvider>
        </TooltipPrimitive.Provider>
      </MemoryRouter>,
      i18n,
    ),
  );
  await waitFor(() => {
    if (!container.querySelector("button[aria-expanded]"))
      throw new Error("no group yet");
  });
  // Opens the turn groups only: the rows themselves stay collapsed, which is the point.
  for (const b of [
    ...container.querySelectorAll("button[aria-expanded='false']"),
  ])
    if (!b.closest(".px-3.py-2")) fireEvent.click(b);
  await waitFor(() => {
    if (!container.textContent?.includes(lng === "en" ? "Guardrail" : "guard"))
      throw new Error("rows not open yet");
  });
  return container.textContent ?? "";
}

describe("a guardrail line that could not judge, on the Logs page", () => {
  beforeAll(() => {
    globalThis.fetch = stubFetch;
  });
  afterEach(() => cleanup());
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test("says the customer's message was let through unchecked, and which classifier failed", async () => {
    const text = await pageText([
      guardrailLine("a", {
        direction: "input",
        outcome: "analysis_failed",
        classifier: "chat",
        unchecked: true,
      }),
    ]);
    expect(
      text.includes(
        "The check failed, so the customer's message was let through unchecked · language model",
      ),
    ).toBe(true);
  });

  // The bug it catches: a held line read as one that let the message through.
  test("says the reply was held and handed to the team under onFailure hold", async () => {
    const text = await pageText([
      guardrailLine("h", {
        direction: "output",
        outcome: "analysis_failed",
        classifier: "chat",
        unchecked: false,
        held: true,
      }),
    ]);
    expect(
      text.includes(
        "The check failed, so the reply was held and a hand-over to the team was requested · language model",
      ),
    ).toBe(true);
    expect(text.includes("let through")).toBe(false);
  });

  test("says the reply was let through unchecked under a classification API", async () => {
    const text = await pageText([
      guardrailLine("b", {
        direction: "output",
        outcome: "credential_not_found",
        classifier: "decisions",
        unchecked: true,
      }),
    ]);
    expect(
      text.includes(
        "The check failed, so the reply was let through unchecked · classification API",
      ),
    ).toBe(true);
  });

  test("an older line whose screening never ran still reads as unchecked", async () => {
    const text = await pageText([
      guardrailLine("c", {
        direction: "input",
        outcome: "credential_not_found",
      }),
    ]);
    expect(
      text.includes(
        "The check failed, so the customer's message was let through unchecked",
      ),
    ).toBe(true);
    expect(text.includes(" · language model")).toBe(false);
  });

  test("an older failed analysis does not claim the message went through", async () => {
    const text = await pageText([
      guardrailLine("g", { direction: "output", outcome: "analysis_failed" }),
    ]);
    expect(
      text.includes(
        "The check failed; this older line does not record whether the message was let through",
      ),
    ).toBe(true);
    expect(text.includes("reply was let through unchecked")).toBe(false);
  });

  test("in Portuguese", async () => {
    const text = await pageText(
      [
        guardrailLine("d", {
          direction: "output",
          outcome: "analysis_failed",
          classifier: "chat",
          unchecked: true,
        }),
      ],
      "pt-BR",
    );
    expect(
      text.includes(
        "A checagem falhou, e a resposta foi liberada sem checagem · modelo de linguagem",
      ),
    ).toBe(true);
    expect(text.includes("logs.guardrailUnchecked")).toBe(false);
  });

  test("a screening that failed in part and still tripped is not described as unchecked", async () => {
    const text = await pageText([
      guardrailLine("f", {
        direction: "output",
        outcome: "analysis_failed",
        classifier: "decisions",
        unchecked: false,
      }),
    ]);
    expect(text.includes("The check failed")).toBe(false);
  });

  test("a guardrail that tripped is not described as unchecked", async () => {
    const text = await pageText([
      guardrailLine("e", {
        direction: "input",
        action: "template",
        categories: ["toxicity"],
      }),
    ]);
    expect(text.includes("unchecked")).toBe(false);
  });
});
