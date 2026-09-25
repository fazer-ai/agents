/// <reference lib="dom" />

import { afterAll, afterEach, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// Issue #865: the tenant's own prices, edited as a list. What the save sends is the assertion: an
// emptied optional rate is "not set" (absent), never a zero that would price the cache for free, and
// a removed row is gone from the list the server replaces.
//
// NOTE: `globalThis.fetch` is swapped rather than `mock.module`, for the reason
// credential-whitespace-not-overridable.test.tsx gives. Assertions reduce to plain values first.

const { PriceOverridesCard } = await import(
  "@/client/pages/resources/PriceOverridesCard"
);
const { ToastProvider } = await import("@/client/components/Toast");

const realFetch = globalThis.fetch;
afterEach(cleanup);
afterAll(() => {
  globalThis.fetch = realFetch;
});

function captureSaves(): unknown[] {
  const bodies: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : null;
    const text = req ? await req.text() : String(init?.body ?? "");
    const body = JSON.parse(text || "{}") as { overrides: unknown[] };
    bodies.push(body);
    return new Response(
      JSON.stringify({
        instance: {},
        priceOverrides: {
          overrides: body.overrides,
          updatedAt: "2026-09-25T12:00:00.000Z",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return bodies;
}

const EXISTING = {
  overrides: [
    {
      provider: "anthropic" as const,
      model: "claude-sonnet-4-6",
      input: 2,
      cachedInput: 0.2,
      output: 10,
    },
    {
      provider: "openai" as const,
      model: "gpt-4o-mini",
      input: 0.1,
      output: 0.4,
    },
  ],
  updatedAt: "2026-09-24T00:00:00.000Z",
};

function mount(onSaved: (v: unknown) => void = () => {}) {
  return render(
    <ToastProvider>
      <PriceOverridesCard value={EXISTING} onSaved={onSaved} />
    </ToastProvider>,
  );
}

const rows = () => screen.queryAllByTestId("price-override-row").length;

test("the saved list is shown, one row per price", () => {
  mount();
  expect(rows()).toBe(2);
  const models = screen
    .getAllByRole("textbox")
    .map((i) => (i as HTMLInputElement).value);
  expect(models).toContain("claude-sonnet-4-6");
  expect(models).toContain("gpt-4o-mini");
});

test("a new row with only its required rates saves without the optional ones, and a removed row is gone", async () => {
  const bodies = captureSaves();
  let saved: unknown = null;
  mount((v) => {
    saved = v;
  });
  fireEvent.click(screen.getByRole("button", { name: "Remove row 2" }));
  expect(rows()).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "Add price" }));
  expect(rows()).toBe(2);
  const last = screen.getAllByTestId("price-override-row")[1] as HTMLElement;
  const inputs = [...last.querySelectorAll("input")];
  const select = last.querySelector("select") as HTMLSelectElement;
  fireEvent.change(select, { target: { value: "openai-compatible" } });
  // Model, input, cached input, cache write, output: the two optional ones stay empty.
  fireEvent.change(inputs[0] as HTMLInputElement, {
    target: { value: "llama-local" },
  });
  fireEvent.change(inputs[1] as HTMLInputElement, {
    target: { value: "0,05" },
  });
  fireEvent.change(inputs[4] as HTMLInputElement, { target: { value: "0.1" } });
  fireEvent.click(screen.getByRole("button", { name: "Save prices" }));
  await waitFor(() => expect(saved !== null).toBe(true));
  expect(JSON.stringify(bodies[0])).toBe(
    JSON.stringify({
      overrides: [
        {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          input: 2,
          output: 10,
          cachedInput: 0.2,
        },
        {
          provider: "openai-compatible",
          model: "llama-local",
          input: 0.05,
          output: 0.1,
        },
      ],
    }),
  );
});

test("while a save is in flight the list cannot be edited, so no edit is lost to its answer", async () => {
  let answer: (r: Response) => void = () => {};
  globalThis.fetch = (() =>
    new Promise<Response>((r) => {
      answer = r;
    })) as unknown as typeof fetch;
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Save prices" }));
  await waitFor(() =>
    expect(
      (screen.getAllByRole("textbox")[0] as HTMLInputElement).disabled,
    ).toBe(true),
  );
  expect(
    (screen.getByRole("button", { name: "Add price" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Remove row 1" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  answer(
    new Response(JSON.stringify({ instance: {}, priceOverrides: EXISTING }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  await waitFor(() =>
    expect(
      (screen.getAllByRole("textbox")[0] as HTMLInputElement).disabled,
    ).toBe(false),
  );
});
