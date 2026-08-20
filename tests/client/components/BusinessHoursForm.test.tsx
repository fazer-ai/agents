/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  //
  // NOTE: but `globalThis.fetch` is process-global too, just in a different way, so this records
  // whatever ANYTHING in the worker sends while the stub is installed. Keeping a single `sent` and
  // asserting on it made this test read the last request in the process rather than the one the form
  // made: in CI it saw `POST` where a `mode="update"` form with an id can only have sent `PATCH`, on
  // a branch that touched nothing near it, and passed on a rerun unchanged. The stray request was
  // never identified, which is the point — so every call is recorded WITH ITS URL and the assertions
  // look up the one the form is responsible for. A future stray lands in `calls` where it can be
  // named, instead of overwriting the answer.
  const realFetch = globalThis.fetch;
  const calls: { method: string; url: string; body: unknown }[] = [];
  // NOTE: matches the whole endpoint, collection route included, rather than only the item route the
  // update is supposed to hit. That is deliberate: `POST /api/v1/business-hours` is what this same
  // form sends in CREATE mode, and catching a wrongly-taken create branch is half of what this test
  // is for. Narrowing to `/business-hours/7` would turn that failure into a timeout with nothing to
  // read. So the assertions require exactly ONE business-hours call and then say which one it is: a
  // create reports the wrong method and URL, and an unrelated business-hours request from elsewhere
  // reports a count of 2 with every URL in hand.
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
    // NOTE: waits for the EFFECT, the way the rest of the client suite already does, rather than for
    // a fixed number of ticks. Measured on an idle runner the call lands on the first macrotask,
    // which is exactly what the previous `await Promise.resolve()` + `setTimeout(0)` allowed, so the
    // margin was zero even though that was not what broke here.
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
