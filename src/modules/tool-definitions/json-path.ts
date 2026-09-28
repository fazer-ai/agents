// The path grammar an operator writes to point INTO an HTTP tool's response, and the walk that
// resolves one. Deliberately not JSONPath: the grammar is one sentence, not a second language.
//
// The appointment declaration and the response template disagree about what a path may END on (an
// appointment id cannot be `false`; a template must render it), so each brings its own
// `ScalarReader`. The grammar and the walk are shared, so the picker (`sampleLeaves`) never offers a
// leaf the caller's own reader then refuses.

const PATH_SEGMENT = /^[A-Za-z0-9_$-]+$/;

export function isUsablePath(p: unknown): p is string {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    p.length <= 200 &&
    p.split(".").every((seg) => PATH_SEGMENT.test(seg))
  );
}

// What a caller accepts at the end of a path. Returns the rendered value, or undefined for "this is
// not something a path may end on" — the same answer for both readers, over different sets.
export type ScalarReader = (node: unknown) => string | undefined;

// The node a path addresses, unread. `undefined` for a path that does not resolve (indistinguishable
// from an undefined value, which JSON cannot hold). OWN properties only, so it addresses exactly what
// `collectLeaves` offers (`Object.keys`): the picker and the reader must agree.
export function walkPath(body: unknown, path: string): unknown {
  let cur: unknown = body;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = Array.isArray(cur)
      ? /^\d+$/.test(seg)
        ? cur[Number(seg)]
        : undefined
      : Object.hasOwn(cur as object, seg)
        ? (cur as Record<string, unknown>)[seg]
        : undefined;
  }
  return cur;
}

export interface SampleLeaf {
  path: string;
  value: string;
}

export interface SampleList {
  path: string;
  length: number;
}

// Every LIST in a sample response, with its length, so the operator picks the one to repeat over.
// Same walk, key filter and caps as `collectLeaves`, so the picker offers only what the reader can
// address. A response that IS a list is offered as `.`, which only the template reader knows.
export function collectLists(root: unknown, max = 50): SampleList[] {
  const out: SampleList[] = [];
  const walk = (node: unknown, path: string, depth: number): void => {
    if (out.length >= max || depth > 10) return;
    if (Array.isArray(node)) {
      if (path === "" || isUsablePath(path)) {
        out.push({ path: path === "" ? "." : path, length: node.length });
      }
      for (let i = 0; i < node.length; i++) {
        if (out.length >= max) break;
        walk(node[i], path === "" ? String(i) : `${path}.${i}`, depth + 1);
      }
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const k of Object.keys(node)) {
        if (out.length >= max) break;
        if (!PATH_SEGMENT.test(k)) continue;
        walk(
          (node as Record<string, unknown>)[k],
          path === "" ? k : `${path}.${k}`,
          depth + 1,
        );
      }
    }
  };
  walk(root, "", 0);
  return out;
}

// Every place in a sample response a path could point AT, in document order, so the operator picks a
// path instead of typing one: a well-formed path aimed at the wrong key passes every check and finds
// nothing. Both filters mirror the reader: the VALUE must be one the caller's `scalar` returns, and
// every KEY must fit the segment grammar on its own BEFORE joining (a key literally named `a.b`
// would join into a path that walks somewhere else). Bounded, since a sample is pasted by hand.
export function collectLeaves(
  root: unknown,
  scalar: ScalarReader,
  max = 200,
): SampleLeaf[] {
  const out: SampleLeaf[] = [];
  const walk = (node: unknown, path: string, depth: number): void => {
    if (out.length >= max || depth > 10) return;
    // Both loops BREAK rather than letting each walk return: the cap has to stop the traversal, not
    // just the pushing. A pasted response with a 50k-row array would otherwise still be enumerated
    // end to end, in the browser, while the operator waits — and Object.entries would allocate the
    // whole entry array first. The cap is only a bound if reaching it ends the work.
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        if (out.length >= max) break;
        walk(node[i], path === "" ? String(i) : `${path}.${i}`, depth + 1);
      }
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const k of Object.keys(node)) {
        if (out.length >= max) break;
        // The whole subtree goes with the key: nothing under an unaddressable key is addressable.
        if (!PATH_SEGMENT.test(k)) continue;
        walk(
          (node as Record<string, unknown>)[k],
          path === "" ? k : `${path}.${k}`,
          depth + 1,
        );
      }
      return;
    }
    const value = scalar(node);
    // isUsablePath still answers for the LENGTH cap, which is a property of the whole path.
    if (value !== undefined && isUsablePath(path)) out.push({ path, value });
  };
  walk(root, "", 0);
  return out;
}
