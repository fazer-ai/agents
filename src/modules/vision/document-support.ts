// Whether a PDF can be sent to a provider AT A GIVEN ENDPOINT. That is a different question from
// which provider the operator picked: the base URL comes from the credential or from the editor's
// own field, it survives a provider change, and it is what the adapter actually posts to. So
// "openai" does not by itself mean api.openai.com.
//
// The split below is structural rather than a preference:
//
//   - Gemini and Anthropic carry a document in the SAME content part as an image (`inline_data`,
//     `source`), with only the mime type differing. An endpoint that serves one serves the other,
//     so its address cannot change the answer.
//   - The chat-completions shape carries them in DIFFERENT parts (`image_url` vs `file`), so a
//     server can implement one and not the other — and the one that ignores an unknown part answers
//     200 with a plausible extraction of nothing, which is worse for the operator than the skip.
//     The `file` part was measured against api.openai.com (2026-08-26), and that is exactly as far
//     as the answer reaches.

// Providers whose document support rides on the same content part as their images.
const ENDPOINT_AGNOSTIC = new Set(["gemini", "anthropic"]);

const OPENAI_HOST = "api.openai.com";

// Data residency gives the same API a regional hostname: OpenAI documents ten of them today (us,
// eu, au, ca, jp, in, sg, kr, gb, ae), all `<region>.api.openai.com`, all serving the endpoints the
// default host serves. Matched by SUFFIX rather than by listing the ten, because a list of regions
// goes stale the moment an eleventh opens, and it goes stale in the direction that hurts: every PDF
// on that region silently skipped, with nothing in the product saying why. The suffix cannot be
// spoofed, since everything under api.openai.com is served by whoever holds that domain.

// A blank base URL means the adapter falls back to the provider's own endpoint (see
// chatCompletionsExtract), so it is the official one.
function isOpenAiOwnEndpoint(baseURL: string | null): boolean {
  const raw = (baseURL ?? "").trim();
  if (raw === "") return true;
  try {
    const url = new URL(raw);
    // https only: the official endpoint is https, and a plaintext one carrying an API key and a
    // customer's document is not it, whatever the hostname says.
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host === OPENAI_HOST || host.endsWith(`.${OPENAI_HOST}`);
  } catch {
    // Not a URL at all. The call would fail anyway; answering "no documents" makes it fail as a
    // skip the operator can read instead of a 400 from a fetch that never had a chance.
    return false;
  }
}

export function visionAcceptsDocuments(
  provider: string,
  baseURL: string | null,
): boolean {
  if (ENDPOINT_AGNOSTIC.has(provider)) return true;
  if (provider !== "openai") return false;
  return isOpenAiOwnEndpoint(baseURL);
}
