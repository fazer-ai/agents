/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ToastProvider } from "@/client/components";
import { useModalController } from "@/client/components/Modal";
import {
  type CodeTool,
  CodeToolEditModal,
  formFromCodeTool,
  payloadOfCodeTool,
} from "@/client/pages/resources/CodeToolEditModal";

// The dominant pattern in this suite: pure-function tests over the exported form helpers, plus one
// happy-dom render that proves the load-bearing UI rule — an invalid body warns but never disables
// Save (invalid code is SAVED and fails at call time, as the operator's failure).

afterEach(cleanup);

function codeTool(over: Partial<CodeTool> = {}): CodeTool {
  return {
    id: "1",
    name: "lookup_cpf",
    label: "Look up CPF",
    description: "Check whether a CPF is valid.",
    inputSchema: { cpf: { type: "string", required: true } },
    code: "return { ok: true };",
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  } as unknown as CodeTool;
}

describe("formFromCodeTool", () => {
  test("maps the stored tool into the form, schema into AI-field rows", () => {
    const form = formFromCodeTool(codeTool());
    expect(form.label).toBe("Look up CPF");
    expect(form.description).toBe("Check whether a CPF is valid.");
    expect(form.code).toBe("return { ok: true };");
    expect(form.enabled).toBe(true);
    expect(form.aiFields.map((f) => f.name)).toEqual(["cpf"]);
    expect(form.aiFields[0]?.type).toBe("string");
    expect(form.aiFields[0]?.required).toBe(true);
  });

  test("a tool with no schema has no argument rows", () => {
    const form = formFromCodeTool(codeTool({ inputSchema: {} }));
    expect(form.aiFields).toEqual([]);
  });
});

describe("payloadOfCodeTool", () => {
  test("derives the identifier from the label and trims the copy fields", () => {
    const form = {
      ...formFromCodeTool(codeTool()),
      label: "  Buscar CPF/CNPJ  ",
      description: "  a description  ",
    };
    const payload = payloadOfCodeTool(form);
    // The model-facing identifier is always derived from the display name (single source of truth).
    expect(payload.name).toBe("buscar_cpf_cnpj");
    expect(payload.label).toBe("Buscar CPF/CNPJ");
    expect(payload.description).toBe("a description");
  });

  test("the input schema is the AI-fields panel's object, not the raw rows", () => {
    const payload = payloadOfCodeTool(formFromCodeTool(codeTool()));
    expect(payload.inputSchema).toEqual({
      cpf: { type: "string", required: true },
    });
  });

  test("two rows that trim to one name collapse to the last, like an HTTP tool", () => {
    const form = {
      ...formFromCodeTool(codeTool({ inputSchema: {} })),
      aiFields: [
        {
          _id: "a",
          name: "qty",
          type: "integer" as const,
          required: true,
          description: "first",
          enumValues: [] as string[],
          itemType: "string" as const,
        },
        {
          _id: "b",
          name: "  qty  ",
          type: "string" as const,
          required: false,
          description: "second",
          enumValues: [] as string[],
          itemType: "string" as const,
        },
      ],
    };
    const schema = payloadOfCodeTool(form).inputSchema as Record<
      string,
      unknown
    >;
    expect(Object.keys(schema)).toEqual(["qty"]);
    expect(schema.qty).toEqual({ type: "string", description: "second" });
  });

  test("round-trips a stored tool back to a payload the create accepts", () => {
    const payload = payloadOfCodeTool(formFromCodeTool(codeTool()));
    expect(payload.name).toBe("look_up_cpf");
    expect(payload.code).toBe("return { ok: true };");
    expect(payload.enabled).toBe(true);
  });
});

// The one DOM rule the pure tests cannot hold: the syntax warning is advisory, so Save stays enabled
// even while the body does not parse. Every assertion is reduced to a primitive before `expect`;
// never `expect` a DOM node (the runner hangs).
function Harness() {
  const modal = useModalController<{ id?: string }>();
  return (
    <ToastProvider>
      <button type="button" onClick={() => modal.open({})}>
        open
      </button>
      <CodeToolEditModal modal={modal} />
    </ToastProvider>
  );
}

