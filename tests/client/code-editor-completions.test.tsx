/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CompletionContext,
  closeCompletion,
  completionStatus,
  currentCompletions,
  startCompletion,
} from "@codemirror/autocomplete";
import { undo } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, cleanup, render } from "@testing-library/react";
import {
  CodeEditor,
  completionsFor,
  hoverInfo,
  namesKeyOf,
  scopeKeyLabel,
  sourceFor,
} from "@/client/components/CodeEditor";
import { handOverEscape } from "@/client/components/escapeClaim";
import i18n from "@/client/lib/i18n";
import enLocale from "@/client/locales/en.json";
import ptLocale from "@/client/locales/pt-BR.json";
import {
  CODE_TOOL_CONTEXT_VARS,
  CODE_TOOL_GLOBALS,
} from "@/lib/code-tool-vocabulary";

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

  // Measured against the sibling field in the same modal: a real paste of 2 500 characters into
  // `<textarea maxLength={2000}>` lands 2 000 of them, so the browser TRIMS. This editor refuses
  // instead, because a JavaScript body missing its tail saves clean and fails when the agent calls
  // it, and the refusal is announced by the test below.
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
    act(() => {
      view.dispatch({ changes: { from: 3, insert: "defghij" } });
    });
    expect(view.state.doc.toString()).toBe("abc");
    act(() => {
      view.dispatch({ changes: { from: 3, insert: "de" } });
    });
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

  // The counter covers a body already NEAR the cap. A paste onto a short body is the case it does
  // not cover, and it is the ordinary one: the operator drops in a body from somewhere, nothing
  // lands, and there is no counter, no message and no error on screen to say a limit exists. So
  // the refusal speaks for itself, and brings the counter out with it.
  test("a refused change says so, on a body far below the counter's threshold", () => {
    render(
      <CodeEditor
        value="abc"
        onChange={() => {}}
        maxLength={100}
        aria-label="Code"
      />,
    );
    const spans = () =>
      [...document.body.querySelectorAll("span")].map(
        (n) => n.textContent ?? "",
      );
    const refusal = () => spans().find((tx) => /Nothing was inserted/.test(tx));
    // Three characters against a hundred: nothing on screen mentions a cap.
    expect(spans().filter((tx) => /^\d+\/100$/.test(tx))).toEqual([]);
    expect(refusal()).toBeUndefined();

    const view = EditorView.findFromDOM(
      document.body.querySelector(".cm-editor") as HTMLElement,
    ) as EditorView;
    act(() => {
      view.dispatch({ changes: { from: 3, insert: "x".repeat(98) } });
    });
    expect(view.state.doc.toString()).toBe("abc");
    // What was refused, in the terms the operator can act on: how much has to come off.
    expect(refusal()).toContain("1 character over the 100 limit");
    // And the counter, which is the field's own state, is no longer hidden behind the threshold.
    expect(spans().filter((tx) => /^\d+\/100$/.test(tx))).toEqual(["3/100"]);
  });

  // A refusal is an EVENT, not a property of the field: it describes the change that did not land.
  // Left on screen it would sit there accusing an edit the operator already made room for.
  test("the refusal clears on the next change that fits", () => {
    render(
      <CodeEditor
        value="abc"
        onChange={() => {}}
        maxLength={100}
        aria-label="Code"
      />,
    );
    const refusal = () =>
      [...document.body.querySelectorAll("span")].find((n) =>
        /Nothing was inserted/.test(n.textContent ?? ""),
      );
    const view = EditorView.findFromDOM(
      document.body.querySelector(".cm-editor") as HTMLElement,
    ) as EditorView;
    act(() => {
      view.dispatch({ changes: { from: 3, insert: "x".repeat(98) } });
    });
    expect(refusal()).toBeDefined();
    // It is a live region, so a screen reader hears it without moving to the field.
    expect(refusal()?.getAttribute("role")).toBe("status");
    act(() => {
      view.dispatch({ changes: { from: 3, insert: "de" } });
    });
    expect(view.state.doc.toString()).toBe("abcde");
    expect(refusal()).toBeUndefined();
  });

  // CodeMirror splits an incoming document on `\r\n?|\n` and re-serializes with `\n`, so a body
  // stored with CRLF (saved over MCP from a Windows client, or imported) can never be held as it
  // was written. The sync effect then sees a document that differs from the prop and writes the
  // prop in again, and reporting THAT through `onChange` hands the form a string it never chose:
  // the tool is dirty the moment it opens, and Escape offers to discard changes nobody made.
  test("a controlled write is not reported back as an edit", () => {
    const seen: string[] = [];
    render(
      <CodeEditor
        value={"const a = 1;\r\nreturn a;"}
        onChange={(v) => seen.push(v)}
        aria-label="Code"
      />,
    );
    const view = EditorView.findFromDOM(
      document.body.querySelector(".cm-editor") as HTMLElement,
    ) as EditorView;
    // The document itself is normalized, which is CodeMirror's, not ours to prevent.
    expect(view.state.doc.toString()).toBe("const a = 1;\nreturn a;");
    // The form is told nothing, because nobody edited anything.
    expect(seen).toEqual([]);
  });

  // The control for the test above: an edit the operator makes is still reported, or the field
  // would be write-only.
  test("and a real edit still is", () => {
    const seen: string[] = [];
    render(
      <CodeEditor
        value="abc"
        onChange={(v) => seen.push(v)}
        aria-label="Code"
      />,
    );
    const view = EditorView.findFromDOM(
      document.body.querySelector(".cm-editor") as HTMLElement,
    ) as EditorView;
    act(() => {
      view.dispatch({ changes: { from: 3, insert: "de" } });
    });
    expect(seen).toEqual(["abcde"]);
  });

  // The placeholder is console text, so it follows a language switch, and the completion source
  // already reconfigures for exactly that event rather than rebuilding. The placeholder was the one
  // that still tore the editor down: the operator switching the console to English mid-body would
  // get a new view, losing the cursor, the selection and the undo history behind it.
  test("a placeholder change keeps the editor, with its history", () => {
    const { rerender } = render(
      <CodeEditor
        value=""
        onChange={() => {}}
        placeholder="antes"
        aria-label="Code"
      />,
    );
    const placeholderText = () =>
      document.body.querySelector(".cm-placeholder")?.textContent ?? null;
    expect(placeholderText()).toBe("antes");
    const first = EditorView.findFromDOM(
      document.body.querySelector(".cm-editor") as HTMLElement,
    ) as EditorView;
    act(() => {
      first.dispatch({ changes: { from: 0, insert: "return 1;" } });
    });
    rerender(
      <CodeEditor
        value=""
        onChange={() => {}}
        placeholder="depois"
        aria-label="Code"
      />,
    );
    const second = EditorView.findFromDOM(
      document.body.querySelector(".cm-editor") as HTMLElement,
    ) as EditorView;
    // The SAME view: not a new one that happens to hold the same text.
    expect(second).toBe(first);
    // And its history came with it, which is what a rebuild silently throws away.
    undo(second);
    expect(second.state.doc.toString()).toBe("");
    expect(placeholderText()).toBe("depois");
  });

  // A body written in by the FORM is exempt from the cap (that is what opens an over-cap tool for
  // editing), so it must not be reported as a refusal either — and it retires one already on
  // screen, which described a paste against the body being replaced.
  test("a controlled write is not a refusal, and retires the one on screen", () => {
    const { rerender } = render(
      <CodeEditor
        value="abc"
        onChange={() => {}}
        maxLength={100}
        aria-label="Code"
      />,
    );
    const refusal = () =>
      [...document.body.querySelectorAll("span")].find((n) =>
        /Nothing was inserted/.test(n.textContent ?? ""),
      );
    const view = EditorView.findFromDOM(
      document.body.querySelector(".cm-editor") as HTMLElement,
    ) as EditorView;
    act(() => {
      view.dispatch({ changes: { from: 3, insert: "x".repeat(98) } });
    });
    expect(refusal()).toBeDefined();
    rerender(
      <CodeEditor
        value={"y".repeat(101)}
        onChange={() => {}}
        maxLength={100}
        aria-label="Code"
      />,
    );
    expect(view.state.doc.length).toBe(101);
    expect(refusal()).toBeUndefined();
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

  // The spacing the matcher allows reaches here too: the dot AND the whitespace after it are what
  // the subscript replaces, or accepting `order-id` would leave `input. ["order-id"]`.
  test("the whitespace after the dot goes with it", () => {
    expect(applyInto("input.  ", "order-id", 8, 8)).toBe('input["order-id"]');
  });

  test("and an optional chain keeps its `?.` across the gap", () => {
    expect(applyInto("input?.  ", "first name", 9, 9)).toBe(
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

  // The same fence for the globals half. Only the four the sandbox installs carry a sentence, and
  // that sentence exists TWICE: in the vocabulary, which `code_tool_schema` serves to a model in
  // English, and under `t()`, which is what the operator reads. Equal in English or the two drift
  // in silence, since nothing else compares them.
  test("the described globals carry the vocabulary's sentence, in both catalogs", () => {
    const described = CODE_TOOL_GLOBALS.filter((g) => g.description);
    expect(described.map((g) => g.name)).toEqual([
      "TIMEZONE",
      "NOW_LOCAL",
      "console",
      "Date",
    ]);
    const enGlobal: Record<string, string> = en.global;
    const ptGlobal: Record<string, string> = pt.global;
    expect(Object.keys(enGlobal).sort()).toEqual(
      described.map((g) => g.name).sort(),
    );
    for (const g of described) {
      expect([g.name, enGlobal[g.name]]).toEqual([g.name, g.description]);
      expect([g.name, typeof ptGlobal[g.name]]).toEqual([g.name, "string"]);
      expect([g.name, ptGlobal[g.name] === g.description]).toEqual([
        g.name,
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
  // With the language, because the editor always has it and the guard below reads the syntax tree:
  // a state without `javascript()` parses to nothing and would answer every question the same way.
  function ask(doc: string) {
    const state = EditorState.create({ doc, extensions: [javascript()] });
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
    // The two parameters lead the root list; the sandbox globals follow them (see the scope tests
    // below), so this pins the head rather than the whole list.
    expect(
      ask("const x = con")
        ?.options.map((o) => o.label)
        .slice(0, 2),
    ).toEqual(["context", "input"]);
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

// The dot is what makes the offer cheap, and it is also what a string and a comment are full of.
// `console.log("context.")` is not a member access, and neither is a note the operator left for
// themselves: completing there offers this sandbox's vocabulary about text, and accepting an entry
// rewrites the quoted words. The language is already loaded for the highlighting, so the parse is
// there to be asked.
describe("text is not code: no completion inside a string or a comment", () => {
  function ask(doc: string) {
    const state = EditorState.create({ doc, extensions: [javascript()] });
    return sourceFor(
      ["cpf"],
      i18n.t,
    )(new CompletionContext(state, doc.length, true));
  }

  const quiet: Array<[string, string]> = [
    ["an argument being logged", 'console.log("context.'],
    // A pattern is not code either, and lezer gives it a node of its own: the operator writing
    // `/input./` is describing characters to match, not reading a field.
    ["a regexp being typed", "const re = /input."],
    ["a finished regexp", "const re = /input./"],
    ["a finished string", 'const s = "context.'],
    ["a single-quoted one", "const s = 'input."],
    ["a template with no hole", "const s = `context."],
    ["a line comment", "// context."],
    ["a block comment", "/* context."],
    ["a bare word inside a string", 'const s = "cont'],
  ];
  for (const [name, doc] of quiet) {
    test(name, () => {
      expect(ask(doc)).toBeNull();
    });
  }

  // A slash is division far more often than it is a pattern, and lezer tells the two apart. This is
  // the case the guard must NOT take with it.
  test("but a division is code, and still completes", () => {
    expect(ask("const x = a / input.")?.options.length).toBeGreaterThan(0);
  });

  // The hole in a template IS code, and the commonest place a body builds a message from a
  // variable. Blocking the whole template string would take this with it.
  test("but the hole in a template string completes", () => {
    expect(
      ask("const s = `hi ${context.")?.options.map((o) => o.label),
    ).toContain("contact_name");
  });
});

// Ctrl-Space is how an operator asks what exists, and the blank body is where they most need to
// ask. `matchBefore` needs at least one character, so it answered `null` there and the source
// returned nothing: the one affordance for discovering `context` and `input` was silent at the
// moment it was for. The dead `word.from === word.to` branch is what the original intent looked
// like, and this is it, working.
describe("Ctrl-Space on nothing still offers the two roots", () => {
  function ask(doc: string, explicit: boolean) {
    const state = EditorState.create({ doc, extensions: [javascript()] });
    return sourceFor(
      ["cpf"],
      i18n.t,
    )(new CompletionContext(state, doc.length, explicit));
  }
  const labels = (r: ReturnType<ReturnType<typeof sourceFor>>) =>
    r?.options.map((o) => o.label) ?? null;

  test("an explicit request on an empty body offers them", () => {
    // The two parameters lead, and the sandbox globals follow them: the assertion is about the
    // position answering at all, which is what was silent before.
    expect(labels(ask("", true))?.slice(0, 2)).toEqual(["context", "input"]);
  });

  test("and after a space, where the next word would go", () => {
    expect(labels(ask("return ", true))?.slice(0, 2)).toEqual([
      "context",
      "input",
    ]);
    expect(ask("return ", true)?.from).toBe(7);
  });

  // Typing whitespace is not a request: the popup must not appear on its own.
  test("but typing a space opens nothing", () => {
    expect(ask("return ", false)).toBeNull();
  });

  // And an explicit request is still not a licence to describe somebody else's object: after
  // `foo.` the two roots would be offered as MEMBERS of `foo`.
  test("and an explicit request after another object's dot offers nothing", () => {
    expect(ask("foo.", true)).toBeNull();
  });

  // A word being typed is a root position, so the list comes back and CodeMirror filters it: that
  // is how `co` narrows to `context`, and it is why the check above has to be about the DOT.
  test("while a word being typed is still a root", () => {
    expect(labels(ask("co", true))?.slice(0, 2)).toEqual(["context", "input"]);
  });
});

// The hotkey is meant to answer "what can I write here", and it answered with two names: the two
// parameters. Everything else in scope was invisible, because `override` REPLACES the language's
// own sources rather than adding to them, and the sandbox's own globals were in no list at all.
describe("the hotkey lists what is in scope, not just the two roots", () => {
  function ask(doc: string) {
    const state = EditorState.create({ doc, extensions: [javascript()] });
    return sourceFor(
      ["cpf"],
      i18n.t,
    )(new CompletionContext(state, doc.length, true));
  }
  const labels = (doc: string) => ask(doc)?.options.map((o) => o.label) ?? [];

  test("the sandbox's own globals are offered", () => {
    const all = labels("");
    expect(all).toContain("context");
    expect(all).toContain("input");
    for (const name of ["TIMEZONE", "NOW_LOCAL", "console", "Date"]) {
      expect(all).toContain(name);
    }
    // And the standard library an operator reaches for in twenty lines.
    for (const name of ["JSON", "Math", "Number", "parseInt"]) {
      expect(all).toContain(name);
    }
  });

  // The four the sandbox installs itself are the ones nobody can guess, so they carry the sentence
  // that says what they hold; `JSON` does not, and that asymmetry is the decision, not an omission.
  test("and the four this sandbox adds explain themselves", () => {
    const options = ask("")?.options ?? [];
    const at = (label: string) => options.find((o) => o.label === label);
    expect(at("TIMEZONE")?.info).toBeDefined();
    expect(at("Date")?.info).toBeDefined();
    expect(at("JSON")?.info).toBeUndefined();
    // Every global says where it comes from, which is what separates it from a local.
    expect(at("JSON")?.detail).toBe("sandbox");
  });

  // A name the OPERATOR declared is the other half of "what is in scope", and it is the half a
  // custom `override` silently drops: passing sources there REPLACES the language's own, including
  // the `localCompletionSource` that ships with it and reads the same tree. Driven through the
  // mounted editor rather than by calling that source directly, because what is being tested is the
  // composition: calling it by hand passes with the editor configured either way.
  test("a variable the operator declared completes", async () => {
    render(
      <CodeEditor
        value={"const meuValor = 1;\nmeuV"}
        onChange={() => {}}
        aria-label="Code"
      />,
    );
    const view = EditorView.findFromDOM(
      document.body.querySelector(".cm-editor") as HTMLElement,
    ) as EditorView;
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    startCompletion(view);
    await new Promise((r) => setTimeout(r, 200));
    expect(currentCompletions(view.state).map((c) => c.label)).toContain(
      "meuValor",
    );
  });
});

// The hotkey the console advertises. CodeMirror ships Ctrl-Space plus Alt-i/Alt-` on macOS, and on
// a Mac none of the three arrives: macOS keeps Ctrl-Space for the input-source switcher, and on a US
// International layout Alt-i is the circumflex DEAD key, so Chrome delivers `key: "Dead"` and a
// keymap that matches on the key name has nothing to match. The operator saw a list that opened
// while they typed and could not be reopened, which reads as a broken editor rather than as a
// keyboard layout. The events below are the ones the OS actually produces.
describe("the advertised hotkey opens the list", () => {
  function mount() {
    render(<CodeEditor value="" onChange={() => {}} aria-label="Code" />);
    const view = EditorView.findFromDOM(
      document.body.querySelector(".cm-editor") as HTMLElement,
    ) as EditorView;
    return view;
  }

  function press(view: EditorView, init: KeyboardEventInit) {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  }

  // `Mod-i` is ⌘I on a Mac and Ctrl-I everywhere else, so the chord pressed here is the one THIS
  // platform binds, taken from the same predicate the label uses. Both arrive as `key: "i"` with
  // `keyCode: 73`, which is what separates them from the dead key below.
  const mac = scopeKeyLabel() === "\u2318I";
  const modI = {
    key: "i",
    code: "KeyI",
    keyCode: 73,
    ...(mac ? { metaKey: true } : { ctrlKey: true }),
  };

  test("the Mod-i chord does, and the Mac dead key does not", async () => {
    const view = mount();
    press(view, modI);
    await new Promise((r) => setTimeout(r, 200));
    expect(currentCompletions(view.state).length).toBeGreaterThan(0);

    closeCompletion(view);
    await new Promise((r) => setTimeout(r, 50));
    expect(currentCompletions(view.state).length).toBe(0);

    // What ⌥I sends on a US International layout: the keymap sees "Dead", not "i".
    press(view, { key: "Dead", code: "KeyI", keyCode: 73, altKey: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(currentCompletions(view.state).length).toBe(0);
  });

  // Closing the list has to leave it reopenable, which is the half the operator reported: the popup
  // came up on its own while typing and never came back after it was dismissed.
  test("and it reopens after the list was closed", async () => {
    const view = mount();
    const open = async () => {
      press(view, modI);
      await new Promise((r) => setTimeout(r, 200));
      return currentCompletions(view.state).length;
    };
    expect(await open()).toBeGreaterThan(0);
    closeCompletion(view);
    await new Promise((r) => setTimeout(r, 50));
    expect(await open()).toBeGreaterThan(0);
  });
});

// What the POINTER answers. The rule is that hover and the list are one object: whatever the list
// would have offered for that name is what the tooltip renders, so the two cannot drift into saying
// different things about `contact_email`. And the question goes to the parser for the same reason
// the completion's does, which is why `mycontext.contact_id` answers nothing.
describe("hover answers with the completion the list would have offered", () => {
  function ask(doc: string, at: number) {
    const state = EditorState.create({ doc, extensions: [javascript()] });
    return hoverInfo(state, at, ["cpf", "order-id"], i18n.t);
  }
  // The index of the first character of `needle`, plus one, which lands INSIDE the word.
  const inside = (doc: string, needle: string) => doc.indexOf(needle) + 1;

  test("a context variable carries its type and whether it can be absent", () => {
    const doc = "return context.contact_email;";
    const hit = ask(doc, inside(doc, "contact_email"));
    expect(hit?.completion.label).toBe("contact_email");
    // `string?` is the whole point: it is what decides whether the body needs a `??`.
    expect(hit?.completion.detail).toBe("string?");
    expect(String(hit?.completion.info)).toContain("mail");
    // The range covers the NAME, so the tooltip points at the word and not at the whole expression.
    expect(doc.slice(hit?.from ?? 0, hit?.to ?? 0)).toBe("contact_email");
  });

  test("the one that is always there says so", () => {
    const doc = "context.agent_name";
    expect(ask(doc, inside(doc, "agent_name"))?.completion.detail).toBe(
      "string",
    );
  });

  test("a declared argument, including the one that needs a subscript", () => {
    const doc = "input.cpf";
    expect(ask(doc, inside(doc, "cpf"))?.completion.label).toBe("cpf");
    const bracket = 'input["order-id"]';
    expect(ask(bracket, inside(bracket, "order-id"))?.completion.label).toBe(
      "order-id",
    );
  });

  test("the two roots and a sandbox global", () => {
    for (const [doc, label] of [
      ["context.contact_id", "context"],
      ["input.cpf", "input"],
      ["return TIMEZONE;", "TIMEZONE"],
      ["JSON.stringify(1)", "JSON"],
    ] as const) {
      expect(ask(doc, inside(doc, label))?.completion.label).toBe(label);
    }
  });

  // The tests above ask `hoverInfo` directly, and removing the hover from the editor's extensions
  // leaves every one of them green: the same hole the local-completion test had, one file over. A
  // hover cannot be driven here, though, and that was measured rather than assumed: happy-dom
  // answers `posAtCoords` with 0 and CodeMirror's hover plugin still renders nothing, because it
  // needs real geometry to decide what the pointer is over. So this is a source fence, for the
  // reason the fences in CodeToolEditModal.test.tsx give, and what it asserts is the WIRING: the
  // hover rides in the same extension the completion does, which is what makes a renamed argument
  // reach both on one dispatch.
  test("the hover is actually installed, in the completion's own compartment", () => {
    const src = readFileSync("src/client/components/CodeEditor.tsx", "utf8");
    const ext = src.slice(
      src.indexOf("function completionExt("),
      src.indexOf("function completionExt(") + 900,
    );
    expect(ext.includes("scopeHover(names, t)")).toBe(true);
  });

  test("and nothing at all for a name this editor does not know", () => {
    // The look-alike the completion's root rule exists for: it ENDS in `context` without being it.
    const doc = "mycontext.contact_id";
    expect(ask(doc, inside(doc, "contact_id"))).toBeNull();
    expect(ask(doc, inside(doc, "mycontext"))).toBeNull();
    // A field nobody declared, and a name outside the vocabulary.
    expect(
      ask("input.whatever", inside("input.whatever", "whatever")),
    ).toBeNull();
    expect(ask("const x = 1;", inside("const x = 1;", "x"))).toBeNull();
  });
});

// The matcher allows whitespace on both sides of the dot, and then the range it returned started
// at the dot, so CodeMirror filtered the list by a query beginning with spaces. Nothing matches
// that, so an operator who typed `context. co` saw no popup at all while `context.co` worked:
// half-supporting the spacing is worse than not allowing it, because the offer is silently empty.
describe("the range starts at the NAME, not at the dot", () => {
  // What CodeMirror will filter the options by: everything from `from` to the cursor.
  function query(doc: string) {
    const state = EditorState.create({ doc, extensions: [javascript()] });
    const r = sourceFor(
      ["cpf"],
      i18n.t,
    )(new CompletionContext(state, doc.length, true));
    return r ? doc.slice(r.from) : null;
  }

  test("whitespace after the dot is not part of the query", () => {
    expect(query("context.co")).toBe("co");
    expect(query("context.  co")).toBe("co");
    expect(query("context?. co")).toBe("co");
    expect(query("context. ")).toBe("");
  });
});

// An argument name is any string the operator declares, and this console is written in Portuguese:
// `ação` is an ordinary field name here. The offer opened on `input.` and then vanished at the
// `\u00e7`, because the matcher and its `validFor` were ASCII, so the operator saw the list they
// wanted disappear exactly as they typed the letter that identifies it.
describe("an accented argument name stays filterable", () => {
  function ask(doc: string) {
    const state = EditorState.create({ doc, extensions: [javascript()] });
    return sourceFor(
      ["a\u00e7\u00e3o", "cpf"],
      i18n.t,
    )(new CompletionContext(state, doc.length, true));
  }

  test("the list survives the accented character", () => {
    expect(ask("input.")?.options.map((o) => o.label)).toContain(
      "a\u00e7\u00e3o",
    );
    expect(ask("input.a")?.options.map((o) => o.label)).toContain(
      "a\u00e7\u00e3o",
    );
    expect(ask("input.a\u00e7")?.options.map((o) => o.label)).toContain(
      "a\u00e7\u00e3o",
    );
    expect(ask("input.a\u00e7\u00e3")?.options.map((o) => o.label)).toContain(
      "a\u00e7\u00e3o",
    );
  });

  // `validFor` is what lets CodeMirror keep filtering without asking again, so an ASCII-only one
  // ends the session at the same character even when the query above would have answered.
  test("and the range it stays valid for accepts them too", () => {
    const r = ask("input.a\u00e7");
    expect(r?.validFor).toBeDefined();
    const validFor = r?.validFor as RegExp;
    expect(validFor.test("a\u00e7\u00e3o")).toBe(true);
  });
});

// What separates the sandbox's `context` from a name that merely ENDS in it, in every spelling the
// look-back has been wrong about: a non-ASCII letter before it (`\w` is ASCII and a JavaScript
// identifier is not), a private-field `#`, and a member dot on the other side of a space. Each one
// offered this sandbox's members for somebody else's object.
describe("what is a root, and what is somebody else's member", () => {
  function ask(doc: string) {
    const state = EditorState.create({ doc, extensions: [javascript()] });
    return sourceFor(
      ["cpf"],
      i18n.t,
    )(new CompletionContext(state, doc.length, true));
  }

  // The whitespace the matcher tolerates after a dot cuts both ways: with `config. context.` the
  // character before the name is a SPACE, so a one-character look-back called it a root and offered
  // this sandbox's members for somebody else's object. Skipping the whitespace is not enough on its
  // own either, because `return context.` also has a space there and IS a root: what disqualifies
  // the name is a member operator on the other side of the gap, never an identifier across it.
  for (const doc of [
    "config. context.",
    "obj?. con",
    "config.  input.",
    "a.b. context.",
    // A comment is trivia between the dot and the property, and the character walk stopped at the
    // slash and called what followed a variable.
    "config./*x*/ context.",
    "config. /* still a member */ input.",
    // A member access split across lines: `matchBefore` never leaves the line, so the walk saw a
    // newline, called it a boundary, and offered.
    "config.\ncontext.",
    // And the name in a position where it is being DECLARED rather than read, which is every node
    // the grammar has other than a reference: only `VariableName` is one, which is why the check
    // names what it accepts instead of listing what it refuses.
    "const context.",
    "class A { context.",
  ]) {
    test(`${doc} is a member of something else`, () => {
      expect(ask(doc)).toBeNull();
    });
  }

  for (const doc of ["return context.", "  context.", "} context."]) {
    test(`${doc} is still a root`, () => {
      expect(ask(doc)?.options.length).toBeGreaterThan(0);
    });
  }

  // `#` is not an identifier character, but as a PREDECESSOR it says the name is a private field:
  // `this.#context` is one member of somebody's class, not this sandbox's `context`.
  for (const doc of [
    "\u00e9context.",
    "ma\u00e7input.",
    "\u4e0acontext.",
    "class A { #context = {}; m() { return this.#context.",
  ]) {
    test(`${doc} is not a root`, () => {
      expect(ask(doc)).toBeNull();
    });
  }

  test("and the roots themselves still answer", () => {
    expect(ask("context.")?.options.length).toBeGreaterThan(0);
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
