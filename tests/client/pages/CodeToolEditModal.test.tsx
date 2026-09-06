/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { completionStatus, startCompletion } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { scopeKeyLabel, ToastProvider } from "@/client/components";
import { useModalController } from "@/client/components/Modal";
import i18n from "@/client/lib/i18n";
import {
  type CodeTool,
  CodeToolEditModal,
  formFromCodeTool,
  payloadOfCodeTool,
  starterCode,
} from "@/client/pages/resources/CodeToolEditModal";

// The dominant pattern in this suite: pure-function tests over the exported form helpers, plus one
// happy-dom render that proves the load-bearing UI rule — an invalid body warns but never disables
// Save (invalid code is SAVED and fails at call time, as the operator's failure).

afterEach(cleanup);

// The body is no longer a `<textarea>`: it is CodeMirror (issue #538), so `fireEvent.change` has
// nothing to change. `EditorView.findFromDOM` is CodeMirror's own way to reach the view that owns a
// node, so the test drives the REAL editor and its onChange rather than a stand-in for it, which is
// what keeps these tests about the modal instead of about the widget.
function setCode(text: string) {
  const host = document.body.querySelector(".cm-editor") as HTMLElement;
  const view = EditorView.findFromDOM(host);
  if (!view) throw new Error("the code editor did not mount");
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
  });
}

// The one textarea left in the form.
function descriptionField(): HTMLTextAreaElement {
  return document.body.querySelector("textarea") as HTMLTextAreaElement;
}

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

  test("a field the operator named `__proto__` reaches the server, which is what refuses it", () => {
    // On an ordinary object the assignment hits the prototype setter and the field vanishes from
    // the payload: the tool would then SAVE, with the editor still showing an argument the model is
    // never offered. Kept as an own key, the server answers 422 on `inputSchema` and the operator
    // reads why.
    const form = {
      ...formFromCodeTool(codeTool()),
      aiFields: [
        {
          _id: "a",
          name: "__proto__",
          type: "string" as const,
          required: false,
          description: "",
          enumValues: [] as string[],
          itemType: "string" as const,
        },
      ],
    };
    const schema = payloadOfCodeTool(form).inputSchema as Record<
      string,
      unknown
    >;
    expect(Object.getOwnPropertyNames(schema)).toEqual(["__proto__"]);
    // ...and it survives the trip to the wire, which is where the refusal happens.
    expect(
      Object.getOwnPropertyNames(JSON.parse(JSON.stringify(schema))),
    ).toEqual(["__proto__"]);
  });

  test("round-trips a stored tool back to a payload the create accepts", () => {
    const payload = payloadOfCodeTool(formFromCodeTool(codeTool()));
    expect(payload.name).toBe("look_up_cpf");
    expect(payload.code).toBe("return { ok: true };");
  });

  // `enabled` is absent from BOTH, and that is asserted rather than left implicit: this form has no
  // switch for it (the grant is the control, as on the HTTP tool), so carrying the value it read
  // would let a save that never touched the field revert an `enabled: false` written over MCP while
  // the modal sat open. A future hand adding the field back to either one is the bug this catches.
  test("neither the form nor the payload carries `enabled`", () => {
    const form = formFromCodeTool(codeTool({ enabled: false }));
    expect(Object.hasOwn(form, "enabled")).toBe(false);
    expect(Object.hasOwn(payloadOfCodeTool(form), "enabled")).toBe(false);
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

  fireEvent.change(descriptionField(), { target: { value: "a description" } });
  // Does not parse: an unfinished expression.
  setCode("return input.cpf.");

  // The warning is debounced (300 ms) then computed by the same acorn check the server runs.
  await screen.findByText(/Line \d+, column \d+:/, {}, { timeout: 2000 });

  // Save is still enabled: an invalid body is saved and fails at call time, never refused here.
  const save = screen.getByText("Save").closest("button");
  expect(save?.hasAttribute("disabled")).toBe(false);
});

