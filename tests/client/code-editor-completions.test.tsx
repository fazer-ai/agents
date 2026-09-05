/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { EditorView } from "@codemirror/view";
import { cleanup, render } from "@testing-library/react";
import { CodeEditor, completionsFor } from "@/client/components/CodeEditor";
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
    const got = completionsFor("context", []);
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
      completionsFor("input", ["cpf", "valor"]).map((c) => c.label),
    ).toEqual(["cpf", "valor"]);
    expect(completionsFor("input", [])).toEqual([]);
  });

  // The two are not the same list, which is the whole point: `input.` must not offer conversation
  // variables the arguments never carry.
  test("the two sources do not bleed into each other", () => {
    const input = completionsFor("input", ["cpf"]).map((c) => c.label);
    expect(input).not.toContain("contact_name");
    const context = completionsFor("context", ["cpf"]).map((c) => c.label);
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
