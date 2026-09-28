import type { StructuredToolInterface } from "@langchain/core/tools";

// Whether running this tool a second time costs anything, carried by the tool OBJECT rather than
// its name: the observer's tick does not retry after an effect-bearing tool ran, and exempts tools
// that leave nothing behind. `search_knowledge` is a RAG built-in whose name is reserved nowhere and
// assembled LAST, so a legacy HTTP row with that name would inherit a by-name exemption. The mark
// rides the prototype through both wrappers (`Object.create(inner)`); a wrapper that stops
// delegating must carry it. `Symbol.for`, so two module copies agree instead of failing toward
// "counts as an effect". Design: docs/chatwoot.md, section "Observation".
export const EFFECT_FREE_TOOL = Symbol.for("fazerai.tool.effectFree");

export function markEffectFree<T extends StructuredToolInterface>(t: T): T {
  (t as unknown as Record<symbol, boolean>)[EFFECT_FREE_TOOL] = true;
  return t;
}

export function isEffectFreeTool(t: { name: string }): boolean {
  return (t as unknown as Record<symbol, unknown>)[EFFECT_FREE_TOOL] === true;
}

// A call that went nowhere, reported by the handler that refused it. The tick counts a dispatch as
// committed BEFORE invoking (the count must exist when the invoke throws), so a refusal that wrote
// nothing (an unmet precondition, the fence inside a handler, a thrown `ToolpackCalledOffError`)
// reports through this callback; a callback because the thrown case has no result to mark. Never
// called where something already left (handoff after its note, HTTP after its acknowledgement). It
// takes the tool's OWN NAME, unique across sources: effect-free tools are never counted, so a report
// from one must not cancel a sibling's real write and trigger a duplicating retry.
export type NoEffectReporter = (toolName: string) => void;
