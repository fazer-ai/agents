/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import {
  CompletionContext,
  completionStatus,
  currentCompletions,
  startCompletion,
} from "@codemirror/autocomplete";
import { undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { cleanup, render } from "@testing-library/react";
import {
  CodeEditor,
  completionsFor,
  namesKeyOf,
  sourceFor,
} from "@/client/components/CodeEditor";
import { handOverEscape } from "@/client/components/escapeClaim";
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

  // The counter `<Textarea>` renders, which the body lost when it moved off one. It matters MORE
  // here, because the filter below refuses the edit instead of clamping the value: without a
  // counter the field simply stops accepting characters and says nothing about why.
  test("the counter appears near the cap and marks a body already past it", () => {
    const { rerender } = render(
      <CodeEditor
        value={"x".repeat(79)}
        onChange={() => {}}
        maxLength={100}
        aria-label="Code"
      />,
    );
    const counted = () =>
      [...document.body.querySelectorAll("span")]
        .map((n) => n.textContent ?? "")
        .filter((tx) => /^\d+\/100$/.test(tx));
    // Below the threshold the field looks like any other.
    expect(counted()).toEqual([]);
    rerender(
      <CodeEditor
        value={"x".repeat(80)}
        onChange={() => {}}
        maxLength={100}
        aria-label="Code"
      />,
    );
    expect(counted()).toEqual(["80/100"]);
    rerender(
      <CodeEditor
        value={"x".repeat(101)}
        onChange={() => {}}
        maxLength={100}
        aria-label="Code"
      />,
    );
    expect(counted()).toEqual(["101/100"]);
    // And the editor HOLDS it. The cap refuses an edit, and a write from the prop is not an edit:
    // refusing one would leave the counter saying 101 over a document still holding 80, and the
    // next keystroke would write that stale text back over a value never shown.
    const view = EditorView.findFromDOM(
      document.body.querySelector(".cm-editor") as HTMLElement,
    ) as EditorView;
    expect(view.state.doc.length).toBe(101);
    // A body that ARRIVED past the cap has to say what it costs: the save is refused, not clamped.
    const over = [...document.body.querySelectorAll("span")].find((n) =>
      /over the limit/.test(n.textContent ?? ""),
    );
    expect(over?.textContent).toContain("1 character");
    expect(over?.className).toContain("text-error");
  });

  // The over-limit line is the only thing on screen that says why the body cannot be saved, so it
  // has to reach the accessibility tree the way `<Textarea>`'s does. Both attributes go on the
  // contenteditable, which is where the `textbox` role is; on the wrapper they would be dropped.
  test("an over-limit body is announced as invalid, with the reason attached", () => {
    const { rerender } = render(
      <CodeEditor
        value={"x".repeat(50)}
        onChange={() => {}}
        maxLength={100}
        aria-label="Code"
      />,
    );
    const content = () => document.body.querySelector(".cm-content");
    expect(content()?.getAttribute("aria-invalid")).toBeNull();
    rerender(
      <CodeEditor
        value={"x".repeat(101)}
        onChange={() => {}}
        maxLength={100}
        aria-label="Code"
      />,
    );
    expect(content()?.getAttribute("aria-invalid")).toBe("true");
    const described = content()?.getAttribute("aria-describedby") ?? "";
    expect(described).not.toBe("");
    // The id actually names the message, rather than pointing at nothing.
    const target = document.getElementById(described.split(/\s+/)[0] as string);
    expect(target?.textContent ?? "").toContain("over the limit");
  });

  // A refusal the FORM decided is the other half of the same attribute, and it is the case that
  // never had one: `invalid` reached the border and stopped there.
  test("the invalid prop reaches the textbox too", () => {
    render(
      <CodeEditor
        value="return 1;"
        onChange={() => {}}
        invalid
        aria-label="Code"
      />,
    );
    expect(
      document.body.querySelector(".cm-content")?.getAttribute("aria-invalid"),
    ).toBe("true");
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

// `matchBefore` matches a SUFFIX of the line, so any expression ENDING in one of the two names hits
// the same regex: `mycontext.` is one identifier, `config.input.` is somebody else's member, and
// offering this sandbox's vocabulary there writes code about the wrong object.
describe("only the root `context` and `input` complete", () => {
  function ask(doc: string) {
    const state = EditorState.create({ doc });
    return sourceFor(
      ["cpf"],
      i18n.t,
    )(new CompletionContext(state, doc.length, true));
  }

  test("the root variables still complete, dotted and bare", () => {
    expect(ask("context.")?.options.map((o) => o.label)).toContain(
      "contact_name",
    );
    expect(ask("return input.")?.options.map((o) => o.label)).toEqual(["cpf"]);
    expect(ask("  context?. co")?.options.map((o) => o.label)).toContain(
      "contact_name",
    );
    expect(ask("const x = con")?.options.map((o) => o.label)).toEqual([
      "context",
      "input",
    ]);
  });

  test("a longer identifier ending in the same letters offers nothing", () => {
    expect(ask("mycontext.")).toBeNull();
    expect(ask("my_input.")).toBeNull();
    expect(ask("$context.")).toBeNull();
  });

  test("a member of something else offers nothing", () => {
    expect(ask("config.input.")).toBeNull();
    expect(ask("a.b.context.")).toBeNull();
    expect(ask("payload?.context.")).toBeNull();
    // The bare-word branch has the same hole: after a dot, `context` and `input` are not in scope.
    expect(ask("obj.con")).toBeNull();
  });
});

// The list identity the reconfigure effect keys on. An argument name is not required to be an
// identifier, so it can hold whatever separator a join would use: two different lists that collapse
// to one key leave `input.` offering names the panel no longer declares, and nothing on screen says
// the completion is stale.
describe("the key that decides a rename happened", () => {
  test("lists that a join would confuse stay distinct", () => {
    expect(namesKeyOf(["first name", "age"])).not.toBe(
      namesKeyOf(["first", "name age"]),
    );
    expect(namesKeyOf(["a,b"])).not.toBe(namesKeyOf(["a", "b"]));
    expect(namesKeyOf(['say "hi"', "x"])).not.toBe(namesKeyOf(['say "hi" x']));
  });

  // And the component has to USE it. Driving CodeMirror's own completion is the only way to see the
  // reconfigure land: the source is closed over by the compartment, so a rename that the effect did
  // not notice leaves the editor offering the previous names with nothing on screen saying so.
  test("a rename between two lists that collide on a join still reoffers", async () => {
    async function offered(view: EditorView) {
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      startCompletion(view);
      await new Promise((r) => setTimeout(r, 200));
      return currentCompletions(view.state)
        .map((c) => c.label)
        .sort();
    }
    const { rerender } = render(
      <CodeEditor
        value="input."
        onChange={() => {}}
        argumentNames={["first name", "age"]}
        aria-label="Code"
      />,
    );
    const view = EditorView.findFromDOM(
      document.body.querySelector(".cm-editor") as HTMLElement,
    ) as EditorView;
    view.focus();
    expect(await offered(view)).toEqual(["age", "first name"]);
    rerender(
      <CodeEditor
        value="input."
        onChange={() => {}}
        argumentNames={["first", "name age"]}
        aria-label="Code"
      />,
    );
    expect(await offered(view)).toEqual(["first", "name age"]);
  });

  test("the same list is the same key, and order is part of it", () => {
    expect(namesKeyOf(["cpf", "valor"])).toBe(namesKeyOf(["cpf", "valor"]));
    expect(namesKeyOf(["cpf", "valor"])).not.toBe(namesKeyOf(["valor", "cpf"]));
    expect(namesKeyOf([])).toBe(namesKeyOf([]));
  });
});

// Escape is the standard key for dismissing a suggestion, and this editor lives in a dialog that
// closes on Escape. Radix hears the press first (capture phase on `document`), so the editor cannot
// stop it: it CLAIMS the press, and `<Modal>` turns the claim into the `preventDefault` Radix reads
// back. Measured in a browser before this existed: dismissing a suggestion opened "Discard
// changes?" over a body the operator was still writing.
describe("who owns Escape while the popup is open", () => {
  function mount(value: string) {
    render(
      <CodeEditor
        value={value}
        onChange={() => {}}
        argumentNames={["cpf"]}
        aria-label="Code"
      />,
    );
    const view = EditorView.findFromDOM(
      document.body.querySelector(".cm-editor") as HTMLElement,
    ) as EditorView;
    return { view, content: document.body.querySelector(".cm-content") };
  }

  test("a press inside the editor is claimed only while a completion is active", async () => {
    const { view, content } = mount("return context.");
    // Nothing open: the dialog keeps Escape, which is how a modal is meant to close.
    expect(handOverEscape(content)).toBe(false);

    view.dispatch({ selection: { anchor: view.state.doc.length } });
    startCompletion(view);
    await new Promise((r) => setTimeout(r, 200));
    expect(completionStatus(view.state)).toBe("active");
    expect(handOverEscape(content)).toBe(true);
    // Answering the claim also CLOSES the popup, because the press it answered was the press meant
    // to close it: reporting alone would leave the suggestion on screen and swallow the key.
    await new Promise((r) => setTimeout(r, 50));
    expect(completionStatus(view.state)).not.toBe("active");
    expect(handOverEscape(content)).toBe(false);
  });

  // The debounce window. CodeMirror reports `"pending"` from the moment a trigger is typed until the
  // query settles, and an operator typing `context.` reaches Escape well inside it: claiming only
  // `"active"` hands that press to the dialog, which asks whether to discard the body over a popup
  // that had not finished arriving.
  test("a press during the debounce is claimed too", async () => {
    const { view, content } = mount("return context.");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    startCompletion(view);
    expect(completionStatus(view.state)).toBe("pending");
    expect(handOverEscape(content)).toBe(true);
    // Answering it cancels the pending query rather than leaving one to open after the press.
    await new Promise((r) => setTimeout(r, 250));
    expect(completionStatus(view.state)).toBeNull();
  });

  test("a press outside this editor is not this editor's to claim", async () => {
    const { view } = mount("return context.");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    startCompletion(view);
    await new Promise((r) => setTimeout(r, 200));
    expect(completionStatus(view.state)).toBe("active");
    expect(handOverEscape(document.body)).toBe(false);
  });

  // The claim is released on unmount, or it would answer for a node that is gone and the dialog
  // would stop closing on Escape with nothing on screen explaining why.
  test("unmounting gives Escape back", async () => {
    const { view, content } = mount("return context.");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    startCompletion(view);
    await new Promise((r) => setTimeout(r, 200));
    expect(completionStatus(view.state)).toBe("active");
    // NOT consulted before unmounting, on purpose: consulting closes the popup, and the claim would
    // then answer `false` for that reason instead of for the release, which is a test that passes
    // whether or not the release exists. Destroying a view leaves its last state behind, so a claim
    // that outlived its editor still reads "active" and still owns the key.
    cleanup();
    expect(handOverEscape(content)).toBe(false);
  });
});
