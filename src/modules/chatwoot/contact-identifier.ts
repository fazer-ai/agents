// The Chatwoot contact `identifier` as the mirror stores it (Contact.attributes.identifier, written
// under the attributes watermark in mirror.ts), trimmed, or null when there is none. One reading for
// the contact authorization gate and the tool context, so a value one of them treats as absent is
// absent for the other too.
export function mirroredContactIdentifier(attributes: unknown): string | null {
  if (
    !attributes ||
    typeof attributes !== "object" ||
    Array.isArray(attributes)
  )
    return null;
  const v = (attributes as Record<string, unknown>).identifier;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
