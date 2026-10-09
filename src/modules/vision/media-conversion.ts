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

// THE SECOND REASON TO CONVERT: a type the provider reads, at a size it refuses. Anthropic answers 400
// to any side over 8000 px ("At least one of the image dimensions exceed max allowed size: 8000
// pixels", measured), which a full-resolution phone photo (4536x8064) crosses, while OpenAI and
// Gemini downscale on their side. Kept apart from MEDIA_CONVERTERS, which is looked up by type
// alone: a JPEG there would be re-encoded for every endpoint that table does not list.
export const MAX_IMAGE_EDGE: Readonly<Record<string, number>> = {
  anthropic: 8000,
};

// And a ceiling on the image as SENT, base64 included: Anthropic answers 400 "image exceeds 10 MB
// maximum" over 10,485,760 base64 bytes (measured), so a JPEG of ~7.5 MB fails with sides well
// under 8000 px. Same answer as the edge: fit and re-encode.
export const MAX_IMAGE_BASE64_BYTES: Readonly<Record<string, number>> = {
  anthropic: 10 * 1024 * 1024,
};

function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

// No WebP or GIF entry: there is no decoder for them here, so an oversized one goes as-is and the
// provider's own 400 names the limit on the flow line.
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
  | {
      readonly action: "convert";
      readonly converter: MediaConverterId;
      readonly to: string;
    };

// TWO OUTCOMES, no "refuse before calling": a type we cannot convert goes as-is and the vendor
// answers for itself. A 400 bills nothing and reads the same as a skip, while refusing on a table
// turns every mime spelling we guessed wrong into a silent skip.
// NO `baseURL`, unlike `visionAcceptsDocuments`: the target is always a JPEG, which every endpoint
// that serves images reads, so the address cannot change the answer.
export function planImageConversion(args: {
  mimeType: string | null;
  provider: string;
  // Off the file's header (./convert/dimensions), when the provider has a limit to check against.
  // Unknown dimensions go as-is: the provider's answer is the fallback, never a guess here.
  dimensions?: { width: number; height: number } | null;
  // The file's size, checked against MAX_IMAGE_BASE64_BYTES.
  byteLength?: number;
}): ImagePlan {
  const mime = normalizeMediaType(args.mimeType);
  const native = NATIVE_IMAGE_SUBTYPES[args.provider];
  if (native?.has(mediaSubtype(mime))) {
    const edge = MAX_IMAGE_EDGE[args.provider];
    const d = args.dimensions;
    const tooWide =
      edge !== undefined && !!d && Math.max(d.width, d.height) > edge;
    const ceiling = MAX_IMAGE_BASE64_BYTES[args.provider];
    const tooHeavy =
      ceiling !== undefined &&
      args.byteLength !== undefined &&
      base64Length(args.byteLength) > ceiling;
    if (!tooWide && !tooHeavy) return { action: "as-is" };
    const fit = FIT_CONVERTERS.find((c) => c.from.has(mime));
    if (fit === undefined) return { action: "as-is" };
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
