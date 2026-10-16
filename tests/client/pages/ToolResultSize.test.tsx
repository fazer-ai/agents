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
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components";
import { toolResultSizeLabel } from "@/client/lib/flowLabels";
import en from "@/client/locales/en.json";
import ptBR from "@/client/locales/pt-BR.json";
import { TraceRow } from "@/client/pages/agents/PlaygroundChat";
import { LogsPage } from "@/client/pages/LogsPage";
import { createTestI18n, withI18n } from "@/tests/utils/i18n";

// Each tool result says how big it was where an operator reads it: on its row in the playground trace
// and on its `tool` line on the Logs page, without opening the line. Every assertion reduces to a
// string or a boolean before expect.
const catalogs = { en: { translation: en }, "pt-BR": { translation: ptBR } };

describe("tool result size in the playground trace", () => {
  afterEach(() => cleanup());

  const sizeText = (lng: string, size?: { chars: number; tokens: number }) => {
    render(
      withI18n(
        <TraceRow
          entry={{
            type: "tool_result",
            id: "c1",
            name: "catalog",
            output: "…",
            isError: false,
            ...(size ? { size } : {}),
          }}
        />,
        createTestI18n(lng, catalogs),
      ),
    );
    return screen.queryByTestId("trace-result-size")?.textContent ?? null;
  };

  test("shows characters and estimated tokens next to the result", () => {
    expect(sizeText("en", { chars: 18234, tokens: 4120 })).toBe(
      "18,234 chars · ~4,120 tokens",
    );
  });

  test("follows the console language", () => {
    expect(sizeText("pt-BR", { chars: 18234, tokens: 4120 })).toBe(
      "18.234 caracteres · ~4.120 tokens",
    );
  });

  test("a trace saved before sizes were recorded shows nothing", () => {
    expect(sizeText("en")).toBe(null);
  });
});

test("a size missing either count is not shown as a number it does not have", () => {
  const t = createTestI18n("en", catalogs).t;
  expect(toolResultSizeLabel({ chars: 5 }, t, "en")).toBe(null);
  expect(toolResultSizeLabel({ tokens: 5 }, t, "en")).toBe(null);
  expect(toolResultSizeLabel("12", t, "en")).toBe(null);
});

const realFetch = globalThis.fetch;
let items: unknown[] = [];

function toolLine(id: string, detail: Record<string, unknown>): unknown {
  return {
    id,
    turnId: `t-${id}`,
    conversationId: "12",
    agentId: null,
    inboxId: null,
    threadId: null,
    stage: "tool",
    level: "info",
    status: "ok",
    provider: null,
    model: null,
    durationMs: 812,
    source: "inbox",
    detail,
    errorMessage: null,
    createdAt: "2026-10-16T12:00:00.000Z",
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

async function logsText(rows: unknown[]): Promise<string> {
  items = rows;
  const { container } = render(
    withI18n(
      <MemoryRouter initialEntries={["/logs"]}>
        <TooltipPrimitive.Provider>
          <ToastProvider>
            <LogsPage />
          </ToastProvider>
        </TooltipPrimitive.Provider>
      </MemoryRouter>,
      createTestI18n("en", catalogs),
    ),
  );
  await waitFor(() => {
    if (!container.querySelector("button[aria-expanded]"))
      throw new Error("no group yet");
  });
  // Opens the turn groups only: the tool rows stay collapsed, so the size is read off the row itself.
  for (const b of [
    ...container.querySelectorAll("button[aria-expanded='false']"),
  ])
    if (!b.closest(".px-3.py-2")) fireEvent.click(b);
  await waitFor(() => {
    if (!container.textContent?.includes("812ms"))
      throw new Error("rows not open yet");
  });
  return container.textContent ?? "";
}

describe("tool result size on the Logs page", () => {
  beforeAll(() => {
    globalThis.fetch = stubFetch;
  });
  afterEach(() => cleanup());
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test("a tool line shows its result's size without being opened", async () => {
    const text = await logsText([
      toolLine("a", {
        tool: "catalog",
        output: { type: "string", length: 18234 },
        resultSize: { chars: 18234, tokens: 4120 },
      }),
    ]);
    expect(text.includes("812ms · 18,234 chars · ~4,120 tokens")).toBe(true);
  });

  test("a line written before sizes were recorded shows no size", async () => {
    const text = await logsText([toolLine("b", { tool: "catalog" })]);
    expect(text.includes("chars")).toBe(false);
  });
});
