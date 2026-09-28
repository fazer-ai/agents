/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import { undo } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, cleanup, render } from "@testing-library/react";
import { CodeMirrorField } from "@/client/components/CodeMirrorField";

// The shell is the field without a language. `CodeMirrorField` holds what is generic (the view,
// the cap, the height); `CodeEditor` adds the JavaScript grammar and completion, and is fenced by
// `code-editor-completions.test.tsx`. This file drives the seam: the two ways a caller can silently
// cost the operator their cursor and undo history, and the one way the shell could smuggle a
// caller's words back in.

afterEach(cleanup);

function viewNow(): EditorView {
  return EditorView.findFromDOM(
    document.body.querySelector(".cm-editor") as HTMLElement,
  ) as EditorView;
}

// A cap is a number plus two sentences, and only the number reaches the view. The object is a fresh
// identity on every render of the caller, so building the view against it would rebuild the editor
// (cursor at the start, undo history gone) whenever the caller re-renders.
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

// The language reconfigures, it does not rebuild: listing the extensions as a dependency of the
// build would throw the editor away mid-keystroke when the caller passes new ones.
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

// And the words are the caller's, which is the point of the prop: the shell counts characters but
// cannot name what is counted. Driven rather than read off the source, because only a rendered
// string reports anything.
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

// And the field has a ceiling, or the document decides how tall the form is: `minHeight` alone
// grows with the content. Asserted on the wrapper's style, because happy-dom has no layout.
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

// And a caller that writes at the caret needs the view: in CodeMirror an insertion is a dispatch.
// Handed over rather than reached for with `EditorView.findFromDOM`, which would couple the caller
// to this component's markup. The `null` on unmount matters: dispatching into a destroyed view
// throws.
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
