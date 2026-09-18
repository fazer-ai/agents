// WHICH MEDIA TYPES A PROVIDER READS, and what to do with the ones it does not. That is a different
// question from "can this be extracted at all" (`visionKindForMime`, ./providers), which is about
// the FILE: an SVG is markup and no vision model rasterises it, so there the answer is global and
// the same for everyone. Here the same bytes get different answers from different vendors, and the
// type that forced the split is HEIC — the iPhone camera default, which Gemini documents as input
// and OpenAI and Anthropic reject (#697).
//
// This module holds DATA and no decoder, and the constraint is not hypothetical: its sibling
// ./document-support answers the same class of question for PDFs and IS imported by the agent editor
// (`client/pages/agents/BehaviorTab`), which renders a hint from it. A decoder reachable from this
// file would therefore be one import away from the frontend bundle, and libheif is 8.4 MB of WASM.
// So the implementations live in ./convert, server-side, keyed by the ids below, and the
// `Record<MediaConverterId, …>` there is what makes adding an id here without writing its converter
// a compile error instead of a plan that silently converts nothing.
//
// Nothing in the editor reads the plan today, and there is deliberately no hint for it: the hint
// beside the provider field exists because a PDF comes back UNEXTRACTED mid-attendance (#324), and a
// HEIC no longer does. The next format that arrives without a converter is the one that will want
// it, and it will find the answer already computable on this side of the wire.

// Strips the parameters off a media type and lowercases it: `image/PNG; charset=x` -> `image/png`.
// One parser, because two of them drift — and the drift lands on the exotic spellings, which is
// exactly the population this file exists to classify.
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

// THE REGISTRY. One entry today; the shape is what makes the second one cheap, and it is deliberately
// declarative — a format is added by describing it here and implementing the id in ./convert, never
// by teaching the vision service about a format.
//
// Candidates measured as rejected by at least one vendor and NOT added, so the next round knows what
// was considered: `image/tiff` and `image/avif` (no vendor lists either, and both need their own
// decoder), `image/svg+xml` (rasterising markup is a different risk surface, and `visionKindForMime`
// already refuses it before this file is consulted).
export const MEDIA_CONVERTERS: readonly MediaConverterSpec[] = [
  {
    id: "heic-to-jpeg",
    from: new Set(["image/heic", "image/heif", "image/heic-sequence"]),
    to: "image/jpeg",
  },
];

// Image subtypes each provider reads NATIVELY, from the vendor's own documentation, read 2026-09-17:
//
//   openai     png, jpeg, webp, non-animated gif        and the live API's own 400 enumerates
//                                                       exactly ['png', 'jpeg', 'gif', 'webp']
//   anthropic  jpeg, png, gif, webp                     "Animations are unsupported, and only the
//                                                       first frame is used"
//   gemini     png, jpeg, webp, heic, heif
//
// A provider ABSENT from this table is one whose endpoint we cannot speak for: `openai-compatible`
// is whatever the operator pointed at, and `openrouter` is a router whose answer belongs to the
// model behind the id. Absent therefore means "not known to read it natively", and the plan below
// converts when it can — for an unknown endpoint a JPEG is the safe thing to hand over, since every
// vendor on this list reads one.
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

// TWO OUTCOMES AND NOT THREE, and the missing one is deliberate: there is no "refuse before calling"
// branch for a type the vendor rejects and we cannot convert. It was measured and it does not pay.
// A 400 is a rejected request, so it bills nothing; what it costs is ~600ms and a `warn` line, and
// `skip()` and a thrown 400 both return `null` into the same `falharam++` in the webhook, so the
// customer and the model see the identical "could not read" either way. Against that, refusing on a
// table means every mime spelling we guessed wrong about (`image/jpg`, a vendor that accepts more
// than it documents) turns from a loud 400 into a silent skip. So an unconvertible type goes as-is
// and the vendor answers for itself. The one place a refusal IS right is when a conversion we
// COMMITTED to fails: there the provider is known not to read the original, and the caller skips.
// NO `baseURL`, unlike `visionAcceptsDocuments` next door, and the asymmetry is in the failure
// modes rather than in the care taken. There, the endpoint decides because the chat-completions
// shape carries a document in its own content part, so a server can implement the image part and
// not the document one — and the one that ignores an unknown part answers 200 with a plausible
// extraction of nothing, which is why an unknown endpoint has to be refused. Here the target is
// always a JPEG, which every endpoint that serves images at all reads, so the address cannot change
// the answer: converting is safe for `api.openai.com` and for a proxy alike, and the worst an
// unknown endpoint can do with a JPEG is the same 400 it would have given the original.
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