// The defect as the operator meets it, and the only place it is visible: Escape is how a suggestion
// is dismissed, and it is also how this dialog closes. Radix hears the press first (capture phase on
// `document`), so before the claim in escapeClaim.ts the same key that put the popup away asked
// whether to throw the body out. Measured in a browser; this is the regression fence for it.
test("Escape dismisses the suggestion without offering to discard the body", async () => {
  render(<Harness />);
  fireEvent.click(screen.getByText("open"));

  const input = document.body.querySelector("input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "Look up CPF" } });
  fireEvent.change(descriptionField(), { target: { value: "a description" } });
  // Dirty, so the dialog would ask before closing: that prompt is exactly what must not appear.
  setCode("return context.");

  const host = document.body.querySelector(".cm-editor") as HTMLElement;
  const view = EditorView.findFromDOM(host) as EditorView;
  const content = host.querySelector(".cm-content") as HTMLElement;
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  startCompletion(view);
  await waitFor(() => expect(completionStatus(view.state)).toBe("active"));

  content.dispatchEvent(
    // `cancelable`, as a real keydown is: the fix works by `preventDefault`, which Radix reads back
    // (react-dismissable-layer), and `preventDefault` on a non-cancelable event does nothing.
    new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
  await waitFor(() => expect(completionStatus(view.state)).not.toBe("active"));
  expect(document.body.textContent).not.toContain("Discard changes?");
  // And the body the operator was writing is still there.
  expect(view.state.doc.toString()).toBe("return context.");

  // With nothing open, Escape belongs to the dialog again, which is the half a blanket fix breaks.
  content.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
  await waitFor(() =>
    expect(document.body.textContent).toContain("Discard changes?"),
  );
});

// The defect as the operator meets it: open a tool, touch nothing, press Escape, and be asked
// whether to discard changes. A body stored with CRLF (saved over MCP from a Windows client, or
// carried in by an import) cannot survive CodeMirror, which normalizes line endings on the way in,
// and the normalized text used to come back through `onChange` as if the operator had typed it.
test("a tool stored with CRLF opens clean, and closes without asking", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (
      !/\/code-tools\/1(\?|$)/.test(href) ||
      (init?.method ?? "GET").toUpperCase() !== "GET"
    ) {
      return realFetch(input as RequestInfo, init);
    }
    return new Response(
      JSON.stringify({
        tool: codeTool({ code: "const a = 1;\r\nreturn a;" }),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    render(<TwoToolsHarness />);
    fireEvent.click(screen.getByText("open-1"));
    await waitFor(() =>
      expect(!!document.body.querySelector(".cm-editor")).toBe(true),
    );
    const view = EditorView.findFromDOM(
      document.body.querySelector(".cm-editor") as HTMLElement,
    ) as EditorView;
    // The document is LF, which is CodeMirror's doing and not something to fight.
    await waitFor(() =>
      expect(view.state.doc.toString()).toBe("const a = 1;\nreturn a;"),
    );
    // Nothing was typed, so nothing is dirty: Escape closes instead of asking.
    (document.body.querySelector(".cm-content") as HTMLElement).dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    await waitFor(() =>
      expect(!!document.body.querySelector(".cm-editor")).toBe(false),
    );
    expect(document.body.textContent).not.toContain("Discard changes?");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a body with no return warns without disabling Save", async () => {
  render(<Harness />);
  fireEvent.click(screen.getByText("open"));

  const input = document.body.querySelector("input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "No return" } });
  fireEvent.change(descriptionField(), { target: { value: "a description" } });
  setCode("const x = 1;");

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

test("a save the server warned about says so in the toast, not only under the field", async () => {
  // The dialog closes on save and the next opening clears the warning state, so an operator who
  // saved before the 300 ms debounce drew anything would otherwise read a plain "saved" about a
  // body that will fail when the agent calls it.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (
      href.includes("/code-tools") &&
      (init?.method ?? "GET").toUpperCase() === "POST"
    ) {
      return new Response(
        JSON.stringify({
          tool: codeTool(),
          warnings: [
            { kind: "syntax", line: 1, column: 17, message: "expecting name" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    render(<Harness />);
    fireEvent.click(screen.getByText("open"));
    const label = document.body.querySelector("input") as HTMLInputElement;
    fireEvent.change(label, { target: { value: "Look up CPF" } });
    const description = descriptionField();
    fireEvent.change(description, { target: { value: "a description" } });
    // Saved immediately, before the debounced check has drawn anything.
    setCode("return input.cpf.");
    fireEvent.click(screen.getByText("Save").closest("button") as HTMLElement);
    await waitFor(() =>
      expect(
        screen.queryAllByText(/Line 1, column 17/).length > 0 &&
          screen.queryAllByText(/saved/i).length > 0,
      ).toBe(true),
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("reopening a tool whose body does not parse warns again, without an edit", async () => {
  // The opening clears the warnings, and reopening the same tool leaves the body identical — so an
  // effect keyed only on the text does not rerun and a broken body looks clean until it is typed in.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (/\/code-tools\/\d+/.test(href)) {
      return new Response(
        JSON.stringify({ tool: codeTool({ code: "return input.cpf." }) }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    render(<TwoToolsHarness />);
    fireEvent.click(screen.getByText("open-1"));
    await screen.findByText(/Line \d+, column \d+:/, {}, { timeout: 2000 });
    fireEvent.click(screen.getByText("close-it"));
    fireEvent.click(screen.getByText("open-1"));
    await screen.findByText(/Line \d+, column \d+:/, {}, { timeout: 2000 });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a save that lands after the dialog was dismissed does not close the next one", async () => {
  // Only Cancel is disabled while saving, so Esc/outside/X still dismiss: the continuation would
  // otherwise close the dialog the operator had just reopened (docs/modals.md).
  const realFetch = globalThis.fetch;
  let release = () => {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (
      href.includes("/code-tools") &&
      (init?.method ?? "GET").toUpperCase() === "POST"
    ) {
      await new Promise<void>((r) => {
        release = r;
      });
      return new Response(JSON.stringify({ tool: codeTool(), warnings: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    render(<TwoToolsHarness />);
    fireEvent.click(screen.getByText("open-new"));
    await waitFor(() =>
      expect(document.body.querySelectorAll("input").length > 0).toBe(true),
    );
    const fill = () => {
      const label = document.body.querySelector("input") as HTMLInputElement;
      fireEvent.change(label, { target: { value: "Look up CPF" } });
      fireEvent.change(descriptionField(), {
        target: { value: "a description" },
      });
      setCode("return 1");
    };
    fill();
    fireEvent.click(screen.getByText("Save").closest("button") as HTMLElement);
    await waitFor(() => expect(typeof release).toBe("function"));
    // Dismissed while the save is out, then reopened for another new tool.
    fireEvent.click(screen.getByText("close-it"));
    fireEvent.click(screen.getByText("open-new"));
    await waitFor(() =>
      expect(document.body.querySelectorAll("input").length > 0).toBe(true),
    );
    fill();
    release();
    await new Promise((r) => setTimeout(r, 30));
    // The second dialog is still on screen, with what the operator typed into it.
    const label = document.body.querySelector("input") as HTMLInputElement;
    expect(label?.value).toBe("Look up CPF");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a save that FAILS after the dialog was dismissed does not mark the next one", async () => {
  // A refusal that arrives for a dialog that is gone has nowhere to land, and would put the
  // previous tool's error on the form now open. This drives the RESPONSE branch — the client
  // returns a transport failure as `error` rather than throwing — and the `catch` beside it carries
  // the same guard for the exceptions the client does not convert.
  const realFetch = globalThis.fetch;
  let fail = () => {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (
      href.includes("/code-tools") &&
      (init?.method ?? "GET").toUpperCase() === "POST"
    ) {
      await new Promise<void>((r) => {
        fail = r;
      });
      throw new Error("network is down");
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    render(<TwoToolsHarness />);
    fireEvent.click(screen.getByText("open-new"));
    await waitFor(() =>
      expect(document.body.querySelectorAll("input").length > 0).toBe(true),
    );
    const fill = () => {
      fireEvent.change(
        document.body.querySelector("input") as HTMLInputElement,
        {
          target: { value: "Look up CPF" },
        },
      );
      fireEvent.change(descriptionField(), {
        target: { value: "a description" },
      });
      setCode("return 1");
    };
    fill();
    fireEvent.click(screen.getByText("Save").closest("button") as HTMLElement);
    fireEvent.click(screen.getByText("close-it"));
    fireEvent.click(screen.getByText("open-new"));
    await waitFor(() =>
      expect(document.body.querySelectorAll("input").length > 0).toBe(true),
    );
    fail();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryAllByText(/Could not save/i).length).toBe(0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the parser only runs while the dialog is open", () => {
  // This component stays mounted on the Tools page and the agent editor, and the empty form starts
  // with the starter body — so an ungated effect downloads the parser chunk and parses a body
  // nobody is editing, on every visit to either page. A source fence rather than a module mock:
  // `mock.module` is process-global here and tears down mocks other files installed (the note in
  // document-starters-race.test.tsx), and what is being asserted is one guard's presence.
  const src = readFileSync(
    "src/client/pages/resources/CodeToolEditModal.tsx",
    "utf8",
  );
  const effect = src.slice(
    src.indexOf("const code = form.code;") - 400,
    src.indexOf("const code = form.code;"),
  );
  expect(effect.includes("if (!modal.isOpen) return;")).toBe(true);
});

test("a save in flight cannot be dismissed, and its finally belongs to its own opening", () => {
  // Round 25. Two guards over one hole: a save dismissed with Esc/X and reopened before it answers.
  // The dialog now refuses the dismissal, the rule the test modal beside it already follows
  // (docs/modals.md) and the rule that makes the second guard unreachable from the UI, which is
  // exactly why it is asserted here rather than driven: an unscoped `setSaving(false)` would leave
  // the reopened form disabled with nothing running, for as long as the first request takes.
  // A source fence for the reason the fence above gives.
  const src = readFileSync(
    "src/client/pages/resources/CodeToolEditModal.tsx",
    "utf8",
  );
  expect(src.includes("onCloseRequest={saving ? () => {} : undefined}")).toBe(
    true,
  );
  const saveFn = src.slice(src.indexOf("async function save()"));
  const tail = saveFn.slice(saveFn.indexOf("} finally {"));
  expect(
    tail.startsWith(
      "} finally {\n      if (sessionRef.current === session) setSaving(false);",
    ),
  ).toBe(true);
});

// The starter body's comment is the first console text an author of a code tool reads, so it
// follows the console's language like every label around it. The `return` line does not: that is
// the language's own word. Shipped in English since #517, caught in a browser over a pt-BR form.
test("the starter body speaks the console's language, and its code does not", async () => {
  const en = starterCode(i18n.t);
  expect(en).toContain("return { ok: true };");
  await i18n.changeLanguage("pt-BR");
  const pt = starterCode(i18n.t);
  await i18n.changeLanguage("en");
  // The comment moved.
  expect(pt).not.toBe(en);
  expect(pt.split("\n")[0]).not.toBe(en.split("\n")[0]);
  // The code did not.
  expect(pt).toContain("return { ok: true };");
  // The prose is a comment, so an untranslated line cannot hide as code.
  for (const body of [en, pt]) {
    expect(body.split("\n")[0]?.startsWith("// ")).toBe(true);
  }
});

// Two lines, and the first one earns its place: it names the key that opens the list, which is the
// one thing the editor cannot teach by itself. What it used to say instead (what `input` and
// `context` hold, that the answer is a `return`) is what the completion and the `?` already answer,
// so it was a paragraph about the body the author is about to delete.
//
// ONE key is named, and it is the one the READER's machine delivers: `SHOW_SCOPE_KEY` in
// CodeEditor.tsx carries the keydown log that settled it (macOS eats the whole Ctrl+Space family,
// and Alt-i is the circumflex dead key on a US International layout, so Chrome sends `key: "Dead"`
// with `keyCode: 229`). `Mod-i` is one binding with two names, and printing the wrong one is worse
// than printing none: it is a key the reader can press and watch do nothing. So the assertion is
// that the line names the current platform's name and NOT the other, in both catalogs.
test("the starter body is two lines, and names the platform's key", () => {
  for (const lang of ["en", "pt-BR"] as const) {
    const body = starterCode(i18n.getFixedT(lang));
    const lines = body.trimEnd().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[1]).toBe("return { ok: true };");
    expect(lines[0]).toContain(scopeKeyLabel());
    const other = scopeKeyLabel() === "Ctrl+I" ? "\u2318I" : "Ctrl+I";
    expect(lines[0]).not.toContain(other);
    // And never the keys that measured as unreachable.
    expect(/Ctrl-Space|Alt-i|Alt-`/.test(lines[0] ?? "")).toBe(false);
  }
});

// Both names exist, each is the whole hint on its own platform, and each follows ITS platform's
// typography rather than CodeMirror's: Apple joins modifiers symbolically (⌘I, not ⌘+I or Cmd-I),
// Microsoft spells them and joins with a plus (Ctrl+I, not Ctrl-I). `Mod-i` names the binding and
// is never shown.
test("the key is named per platform, in that platform's notation", () => {
  expect(scopeKeyLabel(true)).toBe("\u2318I");
  expect(scopeKeyLabel(false)).toBe("Ctrl+I");
});
