import { afterEach, expect, test } from "bun:test";

// tests/dom-setup.ts gives happy-dom nodes a one-line inspect form. Without it, a failing assertion
// that receives a node pretty-prints the node, its document and the window, which takes seconds and
// hundreds of millions of characters on every `waitFor` attempt, and past some size bun reports the
// assertion as passed.

afterEach(() => {
  document.body.innerHTML = "";
});

function failureOf(assertion: () => void): { message: string; ms: number } {
  const start = performance.now();
  try {
    assertion();
  } catch (error) {
    return { message: (error as Error).message, ms: performance.now() - start };
  }
  throw new Error("the assertion passed");
}

function pageWithDialog(): HTMLElement {
  document.body.innerHTML = "";
  for (let i = 0; i < 2000; i++) {
    const row = document.createElement("div");
    row.textContent = `row ${i}`;
    document.body.append(row);
  }
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.id = "confirm-delete";
  dialog.setAttribute("aria-label", "Delete source");
  document.body.append(dialog);
  return dialog;
}

test("a failing assertion on an element names it in one short line", () => {
  const dialog = pageWithDialog();
  const { message, ms } = failureOf(() => expect(dialog).toBeNull());
  expect(message.length).toBeLessThan(2000);
  expect(ms).toBeLessThan(500);
  expect(message).toContain(
    '<div role="dialog" id="confirm-delete" aria-label="Delete source">',
  );
});

test("every kind of node and the window format short", () => {
  pageWithDialog();
  const detached = document.createElement("section");
  for (let i = 0; i < 500; i++) detached.append(document.createElement("p"));
  const fragment = document.createDocumentFragment();
  fragment.append(document.createElement("i"), document.createElement("b"));
  const values: unknown[] = [
    document,
    window,
    document.body,
    document.createTextNode("hello"),
    document.createComment("note"),
    fragment,
    detached,
    [...document.body.children].slice(0, 50),
  ];
  for (const value of values) {
    const { message, ms } = failureOf(() => expect(value).toBeNull());
    expect(message.length).toBeLessThan(5000);
    expect(ms).toBeLessThan(500);
  }
});

test("text, comments and long attributes stay recognizable and bounded", () => {
  const text = failureOf(() =>
    expect(document.createTextNode("hello")).toBeNull(),
  );
  expect(text.message).toContain('#text "hello"');
  const comment = failureOf(() =>
    expect(document.createComment("note")).toBeNull(),
  );
  expect(comment.message).toContain("<!--note-->");
  const crowded = document.createElement("img");
  for (let i = 0; i < 40; i++)
    crowded.setAttribute(`data-a${i}`, "x".repeat(5000));
  const { message } = failureOf(() => expect(crowded).toBeNull());
  expect(message).toContain('<img data-a0="');
  expect(message.length).toBeLessThan(2000);
});

test("a value that only looks like a node keeps its usual form", () => {
  const { message } = failureOf(() =>
    expect({ nodeType: 1, tagName: "FAKE", mark: "plain-object" }).toBeNull(),
  );
  expect(message).toContain("plain-object");
});
