// THE CLOSED FIELDS OF THE SIGNATURE BLOCK, in one place for the three readers of that question: the
// runtime reader (`readSignatureConfig`), the write boundary (`assertSettingsSignature`) and the MCP
// patch schema. Before #618 each spelled its own copy, and the boundary spelled only one of the
// three, which is how `position` and `separator` stored anything with a 200 while the runtime read
// the default and GET echoed the value it ignored.
//
// A leaf module on purpose: the MCP schema and the agents service both import it, and neither can
// import the signature service without pulling the prompt renderer in behind it.
export const SIGNATURE_POSITIONS = ["top", "bottom"] as const;
export const SIGNATURE_SEPARATORS = ["blank", "--"] as const;
export const SIGNATURE_FREQUENCIES = ["all", "once"] as const;

export type SignaturePosition = (typeof SIGNATURE_POSITIONS)[number];
export type SignatureSeparator = (typeof SIGNATURE_SEPARATORS)[number];
export type SignatureFrequency = (typeof SIGNATURE_FREQUENCIES)[number];

// Field name -> its domain, which is what the boundary walks. Keyed by the name the bag uses, so the
// refusal's `field` is `signature.<key>` with no second spelling.
export const SIGNATURE_CHOICES = {
  position: SIGNATURE_POSITIONS,
  separator: SIGNATURE_SEPARATORS,
  frequency: SIGNATURE_FREQUENCIES,
} as const;

export function isOneOf<T extends string>(
  domain: readonly T[],
  value: unknown,
): value is T {
  return (domain as readonly unknown[]).includes(value);
}
