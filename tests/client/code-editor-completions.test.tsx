/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { cleanup, render } from "@testing-library/react";
import { CodeEditor, completionsFor } from "@/client/components/CodeEditor";
import i18n from "@/client/lib/i18n";
import enLocale from "@/client/locales/en.json";
import ptLocale from "@/client/locales/pt-BR.json";
import { CODE_TOOL_CONTEXT_VARS } from "@/lib/code-tool-vocabulary";

// What the editor OFFERS, which is the half of issue #538 that pays: highlighting makes a broken
// body easier to see, and completion is what makes the `context` vocabulary discoverable at all.
//
// The completion source is asked directly rather than through a keystroke: driving CodeMirror's
// completion state in happy-dom would measure the debounce and the tooltip, not the rule, and the
// rule is "which names, from where".

afterEach(cleanup);

describe("what `context.` and `input.` complete to", () => {
  test("context offers the vocabulary, whole, with the absent-when on each", () => {
    const got = completionsFor("context", [], i18n.t);
    expect(got.map((c) => c.label).sort()).toEqual(
      CODE_TOOL_CONTEXT_VARS.map((v) => v.name).sort(),
    );
    // `detail` is the operator's cue for whether the body needs a `??`, so the optional ones have
    // to be marked as optional and the three that are always there must not be.
    const detail = new Map(got.map((c) => [c.label, c.detail]));
    expect(detail.get("agent_name")).toBe("string");
    expect(detail.get("contact_email")).toBe("string?");
    expect(detail.get("conversationAttributes")).toBe("object");
    // The description reaches the popup, or the completion is a list of names again.
    expect(got.every((c) => (c.info as string)?.length > 20)).toBe(true);
  });

  // The arguments come from the PANEL, live, so a rename is offered before any save. A stale list
  // would be a second source of truth about the same form.
  test("input offers exactly the declared arguments, and nothing when none are declared", () => {
    expect(
      completionsFor("input", ["cpf", "valor"], i18n.t).map((c) => c.label),
    ).toEqual(["cpf", "valor"]);
    expect(completionsFor("input", [], i18n.t)).toEqual([]);
  });

  // The two are not the same list, which is the whole point: `input.` must not offer conversation
  // variables the arguments never carry.
  test("the two sources do not bleed into each other", () => {
    const input = completionsFor("input", ["cpf"], i18n.t).map((c) => c.label);
    expect(input).not.toContain("contact_name");
    const context = completionsFor("context", ["cpf"], i18n.t).map(
      (c) => c.label,
    );
    expect(context).not.toContain("cpf");
  });
});

describe("the editor the operator actually gets", () => {
  test("it mounts, holds the body, and is labelled where the role is", () => {
    render(
      <CodeEditor
        value="return { ok: true };"
        onChange={() => {}}
        aria-label="Code"
      />,
    );
    const content = document.body.querySelector(".cm-content");
    expect(content).not.toBeNull();
    expect(content?.textContent).toBe("return { ok: true };");
    // The label goes on the element CodeMirror gives the textbox role to. On the wrapper it would
    // be dropped by the accessibility tree, and the field would read as unlabelled.
    expect(content?.getAttribute("role")).toBe("textbox");
    expect(content?.getAttribute("aria-label")).toBe("Code");
  });

  test("a change reaches onChange as the whole document", () => {
    let seen = "";
    render(
      <CodeEditor
        value="return 1;"
        onChange={(v) => {
          seen = v;
        }}
        aria-label="Code"
      />,
    );
    const host = document.body.querySelector(".cm-editor") as HTMLElement;
    const view = EditorView.findFromDOM(host);
    view?.dispatch({ changes: { from: 9, insert: "\nreturn 2;" } });
    expect(seen).toBe("return 1;\nreturn 2;");
  });

  // A value written from OUTSIDE is not an edit the operator made, so Ctrl-Z must not resurrect what
  // it replaced: the form resetting, or a body arriving from the server, would otherwise sit in the
  // undo stack and hand the previous tool's code back to a form that is no longer about it.
  test("an external value change is not undoable", () => {
    const { rerender } = render(
      <CodeEditor value="return 1;" onChange={() => {}} aria-label="Code" />,
    );
    const host = document.body.querySelector(".cm-editor") as HTMLElement;
    const view = EditorView.findFromDOM(host) as EditorView;
    // An edit of the operator's own first, so the history is not empty and undo has somewhere to go.
    view.dispatch({ changes: { from: 9, insert: " // mine" } });
    rerender(
      <CodeEditor value="return 2;" onChange={() => {}} aria-label="Code" />,
    );
    expect(view.state.doc.toString()).toBe("return 2;");
    undo(view);
    undo(view);
    expect(view.state.doc.toString()).toBe("return 2;");
  });

  // The cap the browser enforces on a textarea's `maxLength`, enforced here as a REFUSAL: a paste
  // that would overflow leaves the document as it was rather than landing half a line.
  test("a change past maxLength is refused, and an over-cap value still edits DOWN", () => {
    render(
      <CodeEditor
        value="abc"
        onChange={() => {}}
        maxLength={5}
        aria-label="Code"
      />,
    );
    const host = document.body.querySelector(".cm-editor") as HTMLElement;
    const view = EditorView.findFromDOM(host) as EditorView;
    view.dispatch({ changes: { from: 3, insert: "defghij" } });
    expect(view.state.doc.toString()).toBe("abc");
    view.dispatch({ changes: { from: 3, insert: "de" } });
    expect(view.state.doc.toString()).toBe("abcde");

    cleanup();
    // A value that ARRIVED past the cap (imported, or written through the API before the cap
    // existed) has to open and has to shorten, or the operator cannot fix it from here.
    render(
      <CodeEditor
        value="abcdefghij"
        onChange={() => {}}
        maxLength={5}
        aria-label="Code"
      />,
    );
    const host2 = document.body.querySelector(".cm-editor") as HTMLElement;
    const view2 = EditorView.findFromDOM(host2) as EditorView;
    view2.dispatch({ changes: { from: 0, to: 3, insert: "" } });
    expect(view2.state.doc.toString()).toBe("defghij");
  });
});

