/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components/Toast";
import { ProactiveBreakerProvider } from "@/client/contexts/ProactiveBreakerContext";
import { AdvancedPanel } from "@/client/pages/resources/AdvancedPanel";

// The share of turns traced, on the Langfuse card: typed as a percentage, saved as a fraction, and
// empty meaning the deployment's default, which the field shows.

const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

let stored: number | null = null;
const puts: Record<string, unknown>[] = [];

const langfuse = () => ({
  enabled: true,
  credentialRef: null,
  sendContent: true,
  debug: false,
  sampleRate: stored,
  defaultSampleRate: 0.05,
});

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.pathname === "/api/v1/tenant-settings/langfuse") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    puts.push(body);
    stored = body.sampleRate ?? null;
    return json({ instance: {}, langfuse: langfuse() });
  }
  if (url.pathname === "/api/v1/tenant-settings") {
    return json({
      instance: {},
      embedding: { credentialRef: null },
      langfuse: langfuse(),
      spendCeiling: {
        enabled: false,
        monthlyInboxUsd: null,
        monthlyPlaygroundUsd: null,
        overCeilingMessage: null,
        handoffEnabled: false,
        noticeCooldownSeconds: 3600,
        warnAtPercent: 80,
        legacyTokens: null,
      },
      priceOverrides: { overrides: [], savedAt: null },
    });
  }
  return json({}, 404);
}) as typeof fetch;

afterEach(() => {
  cleanup();
  puts.length = 0;
  stored = null;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

async function open() {
  render(
    <MemoryRouter>
      <ToastProvider>
        <ProactiveBreakerProvider>
          <AdvancedPanel />
        </ProactiveBreakerProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
  const field = (await waitFor(() =>
    screen.getByLabelText("Share of turns traced (%)"),
  )) as HTMLInputElement;
  const card = document.getElementById("observability") as HTMLElement;
  const save = Array.from(card.querySelectorAll("button")).find(
    (b) => b.textContent === "Save",
  ) as HTMLButtonElement;
  return { field, card, save };
}

describe("the share of turns traced", () => {
  test("empty shows the deployment's default and saves null", async () => {
    const { field, card, save } = await open();
    expect(field.value).toBe("");
    expect(field.placeholder).toBe("5");
    expect(card.textContent).toContain("this deployment's default (5%)");
    fireEvent.click(save);
    await waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0]?.sampleRate).toBeNull();
  });

  test("a percentage is saved as the fraction, and a stored one is shown back as a percentage", async () => {
    const first = await open();
    fireEvent.change(first.field, { target: { value: "12.5" } });
    fireEvent.click(first.save);
    await waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0]?.sampleRate).toBe(0.125);
    cleanup();
    const again = await open();
    expect(again.field.value).toBe("12.5");
  });

  test("text that is not a number holds Save instead of saving the deployment default", async () => {
    stored = 0.25;
    const { field, save } = await open();
    expect(field.value).toBe("25");
    Object.defineProperty(field, "validity", {
      configurable: true,
      get: () => ({ badInput: true }),
    });
    fireEvent.input(field, { target: { value: "" } });
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(puts).toEqual([]);
  });

  test("a value outside 0 to 100 holds Save", async () => {
    const { field, save } = await open();
    fireEvent.change(field, { target: { value: "150" } });
    expect(save.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "100" } });
    expect(save.disabled).toBe(false);
  });
});
