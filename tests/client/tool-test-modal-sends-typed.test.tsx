/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import {
  act,
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

function mount(
  sent: { body?: unknown },
  opts: {
    target?: ToolTestTarget;
    hold?: { release?: () => void };
    clipped?: boolean;
    status?: number;
    onCall?: () => void;
  } = {},
) {
  globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() === "POST") {
      opts.onCall?.();
      sent.body = JSON.parse(String(init?.body ?? "{}"));
      const hold = opts.hold;
      if (hold) {
        await new Promise<void>((r) => {
          hold.release = r;
        });
      }
      return new Response(
        JSON.stringify({
          instance: {},
          result: {
            status: opts.status ?? 200,
            durationMs: 1,
            raw: "{}",
            rawChars: opts.clipped ? 100_001 : 2,
            rawClipped: opts.clipped ?? false,
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

  const seenSamples: string[] = [];
  const seenStatuses: number[] = [];
  let controller: { open: () => void; close: () => void } | null = null;
  function Harness() {
    const modal = useModalController<ToolTestTarget>();
    controller = {
      open: () => modal.open(opts.target ?? TARGET),
      close: () => modal.close(),
    };
    return (
      <ToastProvider>
        <button type="button" onClick={() => modal.open(opts.target ?? TARGET)}>
          open
        </button>
        <ToolTestModal
          modal={modal}
          onResponse={(raw, status) => {
            seenSamples.push(raw);
            seenStatuses.push(status);
          }}
        />
      </ToastProvider>
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByText("open"));
  return {
    samples: seenSamples,
    statuses: seenStatuses,
    reopen: () => {
      act(() => controller?.close());
      act(() => controller?.open());
    },
  };
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

// Round 2 of review. Three ways the dialog could be filled in and still not run, or run and answer
// for the wrong session.

test("a required field left blank stops the send and says which field", () => {
  const sent: { body?: unknown } = {};
  mount(sent, {
    target: {
      ...TARGET,
      // An INTEGER, because a required string left blank is the empty string rather than a gap
      // (round 11); this fence is about the type where blank really is nothing.
      aiFields: [
        { name: "cnpj", description: "", required: true, type: "integer" },
      ],
    },
  });
  // Blank required used to be the SILENT one: the box was skipped, `args` went out without it, and
  // the declared schema refused the call before the request — with the button enabled the whole
  // time, so the first thing the operator learned was a failed run.
  const button = screen.getByText("Send request").closest("button");
  expect(button?.hasAttribute("disabled")).toBe(true);
  expect(screen.getByText(/"cnpj" is required/)).toBeDefined();
  fireEvent.click(screen.getByText("Send request"));
  expect(sent.body).toBeUndefined();
});

test("an enum with no declared values takes typed text, because the runtime does", async () => {
  const sent: { body?: unknown } = {};
  mount(sent, {
    target: {
      ...TARGET,
      aiFields: [
        // Legal, and `zodFor` reads it as a free string. A picker built from the empty list would
        // offer "Leave out" and nothing else, so this field could be declared and never filled.
        { name: "tier", description: "", required: false, type: "enum" },
      ],
    },
  });
  fill("tier", "platinum");
  fireEvent.click(screen.getByText("Send request"));
  await waitFor(() => expect(sent.body).toBeDefined());
  expect((sent.body as { args: unknown }).args).toEqual({ tier: "platinum" });
});

test("a response from a dismissed session never lands on the next one", async () => {
  const sent: { body?: unknown } = {};
  const hold: { release?: () => void } = {};
  const { samples, reopen } = mount(sent, { hold });
  fireEvent.click(screen.getByText("Send request"));
  await waitFor(() => expect(hold.release).toBeDefined());
  // Dismissed mid-flight (X, Escape and outside click are all live while running) and reopened.
  reopen();
  await act(async () => {
    hold.release?.();
    await Promise.resolve();
  });
  await new Promise((r) => setTimeout(r, 20));
  // The first run's answer belongs to the opening that asked for it, or to nobody: it must not fill
  // the parent editor's sample with a response to a definition that is no longer on screen, and it
  // must not paint a result under a form the operator has just cleared.
  expect(samples).toEqual([]);
  expect(screen.queryByText(/HTTP 200 in/)).toBeNull();
});

// Round 3 of review, finding 3. The wire cap on the raw response is 100k characters, and what comes
// back past it is a PREFIX: not a JSON document, so both path pickers go dark and the sample field
// says only "not valid JSON" — none of which names the actual reason.
test("a response too large to be a sample is not offered as one", async () => {
  const sent: { body?: unknown } = {};
  const { samples } = mount(sent, { clipped: true });
  fireEvent.click(screen.getByText("Send request"));
  await waitFor(() => expect(sent.body).toBeDefined());
  await waitFor(() => expect(screen.getByText(/too large/)).toBeDefined());
  // The editor's sample keeps whatever it had; the run's own answer is still on screen.
  expect(samples).toEqual([]);
});

test("a usable response is handed over with the status it came back under", async () => {
  const sent: { body?: unknown } = {};
  const { statuses } = mount(sent, { status: 404 });
  fireEvent.click(screen.getByText("Send request"));
  await waitFor(() => expect(statuses.length).toBe(1));
  // The status travels because the runtime projects the template on 2xx alone — see the preview
  // test in tests/client/pages/ToolEditModal.test.tsx.
  expect(statuses).toEqual([404]);
});

// Round 8 of review, finding 1. The session token makes a LATE answer harmless; it does not un-send
// the request. A test of a POST is a real write on the provider's side, so a dialog that can be
// dismissed mid-flight and reopened runs the operation twice, with the first result deliberately
// dropped so nothing on screen says it happened.
test("no way out while a request is in flight, and no second send", async () => {
  const sent: { body?: unknown } = {};
  const hold: { release?: () => void } = {};
  let calls = 0;
  const { reopen } = mount(sent, { hold, onCall: () => calls++ });
  fireEvent.click(screen.getByText("Send request"));
  await waitFor(() => expect(hold.release).toBeDefined());
  expect(calls).toBe(1);
  // Every user-driven close: Escape, the overlay, the X. `disabled` on Cancel covers none of them.
  fireEvent.keyDown(document, { key: "Escape" });
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByText("Send request")).not.toBeNull();
  // And the close that would have led to the second write does not happen, so reopening cannot
  // start one either.
  reopen();
  await new Promise((r) => setTimeout(r, 20));
  expect(calls).toBe(1);
  hold.release?.();
});

// Round 11 of review, the adoption half: the table above proves the rule, and this proves the
// dialog follows it — the same gap round 1 found in the coercion.
test("an empty string reaches the wire when the field takes one", async () => {
  const sent: { body?: unknown } = {};
  mount(sent, {
    target: {
      ...TARGET,
      aiFields: [
        // Required: blank can only mean "", because it cannot be omitted.
        { name: "note", description: "", required: true, type: "string" },
        // Optional: blank means left out until the operator says otherwise.
        { name: "tag", description: "", required: false, type: "string" },
      ],
    },
  });
  const button = screen.getByText("Send request").closest("button");
  expect(button?.hasAttribute("disabled")).toBe(false);
  // And the choice is offered exactly where it exists: one switch, for the optional field. The
  // required one's blank box has nothing to disambiguate — it cannot be omitted — so a toggle
  // there would offer a request the definition cannot make.
  expect(screen.getAllByRole("switch")).toHaveLength(1);
  // A switch's label only describes the ON state, so the OFF one — the field disappearing from the
  // payload — has to be written down somewhere. It is the half nobody guesses.
  expect(
    screen.getByRole("button", {
      name: /Show help: Send it as empty in the request/,
    }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByText("Send request"));
  await waitFor(() => expect(sent.body).toBeDefined());
  expect((sent.body as { args: unknown }).args).toEqual({ note: "" });
});

test("and an optional field says so explicitly, because a blank box cannot", async () => {
  const sent: { body?: unknown } = {};
  mount(sent, {
    target: {
      ...TARGET,
      aiFields: [
        { name: "tag", description: "", required: false, type: "string" },
      ],
    },
  });
  // The control is a switch with a FIXED label. It used to be a text link whose whole sentence
  // rewrote itself on click, so it had no identity to scan a form for and had to be read twice to
  // be used once. The STATE moved to where the operator is already looking: the placeholder of the
  // blank box the toggle is about.
  expect(
    screen.getByPlaceholderText("not included in the request"),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("switch", { name: /Send it as empty in the request/ }),
  );
  expect(screen.getByPlaceholderText('goes in empty: ""')).toBeInTheDocument();
  fireEvent.click(screen.getByText("Send request"));
  await waitFor(() => expect(sent.body).toBeDefined());
  expect((sent.body as { args: unknown }).args).toEqual({ tag: "" });
});

// Round 16 of review, finding 2. A tool may declare an input field named after a conversation
// placeholder, and the runtime has an explicit precedence for that name: AI input, then a fixed
// value, then context (`valueLookup` in graph/tools/http.ts). So the case worth testing is the
// second one — the model omits the optional argument and context supplies the fallback — and the
// dialog could not express it: both rows were keyed and indexed by the bare name, so one box fed
// both halves and the same string went out in `args` AND in `context`.
test("an AI field and a context variable of the same name are two boxes", async () => {
  const sent: { body?: unknown } = {};
  mount(sent, {
    target: {
      ...TARGET,
      definition: {
        ...TARGET.definition,
        urlTemplate: "https://api.example.com/x/{{contact_id}}",
      },
      aiFields: [
        {
          name: "contact_id",
          description: "",
          required: false,
          type: "string",
        },
      ],
      contextNames: ["contact_id"],
    },
  });
  const boxes = screen.getAllByRole("textbox");
  expect(boxes).toHaveLength(2);
  // Leave the AI box blank — the model omitting it — and give context its own value.
  fireEvent.change(boxes[1] as HTMLElement, { target: { value: "42" } });
  fireEvent.click(screen.getByText("Send request"));
  await waitFor(() => expect(sent.body).toBeDefined());
  const body = sent.body as { args: unknown; context: unknown };
  expect(body.args).toEqual({});
  expect(body.context).toEqual({ contact_id: "42" });
});
