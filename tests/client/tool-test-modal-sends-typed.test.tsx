/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// THE COERCION IS ONLY WORTH WHAT THE DIALOG ACTUALLY SENDS.
//
// `tool-test-arg-coercion.test.ts` proves the table, against the very schema `buildHttpTool`
// validates with. It cannot prove that `run()` calls it: the mutation battery for review round 1
// replaced `args[f.name] = coerced.value` with the raw string and every test still passed. This
// file is the adoption half — it drives the dialog and reads the body that went on the wire.

const { ToolTestModal } = await import(
  "@/client/pages/resources/ToolTestModal"
);
type ToolTestTarget = Parameters<
  typeof ToolTestModal
>[0]["modal"]["payload"] extends infer P
  ? NonNullable<P>
  : never;
const { useModalController } = await import("@/client/components/Modal");
const { ToastProvider } = await import("@/client/components");

const realFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const TARGET: ToolTestTarget = {
  definition: {
    name: "lookup",
    method: "GET",
    urlTemplate: "https://api.example.com/x",
    allowedHosts: ["api.example.com"],
  },
  aiFields: [
    { name: "qty", description: "", required: false, type: "integer" },
    { name: "rate", description: "", required: false, type: "number" },
    { name: "flag", description: "", required: false, type: "boolean" },
    {
      name: "tags",
      description: "",
      required: false,
      type: "array",
      itemType: "integer",
    },
    { name: "bag", description: "", required: false, type: "object" },
    { name: "note", description: "", required: false, type: "string" },
  ],
  contextNames: [],
};

function mount(sent: { body?: unknown }) {
  globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() === "POST") {
      sent.body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          instance: {},
          result: {
            status: 200,
            durationMs: 1,
            raw: "{}",
            rawChars: 2,
            rawClipped: false,
            modelText: "HTTP 200\n{}",
            failed: false,
            notes: [],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  function Harness() {
    const modal = useModalController<ToolTestTarget>();
    return (
      <ToastProvider>
        <button type="button" onClick={() => modal.open(TARGET)}>
          open
        </button>
        <ToolTestModal modal={modal} onResponse={() => {}} />
      </ToastProvider>
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByText("open"));
}

// FormField renders a <label> for a single control and a role="group" for the boolean/enum picker,
// so neither getByLabelText nor a fixed selector reaches all six. Walk up from the field's title to
// the first ancestor holding EXACTLY ONE control — one is what says the ancestor is still this
// field's, and stopping at the first ancestor with any control would climb into the next.
function fill(label: string, value: string) {
  let node: HTMLElement | null = screen.getByText(label);
  while (
    node &&
    node.querySelectorAll("input, textarea, select").length !== 1
  ) {
    node = node.parentElement;
  }
  if (!node) throw new Error(`no single control under "${label}"`);
  const control = node.querySelector(
    "input, textarea, select",
  ) as HTMLInputElement;
  fireEvent.change(control, { target: { value } });
}

test("every declared type reaches the endpoint as that type, not as text", async () => {
  const sent: { body?: unknown } = {};
  mount(sent);
  fill("qty", "42");
  fill("rate", "3.5");
  fill("flag", "true");
  fill("tags", "1, 2");
  fill("bag", '{"k":1}');
  fill("note", "hello");
  fireEvent.click(screen.getByText("Send request"));
  await waitFor(() => expect(sent.body).toBeDefined());
  expect((sent.body as { args: unknown }).args).toEqual({
    qty: 42,
    rate: 3.5,
    flag: true,
    tags: [1, 2],
    bag: { k: 1 },
    note: "hello",
  });
});

test("a value the declared type cannot take is not sent at all", async () => {
  const sent: { body?: unknown } = {};
  mount(sent);
  fill("qty", "3.5");
  // The button is disabled while a box holds something its type refuses, so the operator reads the
  // problem here instead of reading a zod error out of a failed call.
  const button = screen.getByText("Send request").closest("button");
  expect(button?.hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByText("Send request"));
  await new Promise((r) => setTimeout(r, 20));
  expect(sent.body).toBeUndefined();
  // The type is named the way the field editor names it, not by its wire keyword.
  expect(screen.getByText(/has to be: Integer/)).toBeDefined();
});
