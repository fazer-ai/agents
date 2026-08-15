import { assertSafeOutboundUrl, SsrfError } from "@/lib/ssrf";
import {
  IMAGE_FETCH_TIMEOUT_MS,
  IMAGE_MAX_BYTES,
  isAllowedImageHost,
  type SendImageConfig,
} from "./settings";

// Fetches an image the AGENT chose the URL for, so every step assumes the URL is hostile until
// proven otherwise: the operator's host allowlist decides where we may go at all, assertSafeOutboundUrl
// keeps that from being pointed at a private address, redirects are refused rather than followed
// (a redirect is a second URL nobody allowlisted), the cap is enforced against the bytes that
// actually arrive rather than a claimed content-length, and the type is taken from the file's own
// signature rather than from a header the same server wrote.

export type ImageFetchFailure =
  | "no_hosts_configured"
  | "invalid_url"
  | "host_not_allowed"
  | "unreachable"
  | "http_error"
  | "too_large"
  | "not_an_image";

export type ImageFetchResult =
  | { ok: true; bytes: ArrayBuffer; mime: string; fileName: string }
  | { ok: false; reason: ImageFetchFailure; detail?: string };

interface Signature {
  mime: string;
  ext: string;
  matches: (b: Uint8Array) => boolean;
}

// The formats a customer's WhatsApp/web widget actually renders. Checked against the leading bytes,
// which is what makes "it says image/png" and "it is a PNG" two different claims.
const SIGNATURES: Signature[] = [
  {
    mime: "image/png",
    ext: "png",
    matches: (b) =>
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    mime: "image/jpeg",
    ext: "jpg",
    matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: "image/gif",
    ext: "gif",
    matches: (b) =>
      b[0] === 0x47 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x38 &&
      (b[4] === 0x37 || b[4] === 0x39) &&
      b[5] === 0x61,
  },
  {
    mime: "image/webp",
    ext: "webp",
    matches: (b) =>
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
];

export const SUPPORTED_IMAGE_TYPES = SIGNATURES.map((s) => s.mime);

function detect(bytes: ArrayBuffer): Signature | null {
  const head = new Uint8Array(bytes.slice(0, 12));
  if (head.length < 12) return null;
  return SIGNATURES.find((s) => s.matches(head)) ?? null;
}

// The customer-visible file name is OURS, not the URL's. A name taken from the path is text the
// MODEL chose that reaches the customer without passing the output guardrail, which screens the
// reply and the captions — a picture delivered as `marca-proibida.png` would walk straight through
// it. The extension comes from the DETECTED type, so it also cannot lie about what the file is.
function imageFileName(ext: string): string {
  return `imagem.${ext}`;
}

export interface ImageFetchDeps {
  fetchImpl?: typeof fetch;
  assertSafe?: typeof assertSafeOutboundUrl;
  // Injectable for tests only, so a case about the deadline does not have to wait out the real one.
  timeoutMs?: number;
}

export async function fetchImageForDelivery(
  rawUrl: string,
  cfg: SendImageConfig,
  deps: ImageFetchDeps = {},
): Promise<ImageFetchResult> {
  if (cfg.allowedHosts.length === 0)
    return { ok: false, reason: "no_hosts_configured" };

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  // NOTE: The allowlist is checked BEFORE the SSRF assertion, which resolves DNS: an unlisted host
  // must not even be looked up.
  if (!isAllowedImageHost(url.hostname, cfg.allowedHosts)) {
    return { ok: false, reason: "host_not_allowed", detail: url.hostname };
  }
  // ONE deadline over both steps. The SSRF assertion resolves DNS, and a resolver that retries a
  // nonexistent subdomain — which a wildcard allowlist lets the model ask for — can hold a customer's
  // turn open on its own schedule, before the fetch's timeout has even been created.
  const deadline = AbortSignal.timeout(
    deps.timeoutMs ?? IMAGE_FETCH_TIMEOUT_MS,
  );
  const assertSafe = deps.assertSafe ?? assertSafeOutboundUrl;
  try {
    await Promise.race([
      assertSafe(url.toString()),
      new Promise((_, reject) => {
        if (deadline.aborted) return reject(new Error("timeout"));
        deadline.addEventListener("abort", () => reject(new Error("timeout")), {
          once: true,
        });
      }),
    ]);
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof SsrfError ? "invalid_url" : "unreachable",
      detail: e instanceof Error ? e.message : undefined,
    };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      method: "GET",
      redirect: "error",
      signal: deadline,
    });
  } catch (e) {
    return {
      ok: false,
      reason: "unreachable",
      detail: e instanceof Error ? e.message : undefined,
    };
  }
  if (!res.ok)
    return { ok: false, reason: "http_error", detail: String(res.status) };

  const body = res.body;
  if (!body) return { ok: false, reason: "not_an_image" };
  // NOTE: Counted while reading and aborted past the cap — a content-length header is the same
  // server's claim about itself, and a chunked response carries none at all.
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > IMAGE_MAX_BYTES) {
        await reader.cancel();
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch (e) {
    return {
      ok: false,
      reason: "unreachable",
      detail: e instanceof Error ? e.message : undefined,
    };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  const sig = detect(bytes.buffer);
  if (!sig) return { ok: false, reason: "not_an_image" };
  return {
    ok: true,
    bytes: bytes.buffer,
    mime: sig.mime,
    fileName: imageFileName(sig.ext),
  };
}
