/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { BusinessHoursForm } from "@/client/components/BusinessHoursForm";
import { ToastProvider } from "@/client/components/Toast";

// The form PATCHes `exceptions` on every save, so whatever it was handed has to survive the round
// trip. A caller that builds `initial` without them makes the form initialize to [] and the save
// then DELETES every holiday and closure the operator had configured — silently, from a screen that
// was opened to change something else. The type now requires the field at every call site; this is
// the runtime half, on the form's own contract.
//
// NOTE: every assertion reduces to a boolean or a string BEFORE expect. A failing expectation that
// holds a DOM node serializes a cyclic happy-dom tree and stalls the runner.

const EXCEPTIONS = [
  { date: "2026-09-07", label: "Independência", ranges: [] },
  {
    date: "2026-12-24",
    label: "Véspera",
    ranges: [{ start: "08:00", end: "12:00" }],
  },
];

describe("BusinessHoursForm", () => {
  // Stubbing globalThis.fetch rather than mocking the api module on purpose: `mock.module` is global
  // to the process and leaks into whatever else shares the worker.
  const realFetch = globalThis.fetch;
  let sent: { method: string; body: unknown } | null = null;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent = {
      method: String(init?.method ?? "GET"),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    return new Response(
      JSON.stringify({ businessHours: { id: "7", name: "Atendimento" } }),
      { headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof globalThis.fetch;

  afterEach(() => {
    cleanup();
    sent = null;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test("a save sends back the exceptions it was given, untouched", async () => {
    render(
      <ToastProvider>
        <BusinessHoursForm
          mode="update"
          initial={{
            id: "7",
            name: "Atendimento",
            timezone: "America/Sao_Paulo",
            windows: [{ day: 1, start: "09:00", end: "18:00" }],
            exceptions: EXCEPTIONS,
          }}
          onSaved={() => {}}
          onCancel={() => {}}
        />
      </ToastProvider>,
    );
    const save = screen.getByRole("button", { name: /^(Salvar|Save)$/ });
    save.click();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    const body = sent?.body as { exceptions?: unknown } | null;
    expect(sent?.method).toBe("PATCH");
    expect(JSON.stringify(body?.exceptions)).toBe(JSON.stringify(EXCEPTIONS));
  });

  test("the exceptions section renders every date it was given", () => {
    render(
      <ToastProvider>
        <BusinessHoursForm
          mode="update"
          initial={{
            id: "7",
            name: "Atendimento",
            timezone: "America/Sao_Paulo",
            windows: [],
            exceptions: EXCEPTIONS,
          }}
          onSaved={() => {}}
          onCancel={() => {}}
        />
      </ToastProvider>,
    );
    const dates = screen
      .getAllByLabelText(/^(Data|Date)$/)
      .map((el) => (el as HTMLInputElement).value);
    expect(dates.join(",")).toBe("2026-09-07,2026-12-24");
  });
});