// An argument name is not required to be a JavaScript identifier: `schemaFromAiFields` only trims
// it and the service stores a `z.record(z.string())`, so `order-id` is declarable and reaches the
// model as that key. Completing it after the dot would write `input.order-id`, which parses as a
// subtraction and silently computes something else.
describe("a name that is not an identifier completes to a subscript", () => {
  function applyInto(value: string, name: string, from: number, to: number) {
    render(
      <CodeEditor
        value={value}
        onChange={() => {}}
        argumentNames={[name]}
        aria-label="Code"
      />,
    );
    const host = document.body.querySelector(".cm-editor") as HTMLElement;
    const view = EditorView.findFromDOM(host) as EditorView;
    const option = completionsFor("input", [name], i18n.t)[0];
    const apply = option?.apply as (
      v: EditorView,
      c: typeof option,
      f: number,
      t: number,
    ) => void;
    if (typeof apply !== "function") throw new Error("no bracket apply");
    apply(view, option, from, to);
    return view.state.doc.toString();
  }

  test("the dot is eaten and the name is quoted", () => {
    expect(applyInto("input.", "order-id", 6, 6)).toBe('input["order-id"]');
  });

  test("what was already typed after the dot goes with it", () => {
    expect(applyInto("input.ord", "order-id", 6, 9)).toBe('input["order-id"]');
  });

  // `input?["x"]` is a conditional expression with no branches, not an access, so the `?.` of an
  // optional chain is the one dot that must survive.
  test("an optional chain keeps its `?.`", () => {
    expect(applyInto("input?.", "first name", 7, 7)).toBe(
      'input?.["first name"]',
    );
  });

  test("a quote in the name is escaped rather than closing the string", () => {
    expect(applyInto("input.", 'sa"id', 6, 6)).toBe('input["sa\\"id"]');
  });

  // The ordinary name still completes the ordinary way: `input.cpf`, no subscript, no `apply`.
  test("an identifier is left to the default dotted insert", () => {
    expect(completionsFor("input", ["cpf"], i18n.t)[0]?.apply).toBeUndefined();
    expect(completionsFor("input", ["_a$1"], i18n.t)[0]?.apply).toBeUndefined();
  });
});

// The popup is console text, and the console is bilingual. The vocabulary module stays English
// because `code_tool_schema` serves it over MCP; what the operator reads goes through `t()`, and
// this is the fence that keeps the two copies equal in English and present in pt-BR.
describe("the popup speaks the console's language", () => {
  const en = enLocale.codeTools.completion;
  const pt = ptLocale.codeTools.completion;
  const enContext: Record<string, string> = en.context;
  const ptContext: Record<string, string> = pt.context;

  test("every context variable has a key, and the English one IS the vocabulary's sentence", () => {
    expect(Object.keys(enContext).sort()).toEqual(
      CODE_TOOL_CONTEXT_VARS.map((v) => v.name).sort(),
    );
    for (const v of CODE_TOOL_CONTEXT_VARS) {
      expect([v.name, enContext[v.name]]).toEqual([v.name, v.description]);
    }
  });

  test("pt-BR carries all of them, translated", () => {
    for (const v of CODE_TOOL_CONTEXT_VARS) {
      expect([v.name, typeof ptContext[v.name]]).toEqual([v.name, "string"]);
      expect([v.name, ptContext[v.name] === v.description]).toEqual([
        v.name,
        false,
      ]);
    }
  });

  test("the argument and root entries are translated too", () => {
    const keys = [
      "argumentDetail",
      "argumentInfo",
      "contextRoot",
      "inputRoot",
    ] as const;
    for (const key of keys) {
      expect([key, typeof en[key]]).toEqual([key, "string"]);
      expect([key, pt[key]]).not.toEqual([key, en[key]]);
    }
  });

  // The switch has to reach a popup that is already mounted: the completion source closes over `t`,
  // so nothing would change language until the modal was reopened.
  test("switching the language changes what the source would offer", async () => {
    const beforeContext = completionsFor("context", [], i18n.t)[0]?.info;
    const beforeArg = completionsFor("input", ["cpf"], i18n.t)[0];
    await i18n.changeLanguage("pt-BR");
    const afterContext = completionsFor("context", [], i18n.t)[0]?.info;
    const afterArg = completionsFor("input", ["cpf"], i18n.t)[0];
    await i18n.changeLanguage("en");
    expect(afterContext).toBe(ptContext.conversation_id);
    expect(afterContext).not.toBe(beforeContext);
    // The argument entries are the other half, and a hardcoded English string there reads as
    // correct in every test that only ever runs in English.
    expect([afterArg?.detail, afterArg?.info]).toEqual([
      pt.argumentDetail,
      pt.argumentInfo,
    ]);
    expect([beforeArg?.detail, beforeArg?.info]).toEqual([
      en.argumentDetail,
      en.argumentInfo,
    ]);
  });
});
