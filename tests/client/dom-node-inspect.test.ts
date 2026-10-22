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

test("toEqual reports a node in its short form", () => {
  const dialog = pageWithDialog();
  for (const assertion of [
    () => expect<unknown>(dialog).toEqual(null),
    () => expect([dialog]).toEqual([]),
  ]) {
    const { message, ms } = failureOf(assertion);
    expect(message.length).toBeLessThan(2000);
    expect(ms).toBeLessThan(500);
    expect(message).toContain("confirm-delete");
  }
  const negated = failureOf(() => expect(dialog).not.toEqual(dialog));
  expect(negated.message).toContain("Expected: not DomNode");
  expect(negated.message).toContain("confirm-delete");
});

test("the matchers keep their equality around nodes", () => {
  const dialog = pageWithDialog();
  expect(dialog).toEqual(dialog);
  expect([dialog]).toStrictEqual([dialog]);
  expect({ open: dialog, rows: 2000 }).toMatchObject({ open: dialog });
  expect({ open: dialog }).toMatchObject({ open: expect.any(HTMLElement) });
  expect({ open: dialog }).not.toMatchObject({ open: dialog, rows: 1 });
  expect(dialog).not.toEqual(document.createElement("div"));
});

test("values without a node keep the native diff", () => {
  const { message } = failureOf(() => expect({ a: 1 }).toEqual({ a: 2 }));
  expect(message).toContain("- Expected  - 1");
  const strict = failureOf(() =>
    expect<unknown>({ a: undefined }).toStrictEqual({}),
  );
  expect(strict.message).toContain("toStrictEqual");
  expect(
    failureOf(() => expect({ a: 1 }).not.toEqual({ a: 1 })).message,
  ).toContain("Expected: not {");
  expect({ a: 1, b: 2 }).toMatchObject({ a: 1 });
});

test("a key the received value lacks fails toMatchObject with or without a node", () => {
  const dialog = pageWithDialog();
  expect({ a: 1 }).not.toMatchObject({ a: 1, extra: undefined });
  expect({ open: dialog }).not.toMatchObject({
    open: dialog,
    extra: undefined,
  });
  expect([dialog, dialog]).not.toMatchObject([dialog]);
  expect({ open: dialog, extra: undefined }).not.toStrictEqual({
    open: dialog,
  });
});

test("toStrictEqual with a node tells a class instance from a plain object", () => {
  const dialog = pageWithDialog();
  class Box {
    constructor(readonly open: HTMLElement) {}
  }
  expect(new Box(dialog)).toEqual({ open: dialog });
  expect(new Box(dialog)).not.toStrictEqual({ open: dialog });
  const boxed = failureOf(() => expect<unknown>(new Box(dialog)).toEqual(null));
  expect(boxed.message.length).toBeLessThan(2000);
});

test("a fragment names its kind", () => {
  const { message } = failureOf(() =>
    expect(document.createDocumentFragment()).toBeNull(),
  );
  expect(message).toContain("DocumentFragment");
});

test("a node inside a cycle, an asymmetric matcher, a Set or under a symbol keeps native semantics", () => {
  const dialog = pageWithDialog();
  expect(window).toStrictEqual(window);
  const cyclic: Record<string, unknown> = { open: dialog };
  cyclic.self = cyclic;
  expect(cyclic).toStrictEqual(cyclic);
  expect({ open: dialog }).toStrictEqual(
    expect.objectContaining({ open: dialog }),
  );
  expect({ wrap: { open: dialog } }).toEqual({
    wrap: expect.objectContaining({ open: dialog }),
  });
  expect({ open: dialog, n: 1 }).toEqual({
    open: dialog,
    n: expect.any(Number),
  });
  expect({ open: dialog, s: new Set([{ a: undefined }]) }).not.toStrictEqual({
    open: dialog,
    s: new Set([{}]),
  });
  const key = Symbol("k");
  expect({ open: dialog, [key]: 1 }).not.toMatchObject({
    open: dialog,
    [key]: 2,
  });
  expect({ open: dialog, [key]: 1 }).toMatchObject({ open: dialog, [key]: 1 });
});

test("two separate nodes with the same content are equal", () => {
  const a = document.createElement("p");
  const b = document.createElement("p");
  expect([a]).toEqual([b]);
  b.textContent = "changed";
  expect([a]).not.toEqual([b]);
});

test("toEqual decides on the nodes themselves, not on their markup", () => {
  const a = document.createElement("input");
  const b = document.createElement("input");
  a.value = "typed";
  expect(a).not.toEqual(b);
  const { message, ms } = failureOf(() => expect([a]).toEqual([b]));
  expect(message.length).toBeLessThan(2000);
  expect(ms).toBeLessThan(500);
  const key = Symbol("k");
  expect({ open: a, [key]: a }).toEqual({
    open: a,
    [key]: expect.any(HTMLElement),
  });
  const keyed = failureOf(() => expect<unknown>({ [key]: a }).toEqual(null));
  expect(keyed.message.length).toBeLessThan(2000);
});
