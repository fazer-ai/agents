// WHAT OPENROUTER SAID A CALL COST, read off a response's `usage` object (issue #866), when it said
// so in a way that can stand for the whole charge.
//
// Only OpenRouter: another provider's `cost` field, if one ever appears, means whatever that vendor
// means by it. A value that is not a finite non-negative number is no figure at all, and a BYOK call
// (`usage.is_byok`) is excluded because OpenRouter's credits then pay only its BYOK fee, while the
// inference itself is billed to the operator's own vendor key, so `cost` would be the fee standing
// in for the call. `undefined` is "this usage says nothing about cost"; `null` is "it said, and the
// figure cannot stand"; both fall back to the price table rather than to zero.
export function reportedCostFromUsage(
  provider: string,
  usage: unknown,
): number | null | undefined {
  if (provider !== "openrouter") return null;
  if (typeof usage !== "object" || usage === null || !("cost" in usage))
    return undefined;
  const u = usage as { cost: unknown; is_byok?: unknown };
  if (u.is_byok === true) return null;
  return typeof u.cost === "number" && Number.isFinite(u.cost) && u.cost >= 0
    ? u.cost
    : null;
}
