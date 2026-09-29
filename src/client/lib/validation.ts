export function isValidHttpUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true; // NOTE: empty is the caller's responsibility (required check)
  if (!/^https?:\/\//i.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Validates URL template fields: empty → ok; starts with "/" (relative) → ok; starts with
// "http(s)://" → ok; anything else → invalid. new URL() is intentionally not used here because
// templates contain {placeholders} that would make new URL() throw.
export function isValidUrlTemplate(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return true;
  return /^https?:\/\//i.test(trimmed);
}
