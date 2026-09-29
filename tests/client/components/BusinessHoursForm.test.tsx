/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { BusinessHoursForm } from "@/client/components/BusinessHoursForm";
import { ToastProvider } from "@/client/components/Toast";

// The form PATCHes `exceptions` on every save, so whatever it was handed has to survive the round
// trip: an `initial` without them makes the save silently DELETE every holiday and closure. The
// type requires the field at every call site; this is the runtime half, on the form's own contract.
//
// Every assertion reduces to a boolean or a string BEFORE expect: a failing expectation that holds
// a DOM node serializes a cyclic happy-dom tree and stalls the runner.

const EXCEPTIONS = [
  { date: "2026-09-07", label: "Independência", ranges: [] },
  {
    date: "2026-12-24",
    label: "Véspera",
    ranges: [{ start: "08:00", end: "12:00" }],
  },
];

describe("BusinessHoursForm", () => {
  // Stubbing `globalThis.fetch` rather than the api module: `mock.module` is global to the
  // process and leaks into whatever else shares the worker. The fetch stub is process-global too,
  // so it records whatever ANYTHING in the worker sends; every call is kept WITH ITS URL and the
  // assertions look up the one the form is responsible for, so a stray request can be named instead
  // of overwriting the answer.
  const realFetch = globalThis.fetch;
  const calls: { method: string; url: string; body: unknown }[] = [];
  // Matches the collection route too, because `POST /api/v1/business-hours` is what the form
  // sends in CREATE mode: narrowing to `/business-hours/7` would turn a wrongly-taken create branch
  // into a timeout with nothing to read. The assertions require exactly ONE call and then name it.
  const businessHoursCalls = () =>
    calls.filter((call) => call.url.includes("/business-hours"));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      method: String(init?.method ?? "GET"),
      url:
        typeof input === "string"
          ? input
          : String((input as Request).url ?? input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(
      JSON.stringify({ businessHours: { id: "7", name: "Atendimento" } }),
      { headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof globalThis.fetch;

  afterEach(() => {
    cleanup();
    calls.length = 0;
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
    // NOTE: waits for the EFFECT rather than a fixed number of ticks: on an idle runner the call
    // lands on the first macrotask, so a tick count leaves zero margin.
    await waitFor(() => expect(businessHoursCalls().length).toBe(1));

    const [sent] = businessHoursCalls();
    const body = sent?.body as { exceptions?: unknown } | null;
    expect(sent?.method).toBe("PATCH");
    expect(sent?.url.endsWith("/api/v1/business-hours/7")).toBe(true);
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