test("an invalid body warns but leaves Save enabled", async () => {
  render(<Harness />);
  fireEvent.click(screen.getByText("open"));

  // Radix portals the dialog to document.body, so query there, not the render container.
  const input = document.body.querySelector("input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "Look up CPF" } });

  const textareas = [...document.body.querySelectorAll("textarea")];
  const description = textareas.find(
    (ta) => !ta.className.includes("font-mono"),
  ) as HTMLTextAreaElement;
  const code = textareas.find((ta) =>
    ta.className.includes("font-mono"),
  ) as HTMLTextAreaElement;
  fireEvent.change(description, { target: { value: "a description" } });
  // Does not parse: an unfinished expression.
  fireEvent.change(code, { target: { value: "return input.cpf." } });

  // The warning is debounced (300 ms) then computed by the same acorn check the server runs.
  await screen.findByText(/Line \d+, column \d+:/, {}, { timeout: 2000 });

  // Save is still enabled: an invalid body is saved and fails at call time, never refused here.
  const save = screen.getByText("Save").closest("button");
  expect(save?.hasAttribute("disabled")).toBe(false);
});

test("a body with no return warns without disabling Save", async () => {
  render(<Harness />);
  fireEvent.click(screen.getByText("open"));

  const input = document.body.querySelector("input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "No return" } });
  const textareas = [...document.body.querySelectorAll("textarea")];
  const description = textareas.find(
    (ta) => !ta.className.includes("font-mono"),
  ) as HTMLTextAreaElement;
  const code = textareas.find((ta) =>
    ta.className.includes("font-mono"),
  ) as HTMLTextAreaElement;
  fireEvent.change(description, { target: { value: "a description" } });
  fireEvent.change(code, { target: { value: "const x = 1;" } });

  await waitFor(
    () =>
      expect(screen.queryByText(/never returns a value/) !== null).toBe(true),
    { timeout: 2000 },
  );
  const save = screen.getByText("Save").closest("button");
  expect(save?.hasAttribute("disabled")).toBe(false);
});

// The other DOM rule: an answer belongs to the opening that asked for it. The GET outlives the
// dialog, so closing while it is out and reopening on another tool would otherwise let the first
// answer fill the second form — and Save would then patch the new id with the old tool's contents.
// `fetch` is intercepted rather than the api module: `mock.module` is process-global and tears down
// mocks other files installed (the note in document-starters-race.test.tsx).
function TwoToolsHarness() {
  const modal = useModalController<{ id?: string }>();
  return (
    <ToastProvider>
      <button type="button" onClick={() => modal.open({ id: "1" })}>
        open-1
      </button>
      <button type="button" onClick={() => modal.open({})}>
        open-new
      </button>
      <button type="button" onClick={() => modal.close()}>
        close-it
      </button>
      <CodeToolEditModal modal={modal} />
    </ToastProvider>
  );
}

test("an answer for the previous opening never fills the current form", async () => {
  const realFetch = globalThis.fetch;
  const gates: Record<string, () => void> = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const m = /\/code-tools\/(\d+)/.exec(href);
    if (!m || (init?.method ?? "GET").toUpperCase() !== "GET") {
      return realFetch(input as RequestInfo, init);
    }
    const id = m[1] as string;
    await new Promise<void>((r) => {
      gates[id] = r;
    });
    return new Response(
      JSON.stringify({
        tool: codeTool({ id, label: `Tool ${id}`, name: `tool_${id}` }),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    render(<TwoToolsHarness />);
    fireEvent.click(screen.getByText("open-1"));
    await waitFor(() => expect(typeof gates["1"]).toBe("function"));
    fireEvent.click(screen.getByText("close-it"));
    // Reopened for CREATE, which is the reopening where the stale answer is visible: an edit shows
    // its own skeleton until it loads, while this form is on screen and empty.
    fireEvent.click(screen.getByText("open-new"));
    await waitFor(() =>
      expect(document.body.querySelectorAll("input").length > 0).toBe(true),
    );
    const label = () =>
      ([...document.body.querySelectorAll("input")][0] as HTMLInputElement)
        ?.value ?? "";
    fireEvent.change(
      [...document.body.querySelectorAll("input")][0] as HTMLInputElement,
      { target: { value: "Novo" } },
    );
    // The first tool answers now, for a dialog that is gone.
    gates["1"]?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(label()).toBe("Novo");
  } finally {
    globalThis.fetch = realFetch;
  }
});
