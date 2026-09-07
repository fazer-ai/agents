/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import { undo } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, cleanup, render } from "@testing-library/react";
import { CodeMirrorField } from "@/client/components/CodeMirrorField";

// THE SHELL IS THE FIELD WITHOUT A LANGUAGE (issue #562).
//
// `CodeEditor` was the console's only CodeMirror, and everything in it was written for one caller:
// the JavaScript grammar, the completion over declared arguments, and the two sentences that report
// the code tool's character cap. The sample response wants the same field with a different grammar,
// so what is generic moved into `CodeMirrorField` and what is about JavaScript stayed behind.
//
// The 90 tests of `code-editor-completions` are the fence for that move being behaviour-preserving:
// they drive `CodeEditor` and none of them changed. What they cannot see is the seam itself, which
// is what this file drives — the two ways a caller can silently cost the operator their cursor and
// their undo history, and the one way the shell could smuggle a caller's words back in.

afterEach(cleanup);

function viewNow(): EditorView {
  return EditorView.findFromDOM(
    document.body.querySelector(".cm-editor") as HTMLElement,
  ) as EditorView;
}

// A CAP IS A NUMBER PLUS TWO SENTENCES, AND ONLY THE NUMBER REACHES THE VIEW.
//
// The cap travels as one object so that a cap cannot be set without the words that report it. But an
// object is a fresh identity on every render of the caller, and the view is built against the cap:
// depending on the object rebuilds the editor whenever the caller re-renders — a new view holding
// the same text, with the cursor at the start and the undo history gone. The number is what the
// change filter needs, so the number is what the editor is built against.
test("a caller that rebuilds its cap object keeps the same view, with its history", () => {
  const capFor = (max: number) => ({
    max,
    overLimit: (excess: number) => `over by ${excess}`,
    refused: (excess: number) => `refused by ${excess}`,
  });
  const { rerender } = render(
    <CodeMirrorField
      value=""
      onChange={() => {}}
      cap={capFor(100)}
      aria-label="Field"
    />,
  );
  const first = viewNow();
  act(() => {
    first.dispatch({ changes: { from: 0, insert: "hello" } });
  });

  // The same cap, spelled by a caller that did not memoize it.
  rerender(
    <CodeMirrorField
      value=""
      onChange={() => {}}
      cap={capFor(100)}
      aria-label="Field"
    />,
  );
  const second = viewNow();
  expect(second).toBe(first);
  undo(second);
  expect(second.state.doc.toString()).toBe("");
});

// THE LANGUAGE RECONFIGURES, IT DOES NOT REBUILD.
//
// This is the seam the code tool already depends on — renaming a declared argument reconfigures the
// completion source under a mounted editor — generalized to whatever the caller passes. Listing the
// extensions as a lifecycle dependency of the build would answer the same rename by throwing the
// editor away mid-keystroke.
test("changing the extensions keeps the same view, with its history", () => {
  const { rerender } = render(
    <CodeMirrorField
      value=""
      onChange={() => {}}
      extensions={[javascript()] as Extension}
      aria-label="Field"
    />,
  );
  const first = viewNow();
  act(() => {
    first.dispatch({ changes: { from: 0, insert: '{"a": 1}' } });
  });

  rerender(
    <CodeMirrorField
      value=""
      onChange={() => {}}
      extensions={[json()] as Extension}
      aria-label="Field"
    />,
  );
  const second = viewNow();
  expect(second).toBe(first);
  undo(second);
  expect(second.state.doc.toString()).toBe("");
});

// AND THE WORDS ARE THE CALLER'S, WHICH IS THE POINT OF THE PROP.
//
// The shell counts characters; it cannot name what is being counted. Left inside, the code tool's
// "Shorten the body" would greet an operator whose sample response is too long. Driven rather than
// read off the source, because a string the shell never renders is a string that does not report
// anything.
test("the over-limit line is the caller's sentence, not one of the shell's", () => {
  render(
    <CodeMirrorField
      value="abcdef"
      onChange={() => {}}
      cap={{
        max: 4,
        overLimit: (excess, max) => `SAMPLE over by ${excess} of ${max}`,
        refused: () => "unused here",
      }}
      aria-label="Field"
    />,
  );
  expect(document.body.textContent).toContain("SAMPLE over by 2 of 4");
});

// AND THE FIELD HAS A CEILING, or the document decides how tall the form is (round 4 of review).
//
// `minHeight` alone means the editor grows with its content, so a response with a thousand records
// makes a field a thousand lines tall and pushes everything under it off the screen. The textarea it
// replaced had `rows`, which is a bounded viewport that scrolls inside itself. Asserted on the style
// the wrapper carries, because happy-dom has no layout to measure.
test("a maximum height reaches the editor, and is absent when not asked for", () => {
  render(
    <CodeMirrorField
      value=""
      onChange={() => {}}
      minHeight="6rem"
      maxHeight="24rem"
      aria-label="Field"
    />,
  );
  const host = document.body.querySelector(".cm-editor")
    ?.parentElement as HTMLElement;
  expect(host.style.getPropertyValue("--code-max-h")).toBe("24rem");
  expect(host.className).toContain("max-h-");

  // A SECOND mount, not a rerender of the first: `cleanup` unmounts the root, and rerendering an
  // unmounted one throws instead of asserting anything.
  cleanup();
  render(
    <CodeMirrorField
      value=""
      onChange={() => {}}
      minHeight="6rem"
      aria-label="Field"
    />,
  );
  const bare = document.body.querySelector(".cm-editor")
    ?.parentElement as HTMLElement;
  expect(bare?.className ?? "").not.toContain("max-h-");
});

// AND A CALLER THAT WRITES AT THE CARET NEEDS THE VIEW (issue #563).
//
// The template field keeps the picker #462 shipped, which inserts a token where the cursor is. In a
// textarea that is `selectionStart` and a string splice; in CodeMirror it is a dispatch, and the
// caller cannot make one without the view. Handed over rather than reached for: the alternative is
// `EditorView.findFromDOM` on a query the caller writes, which is a second, silent coupling to this
// component's markup.
//
// The `null` on unmount is the half that matters: a caller holding a destroyed view dispatches into
// nothing, and CodeMirror throws rather than ignoring it.
test("the view is handed to the caller, and taken back when it goes", () => {
  const seen: (EditorView | null)[] = [];
  const { unmount } = render(
    <CodeMirrorField
      value=""
      onChange={() => {}}
      onView={(v) => seen.push(v)}
      aria-label="Field"
    />,
  );
  expect(seen).toHaveLength(1);
  expect(seen[0]).toBe(viewNow());
  act(() => {
    (seen[0] as EditorView).dispatch({ changes: { from: 0, insert: "x" } });
  });
  expect(viewNow().state.doc.toString()).toBe("x");

  unmount();
  expect(seen.at(-1)).toBeNull();
});

// A FRESH LAMBDA IS NOT A NEW EDITOR. The caller writes this inline, so it is a new function on
// every render; depending on it would rebuild the editor per keystroke of the form around it.
test("a caller that rebuilds its callback keeps the same view", () => {
  const { rerender } = render(
    <CodeMirrorField
      value=""
      onChange={() => {}}
      onView={() => {}}
      aria-label="Field"
    />,
  );
  const first = viewNow();
  rerender(
    <CodeMirrorField
      value=""
      onChange={() => {}}
      onView={() => {}}
      aria-label="Field"
    />,
  );
  expect(viewNow()).toBe(first);
});
