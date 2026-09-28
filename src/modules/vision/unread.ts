// Why an attachment was not read, in the three answers that ask the customer for different things:
// another format, a smaller picture, or the content in writing (or the file again).
export type UnreadCause = "format" | "too_large" | "failed";

// A file the eager pass did not read. The name is the customer's own text, so it lives in the
// in-process annotation store and the rendered prompt, never in `execution_logs`.
export interface UnreadFile {
  name: string | null;
  cause: UnreadCause;
}

// What a skip carries back instead of a result, so a shared in-flight read hands the cause to every
// delivery waiting on it.
export interface Unread {
  unread: UnreadCause;
}

export function isUnread(v: unknown): v is Unread {
  return typeof v === "object" && v !== null && "unread" in v;
}

const FORMAT = new Set(["unsupported_mime", "document_not_supported"]);

export function unreadCauseOf(reason: string): UnreadCause {
  if (FORMAT.has(reason)) return "format";
  if (reason === "over_pixel_cap") return "too_large";
  return "failed";
}

// The customer's file meeting a known limit, which the model already answers: nothing for an
// operator to do, so it must not page. Everything else (a provider, a credential, a decoder that
// broke) is ours and stays a warning.
const CUSTOMER_SIDE = new Set(["unsupported_mime", "over_pixel_cap"]);

export function skipLevel(reason: string): "info" | "warn" {
  return CUSTOMER_SIDE.has(reason) ? "info" : "warn";
}
