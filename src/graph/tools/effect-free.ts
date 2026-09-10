import type { StructuredToolInterface } from "@langchain/core/tools";

// WHETHER RUNNING THIS TOOL A SECOND TIME COSTS ANYTHING, carried by the tool OBJECT rather than by
// its name (issue #568, review round 29).
//
// The observer's tick is at-most-once for effects: a tick that already invoked an effect-bearing
// tool does not retry, because the effect reached somebody else's system and cannot be taken back.
// A tool that leaves nothing behind is exempt, and the exemption has to name the tool somehow.
//
// A NATIVE's name is its identity — the assembly reserves every native name whether the native was
// built or not (unique-names.ts, #457), so nothing else can answer under it. `search_knowledge` is
// NOT a native: it is a RAG built-in, its name is reserved by neither the assembly nor an older
// tenant row, and the RAG tools are assembled LAST, so a legacy HTTP or code tool carrying that
// name wins it and reaches the model in its place. Exempting it by name would hand the exemption
// to whatever that row does, an HTTP POST included.
//
// So the RAG search tool is marked where it is BUILT, and the mark travels with the object. Both
// wrappers a tool can pick up on the way to the model — the precondition guard and the tick's own
// counter — are `Object.create(inner)`, so the mark is inherited through the prototype chain
// without either of them knowing about it. A wrapper that ever stops delegating has to carry it.
//
// `Symbol.for` rather than a fresh symbol: two copies of this module in one process (a bundler, a
// test importing through two paths) would otherwise mint two symbols and the mark would read as
// absent on the far side, which fails toward "counts as an effect" and silently costs the retry.
export const EFFECT_FREE_TOOL = Symbol.for("fazerai.tool.effectFree");

export function markEffectFree<T extends StructuredToolInterface>(t: T): T {
  (t as unknown as Record<symbol, boolean>)[EFFECT_FREE_TOOL] = true;
  return t;
}

export function isEffectFreeTool(t: { name: string }): boolean {
  return (t as unknown as Record<symbol, unknown>)[EFFECT_FREE_TOOL] === true;
}

// A CALL THAT WENT NOWHERE, reported by the handler that refused it (review round 36).
//
// The tick counts a dispatch as committed BEFORE invoking, because the count has to exist when the
// invoke THREW. Several exits then make that count wrong in the same way: a precondition that was
// not met, and the fence every effect-bearing handler asks again INSIDE itself — after its own read,
// before its own write — refuse without writing anything. Some return a sentence, one throws
// (`ToolpackCalledOffError`), and a counter outside cannot tell any of them from a call that ran.
//
// So the handler says so, through a callback the caller threads in, the same way `onSideEffectError`
// is threaded. A callback rather than a mark on the result: the thrown case has no result to mark,
// and one channel that covers every exit beats two that each cover half.
//
// WHAT MUST NOT CALL IT: an exit where something already left. `handoff_to_human` refusing after its
// private note was filed, and an HTTP tool refusing after its acknowledgement was sent, are both
// calls that did something — the retry would do it again.
export type NoEffectReporter = () => void;
