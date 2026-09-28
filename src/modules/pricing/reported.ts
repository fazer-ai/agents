// What OpenRouter said a call cost, read off a response's `usage`, when it can stand for the whole
// charge. Only OpenRouter (another vendor's `cost` means whatever it means). A non-finite or negative
// value is no figure, and a BYOK call (`usage.is_byok`) is excluded: `cost` is then only OpenRouter's
// fee, with inference billed to the operator's vendor key. `undefined` says nothing about cost; `null`
// means the figure cannot stand; both fall back to the price table, never to zero.
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
