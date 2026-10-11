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
// NO_IMAGE_LIMITS and the plan sends as received. Each field is a value or an explicit null.
export type ImageLimits = {
  // Longest side, in px.
  readonly maxEdge: number | null;
  // The image as SENT, base64 included.
  readonly maxBase64Bytes: number | null;
  // The total area, counted the way the vendor counts it: `edge`-px patches per image.
  readonly maxPatches: { readonly edge: number; readonly count: number } | null;
};

export const NO_IMAGE_LIMITS: ImageLimits = {
  maxEdge: null,
  maxBase64Bytes: null,
  maxPatches: null,
};

export const IMAGE_LIMITS: Readonly<Record<string, ImageLimits>> = {
  // platform.claude.com/docs/en/build-with-claude/vision: 8000x8000 px and 10 MB base64 per image
  // on the Claude API, both measured as 400s ("At least one of the image dimensions exceed max
  // allowed size: 8000 pixels", "image exceeds 10 MB maximum" over 10,485,760 base64 bytes).
  anthropic: {
    maxEdge: 8000,
    maxBase64Bytes: 10 * 1024 * 1024,
    maxPatches: null,
  },
  // developers.openai.com/api/docs/guides/images-vision: 32x32 px patches, at most 30,000 per image
  // after the model's own resizing, and an image over that is "rejected, not automatically resized".
  // Counted on the original, because the models whose `auto` detail is `original` do not resize
  // below 65,535 px: gpt-6.1-sol answered 400 "requires 35784 patches after processing, exceeding
  // the limit of 30000" to a 4536x8064 photo (measured). No per-image byte limit is documented.
  openai: {
    maxEdge: null,
    maxBase64Bytes: null,
    maxPatches: { edge: 32, count: 30_000 },
  },
  // ai.google.dev/gemini-api/docs/image-understanding: inline data caps the WHOLE request at 20 MB,
  // prompt included, so the image gets 19 MB and the prompt the rest. No dimension limit is
  // documented; larger images are tiled on the vendor's side.
  gemini: {
    maxEdge: null,
    maxBase64Bytes: 19 * 1000 * 1000,
    maxPatches: null,
  },
};

export function imageLimitsFor(provider: string): ImageLimits {
  return IMAGE_LIMITS[provider] ?? NO_IMAGE_LIMITS;
}

function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

// Whether an image of this size and weight is over any limit of the provider. Unknown dimensions or
// bytes count as within: the provider's answer is the fallback, never a guess here.
function overLimits(
  limits: ImageLimits,
  dimensions: { width: number; height: number } | null | undefined,
  byteLength: number | undefined,
): boolean {
  const d = dimensions;
  if (
    d &&
    limits.maxEdge !== null &&
    Math.max(d.width, d.height) > limits.maxEdge
  )
    return true;
  if (
    d &&
    limits.maxPatches !== null &&
    Math.ceil(d.width / limits.maxPatches.edge) *
      Math.ceil(d.height / limits.maxPatches.edge) >
      limits.maxPatches.count
  )
    return true;
  return (
    limits.maxBase64Bytes !== null &&
    byteLength !== undefined &&
    base64Length(byteLength) > limits.maxBase64Bytes
  );
}

// No WebP or GIF entry: there is no decoder for them here, so an oversized one is refused before the
// call (`over-limit`) instead of being sent to a 400 that bills nothing and explains nothing.
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
    };

// A type we cannot convert goes as-is and the vendor answers for itself: refusing on a table of TYPES
// turns every mime spelling we guessed wrong into a silent skip. The one refusal before the call is
// a size the header proves over a documented limit, in a type with no fit converter (`over-limit`).
// NO `baseURL`, unlike `visionAcceptsDocuments`: the target is always a JPEG, which every endpoint
// that serves images reads, so the address cannot change the answer.
export function planImageConversion(args: {
  mimeType: string | null;
  provider: string;
  // Off the file's header (./convert/dimensions), when the provider has a limit to check against.
  // Unknown dimensions go as-is: the provider's answer is the fallback, never a guess here.
  dimensions?: { width: number; height: number } | null;
  // The file's size, checked against the provider's base64 ceiling.
  byteLength?: number;
}): ImagePlan {
  const mime = normalizeMediaType(args.mimeType);
  const native = NATIVE_IMAGE_SUBTYPES[args.provider];
  if (native?.has(mediaSubtype(mime))) {
    if (
      !overLimits(
        imageLimitsFor(args.provider),
        args.dimensions,
        args.byteLength,
      )
    )
      return { action: "as-is" };
    // A HEIC that Gemini reads natively but is over its ceiling is fitted by the HEIC converter,
    // which outputs the same fitted JPEG.
    const fit =
      FIT_CONVERTERS.find((c) => c.from.has(mime)) ??
      MEDIA_CONVERTERS.find((c) => c.from.has(mime));
    if (fit === undefined) return { action: "over-limit" };
    return { action: "convert", converter: fit.id, to: fit.to };
  }
  const converter = MEDIA_CONVERTERS.find((c) => c.from.has(mime));
  if (converter === undefined) return { action: "as-is" };
  // NO RUNTIME CHECK that the target is itself readable, and the absence is deliberate. Converting
  // into something the provider does not read would pay twice (the CPU, then the same 400), but the
  // condition cannot arise: every provider in the table reads JPEG, which is every converter's
  // target. A branch for it would be unreachable code that no test can kill, so the invariant is
  // asserted in the battery instead ("every converter's target is native to every listed provider"),
  // where adding a converter with an unread target fails immediately and visibly.
  return { action: "convert", converter: converter.id, to: converter.to };
}
