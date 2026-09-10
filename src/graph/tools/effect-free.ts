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

// A CALL THAT WAS REFUSED BEFORE IT RAN, marked on the RESULT rather than on the tool: the tool is
// effect-bearing, this particular call just never reached its handler (a precondition that was not
// met or could not be read, a fence that answered no while the state was read). The observer's tick
// counts an invocation as committed BEFORE dispatching, because the count has to exist when the
// invoke THREW — so a refusal has to be able to take that count back, and it can only say so on the
// way out (review round 33).
//
// In `additional_kwargs` for the reason `skip_reply` puts its own mark there: it is out of reach of
// any text a tool or a model can produce, so nothing that merely reads like a refusal is one.
export const REFUSED_BEFORE_RUN = "fazer_refused_before_run";

export function markRefusedBeforeRun<T>(message: T): T {
  const m = message as { additional_kwargs?: Record<string, unknown> };
  if (m && typeof m === "object" && m.additional_kwargs)
    m.additional_kwargs[REFUSED_BEFORE_RUN] = true;
  return message;
}

export function wasRefusedBeforeRun(result: unknown): boolean {
  const m = result as { additional_kwargs?: Record<string, unknown> } | null;
  return m && typeof m === "object"
    ? m.additional_kwargs?.[REFUSED_BEFORE_RUN] === true
    : false;
}
