// WHICH MEDIA TYPES A PROVIDER READS, and what to do with the ones it does not. Unlike
// `visionKindForMime` (./providers), which is about the FILE and global, here the same bytes get
// different answers from different vendors: HEIC is read by Gemini and rejected by OpenAI and
// Anthropic.
//
// DATA only, no decoder: this file sits one import away from the frontend bundle (its sibling
// ./document-support is imported by the agent editor). Converters live in ./convert, keyed by the
// ids below, and the `Record<MediaConverterId, …>` there makes a missing converter a compile error.

// The editor deliberately shows no hint for the conversion plan: a converted type never comes back
// unextracted, which is what the PDF hint beside the provider field warns about.

// Strips the parameters off a media type and lowercases it: `image/PNG; charset=x` -> `image/png`.
// One parser, because two of them drift, and the drift lands on the exotic spellings this file
// exists to classify.
export function normalizeMediaType(mimeType: string | null): string {
  return (mimeType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
}

export function mediaSubtype(mimeType: string | null): string {
  const m = normalizeMediaType(mimeType);
  return m.startsWith("image/") ? m.slice("image/".length) : "";
}

export type MediaConverterId = "heic-to-jpeg" | "jpeg-fit" | "png-fit";

export type MediaConverterSpec = {
  readonly id: MediaConverterId;
  // Media types the converter accepts, normalised (no parameters, lowercase).
  readonly from: ReadonlySet<string>;
  // The single media type it produces. One target and not a list: what the caller has to put in the
  // request is one mime string, and a converter that could answer with either of two would move
  // that choice to every call site.
  readonly to: string;
};

// THE REGISTRY, declarative: a format is added by describing it here and implementing the id in
// ./convert, never by teaching the vision service about a format. Not added on purpose: `image/tiff`
// and `image/avif` (no vendor lists either, each needs its own decoder), `image/svg+xml`
// (`visionKindForMime` refuses it before this file is consulted).
export const MEDIA_CONVERTERS: readonly MediaConverterSpec[] = [
  {
    id: "heic-to-jpeg",
    from: new Set(["image/heic", "image/heif", "image/heic-sequence"]),
    to: "image/jpeg",
  },
];

// THE SECOND REASON TO CONVERT: a type the provider reads, at a size it refuses. Every limit a
// provider documents for one image lives in this table, and a provider absent from it
// (`openrouter`, `openai-compatible`) is one whose endpoint we cannot speak for, so it gets
// NO_IMAGE_LIMITS and the plan sends as received. Each limit is a value or an explicit null.

// A limit is HARD when no model of the provider accepts an image over it: on the vendor's own
// endpoint it makes the fit required, and refuses a type nothing here can fit. It is SOFT when
// fitting is prudent but the original may still be read: the fit runs, and the original goes when
// it cannot. Off the vendor's endpoint every limit is soft (see planImageConversion).
export type LimitKind = "hard" | "soft";

export type ImageLimit<T> = { readonly value: T; readonly kind: LimitKind };

export type ImageLimits = {
  // Where the numbers come from: the vendor's documentation for image input.
  readonly source: string | null;
  // The vendor's own API host. A base URL elsewhere is an endpoint we cannot speak for.
  readonly host: string | null;
  // Longest side, in px.
  readonly maxEdge: ImageLimit<number> | null;
  // The image as SENT, base64 included.
  readonly maxBase64Bytes: ImageLimit<number> | null;
  // Where fitting starts below the byte ceiling, when the ceiling is the whole request's and the
  // prompt needs room.
  readonly fitBase64Bytes: ImageLimit<number> | null;
  // The total area, counted the way the vendor counts it: `edge`-px patches per image.
  readonly maxPatches: ImageLimit<{
    readonly edge: number;
    readonly count: number;
  }> | null;
};

export const NO_IMAGE_LIMITS: ImageLimits = {
  source: null,
  host: null,
  maxEdge: null,
  maxBase64Bytes: null,
  fitBase64Bytes: null,
  maxPatches: null,
};

export const IMAGE_LIMITS: Readonly<Record<string, ImageLimits>> = {
  // 8000x8000 px and 10 MB base64 per image on the Claude API, both measured as 400s ("At least one
  // of the image dimensions exceed max allowed size: 8000 pixels", "image exceeds 10 MB maximum" over
  // 10,485,760 base64 bytes).
  anthropic: {
    source: "https://platform.claude.com/docs/en/build-with-claude/vision",
    host: "api.anthropic.com",
    maxEdge: { value: 8000, kind: "hard" },
    maxBase64Bytes: { value: 10 * 1024 * 1024, kind: "hard" },
    fitBase64Bytes: null,
    maxPatches: null,
  },
  // 32x32 px patches, at most 30,000 per image after the model's own resizing, and an image over that
  // is "rejected, not automatically resized". Counted on the original, because the models whose
  // `auto` detail is `original` do not resize below 65,535 px: gpt-6.1-sol answered 400 "requires
  // 35784 patches after processing, exceeding the limit of 30000" to a 4536x8064 photo (measured).
  // Soft, because the models that resize first (gpt-4o fits 2048 px) read the same photo. No
  // per-image byte limit is documented.
  openai: {
    source: "https://developers.openai.com/api/docs/guides/images-vision",
    host: "api.openai.com",
    maxEdge: null,
    maxBase64Bytes: null,
    fitBase64Bytes: null,
    maxPatches: { value: { edge: 32, count: 30_000 }, kind: "soft" },
  },
  // Inline data caps the WHOLE request at 20 MB, prompt included. An image over 20 MiB alone cannot
  // fit under either reading of "MB"; one over 19 MB is fitted, leaving the prompt its room. No
  // dimension limit is documented; larger images are tiled on the vendor's side. Not measured live.
  gemini: {
    source: "https://ai.google.dev/gemini-api/docs/image-understanding",
    host: "generativelanguage.googleapis.com",
    maxEdge: null,
    maxBase64Bytes: { value: 20 * 1024 * 1024, kind: "hard" },
    fitBase64Bytes: { value: 19 * 1000 * 1000, kind: "soft" },
    maxPatches: null,
  },
};

export function imageLimitsFor(provider: string): ImageLimits {
  return IMAGE_LIMITS[provider] ?? NO_IMAGE_LIMITS;
}

function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

// Which kinds of limit an image of this size and weight is over. Unknown dimensions or bytes count as
// within: the provider's answer is the fallback, never a guess here.
function overLimits(
  limits: ImageLimits,
  dimensions: { width: number; height: number } | null | undefined,
  byteLength: number | undefined,
): { hard: boolean; soft: boolean } {
  const d = dimensions;
  const sent = byteLength === undefined ? null : base64Length(byteLength);
  const crossed: Array<ImageLimit<unknown> | null> = [
    d && limits.maxEdge && Math.max(d.width, d.height) > limits.maxEdge.value
      ? limits.maxEdge
      : null,
    sent !== null && limits.maxBase64Bytes && sent > limits.maxBase64Bytes.value
      ? limits.maxBase64Bytes
      : null,
    sent !== null && limits.fitBase64Bytes && sent > limits.fitBase64Bytes.value
      ? limits.fitBase64Bytes
      : null,
    d &&
    limits.maxPatches &&
    Math.ceil(d.width / limits.maxPatches.value.edge) *
      Math.ceil(d.height / limits.maxPatches.value.edge) >
      limits.maxPatches.value.count
      ? limits.maxPatches
      : null,
  ];
  return {
    hard: crossed.some((l) => l?.kind === "hard"),
    soft: crossed.some((l) => l?.kind === "soft"),
  };
}

// A blank base URL is the adapter's own default, the vendor's endpoint. Anything else must be https
// on the vendor's host; a regional subdomain of it is the same API.
function isVendorEndpoint(
  host: string | null,
  baseURL: string | null,
): boolean {
  if (host === null) return false;
  const raw = (baseURL ?? "").trim();
  if (raw === "") return true;
  try {
    const url = new URL(raw);
    const h = url.hostname.toLowerCase();
    return url.protocol === "https:" && (h === host || h.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

// No WebP or GIF entry: there is no decoder for them here, so one over a hard limit of the vendor's
// own endpoint is refused before the call (`over-limit`) instead of being sent to a 400 that bills
// nothing and explains nothing.
export const FIT_CONVERTERS: readonly MediaConverterSpec[] = [
  { id: "jpeg-fit", from: new Set(["image/jpeg"]), to: "image/jpeg" },
  { id: "png-fit", from: new Set(["image/png"]), to: "image/jpeg" },
];

// Image subtypes each provider reads NATIVELY, per the vendor's own documentation. A provider ABSENT
// here (`openai-compatible`, `openrouter`) is one whose endpoint we cannot speak for, so the plan
// converts when it can: every vendor listed reads a JPEG.
const NATIVE_IMAGE_SUBTYPES: Readonly<Record<string, ReadonlySet<string>>> = {
  openai: new Set(["png", "jpeg", "gif", "webp"]),
  anthropic: new Set(["png", "jpeg", "gif", "webp"]),
  gemini: new Set(["png", "jpeg", "gif", "webp", "heic", "heif"]),
};

export type ImagePlan =
  | { readonly action: "as-is" }
  // Over the provider's limit, in a type nothing here can fit: the caller skips it with the reason.
  | { readonly action: "over-limit" }
  | {
      readonly action: "convert";
      readonly converter: MediaConverterId;
      readonly to: string;
      // Whether the original cannot be sent at all. False when the fit is only prudent (a soft
      // limit): a conversion that fails then sends the original instead of skipping it.
      readonly required: boolean;
    };

// A type we cannot convert goes as-is and the vendor answers for itself: refusing on a table of TYPES
// turns every mime spelling we guessed wrong into a silent skip. The one refusal before the call is
// a size the header proves over a limit the vendor documents for every model, on the vendor's own
// endpoint, in a type with no fit converter (`over-limit`). The base URL decides only that refusal:
// a fitted JPEG is read by every endpoint that serves images.
export function planImageConversion(args: {
  mimeType: string | null;
  provider: string;
  // Off the file's header (./convert/dimensions), when the provider has a limit to check against.
  // Unknown dimensions go as-is: the provider's answer is the fallback, never a guess here.
  dimensions?: { width: number; height: number } | null;
  // The file's size, checked against the provider's base64 ceiling.
  byteLength?: number;
  // The endpoint the call goes to (the vault entry's, else the settings'). Absent or blank: the
  // vendor's own.
  baseURL?: string | null;
}): ImagePlan {
  const mime = normalizeMediaType(args.mimeType);
  const native = NATIVE_IMAGE_SUBTYPES[args.provider];
  if (native?.has(mediaSubtype(mime))) {
    const limits = imageLimitsFor(args.provider);
    const over = overLimits(limits, args.dimensions, args.byteLength);
    if (!over.hard && !over.soft) return { action: "as-is" };
    // A hard limit binds only on the vendor's own endpoint: elsewhere the fit is prudent and the
    // original stays sendable, whether the file has no converter or its conversion fails.
    const binding =
      over.hard && isVendorEndpoint(limits.host, args.baseURL ?? null);
    // A HEIC that Gemini reads natively but is over its ceiling is fitted by the HEIC converter,
    // which outputs the same fitted JPEG.
    const fit =
      FIT_CONVERTERS.find((c) => c.from.has(mime)) ??
      MEDIA_CONVERTERS.find((c) => c.from.has(mime));
    if (fit === undefined)
      return binding ? { action: "over-limit" } : { action: "as-is" };
    return {
      action: "convert",
      converter: fit.id,
      to: fit.to,
      required: binding,
    };
  }
  const converter = MEDIA_CONVERTERS.find((c) => c.from.has(mime));
  if (converter === undefined) return { action: "as-is" };
  // NO RUNTIME CHECK that the target is itself readable, and the absence is deliberate. Converting
  // into something the provider does not read would pay twice (the CPU, then the same 400), but the
  // condition cannot arise: every provider in the table reads JPEG, which is every converter's
  // target. A branch for it would be unreachable code that no test can kill, so the invariant is
  // asserted in the battery instead ("every converter's target is native to every listed provider"),
  // where adding a converter with an unread target fails immediately and visibly.
  return {
    action: "convert",
    converter: converter.id,
    to: converter.to,
    required: true,
  };
}
