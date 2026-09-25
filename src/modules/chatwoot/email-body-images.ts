// THE PICTURES A MAILBOX KEPT INSIDE AN EMAIL BODY (issue #864).
//
// Chatwoot's mailbox does not make an inline image an attachment. With an HTML body that references
// it by `cid:`, the reference is rewritten to the blob's URL in `email.html_content.full`; with no
// HTML at all (Apple Mail on iPhone sends the photo as a bare inline part), `<img src="<blob url>">`
// is appended to `email.text_content.full` (`MailboxHelper#process_inline_attachments`). Either way
// `message.attachments` is empty. On one production mailbox that was 2,397 of the 4,197 email
// messages that declared an attachment in 14 days.
//
// Only Chatwoot's own blob URLs count: a remote image in quoted HTML was never uploaded by anybody
// in this conversation. The host is checked later, against the instance, by whoever downloads.

const IMG_SRC = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const BLOB_PATH = "/rails/active_storage/";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function bodyOf(email: Record<string, unknown>, key: string): string {
  const part = email[key];
  const full = isRecord(part) ? part.full : null;
  return typeof full === "string" ? full : "";
}

export function emailBodyImageUrlsFrom(
  contentAttributes: Record<string, unknown> | null | undefined,
): string[] {
  const email = isRecord(contentAttributes?.email)
    ? contentAttributes.email
    : null;
  if (!email) return [];
  const out: string[] = [];
  for (const body of [
    bodyOf(email, "html_content"),
    bodyOf(email, "text_content"),
  ]) {
    for (const m of body.matchAll(IMG_SRC)) {
      const src = (m[1] ?? m[2] ?? "").trim().replace(/&amp;/g, "&");
      if (!/^https?:\/\//i.test(src) || !src.includes(BLOB_PATH)) continue;
      if (!out.includes(src)) out.push(src);
    }
  }
  return out;
}

// Which stored blob a URL names: the signed id after `blobs/redirect/` (or `proxy/`), the same for
// every URL Chatwoot builds for that blob, whatever the host, file name or query.
function blobKeyOf(url: string): string {
  const m =
    /\/rails\/active_storage\/blobs\/(?:redirect\/|proxy\/)?([^/?#]+)/.exec(
      url,
    );
  return m?.[1] ?? url;
}

// The body images that are not ALSO one of the message's real attachments: a body can reference a
// blob that is attached too, and it is one file, read once, as the attachment.
export function bodyImagesBesides(
  urls: string[],
  attachmentUrls: string[],
): string[] {
  const attached = new Set(attachmentUrls.map(blobKeyOf));
  return urls.filter((u) => !attached.has(blobKeyOf(u)));
}
