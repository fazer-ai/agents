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
