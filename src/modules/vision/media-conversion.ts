// WHICH MEDIA TYPES A PROVIDER READS, and what to do with the ones it does not. Unlike
// `visionKindForMime` (./providers), which is about the FILE and global, here the same bytes get
// different answers from different vendors: HEIC is read by Gemini and rejected by OpenAI and
// Anthropic.
//
// DATA only, no decoder: this file sits one import away from the frontend bundle (its sibling
// ./document-support is imported by the agent editor). Converters live in ./convert, keyed by the
// ids below, and the `Record<MediaConverterId, …>` there makes a missing converter a compile error.

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

export type MediaConverterId = "heic-to-jpeg";

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
}): ImagePlan {
  const mime = normalizeMediaType(args.mimeType);
  const native = NATIVE_IMAGE_SUBTYPES[args.provider];
  if (native?.has(mediaSubtype(mime))) return { action: "as-is" };
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
