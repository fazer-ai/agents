// A Markdown link to an address someone typed. The destination ends at the first unbalanced `)`, and
// a backslash escapes the character after it (the closing parenthesis included), so those and the
// angle brackets are percent-encoded; and a renderer reads `&name;` as a character reference, so `&` is
// written as `&amp;`. The link a reader follows is then exactly what was typed.
export function markdownLink(label: string, url: string): string {
  const destination = url.replace(
    /[()<>\\]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
  return `[${label}](${destination.replaceAll("&", "&amp;")})`;
}
