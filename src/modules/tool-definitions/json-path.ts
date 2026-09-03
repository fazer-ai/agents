// The path grammar an operator writes to point INTO an HTTP tool's response, and the walk that
// resolves one. Deliberately not JSONPath: the whole surface an operator has to learn is one
// sentence, and a filter expression would be a second language inside a text field.
//
// WHY THE WALK IS HERE AND THE SCALAR RULE IS NOT. Two features read a response by path — the
// appointment declaration (#352) and the response template (#456) — and they disagree about what a
// path may END on, for reasons that are each right on their own side. An appointment id may not be
// a boolean and may not be the empty string; a template that cannot render `"active": false` would
// hand the model a blank where the answer was "no", which is the exact invention #456 exists to
// remove. What they do NOT disagree about is the grammar and the traversal, and those were the
// parts worth having one copy of: a key named literally `a.b`, a numeric segment against an object,
// an inherited property, the depth and width caps — every one of those is a place where two copies
// would drift silently.
//
// So each caller brings its own `ScalarReader` and gets, from the same walk, both the resolver and
// the leaf list for its picker. That pairing is the invariant `sampleLeaves` was written for and is
// the reason it is here rather than duplicated: a picker that offers a leaf its own reader then
// refuses is worse than no picker.

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

// The node a path addresses, unread. `undefined` for a path that does not resolve at all, which the
// callers cannot distinguish from a key whose value IS undefined — and do not need to: JSON has no
// undefined, and every body these read came out of JSON.parse.
//
// OWN properties only. Nothing on Object.prototype is a scalar today, so no prototype path actually
// resolves — measured, and `constructor.name` returns undefined because the intermediate is a
// function and the guard above already refuses one. The check is here for the divergence rather
// than the exploit: `collectLeaves` offers what `Object.keys` yields, which is own properties, so
// without this the two readers of the same question disagree about what a path may address, and
// that disagreement is exactly what the picker exists to remove.
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

// Every LIST in a sample response, with how long it is, so the operator picks the one to repeat
// over instead of typing its path (#459). Same walk, same key filter and same caps as
// `collectLeaves`, for the same reason: what the picker offers has to be what the reader can
// address. A response that IS a list is offered as `.`, the one path this module's grammar does
// not spell, because only the template reader knows the scope by that name.
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

// Every place in a sample response that a path could point AT, in document order, so the operator
// picks a path instead of typing one. Typing is where the expensive mistake lives: the gates in the
// form catch a MALFORMED path, and nothing catches a well-formed path aimed at the wrong key —
// `data.id` where the field is `data.appointment.id` passes every check and simply finds nothing,
// at which point nothing happens and the operator has no idea why.
//
// Both filters mirror a reader rather than a taste, which is the property that makes the offer
// trustworthy:
//
//   - the VALUE has to be one the CALLER's `scalar` returns, so whatever that reader refuses is
//     absent here too, exactly as it would be at read time;
//   - every KEY between here and the root has to fit the segment grammar on its own, checked before
//     the segments are joined. Joining destroys the evidence: a key named literally `a.b` yields the
//     path `a.b`, which isUsablePath accepts (it splits on the dot and both halves are fine) while
//     walkPath walks it as body.a.b — a different place entirely. Checking the assembled path is
//     therefore not the same check, and it is the one that would have shipped the exact silent
//     mis-aim this picker exists to remove.
//
// Bounded on both axes: a sample is pasted by hand, and a response with thousands of rows would
// otherwise render thousands of buttons.
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
