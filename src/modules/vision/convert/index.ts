// THE CONVERTERS, server-side. The catalogue they answer to is ../media-conversion, which is written
// to be importable by the frontend (its sibling `document-support` already is); this file is where
// the decoders live, and it must never be pulled into that graph — libheif is 8.4 MB of WASM.

import type { MediaConverterId } from "../media-conversion";
import { type HeicFrame, withHeicFrames } from "./heic";
import { rasterToJpeg } from "./raster";

// Thrown for every refusal a conversion can make, so the caller has one thing to catch and one
// message to put on the operator's line. A conversion that fails is NOT the same as an extraction
// that fails: the caller committed to converting because the provider does not read the original,
// so there is nothing left to send and the attachment is skipped.
export class MediaConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaConversionError";
  }
}

// THE DECLARED TYPE LIED, which is a different fact from "this file cannot be converted" and earns
// the opposite answer. Measured against the live API on 2026-09-18: a PNG announced as `image/heic`
// comes back 200 with the value read off it — the vendors sniff the bytes, they do not trust the
// data URI's label. And Chatwoot serves whatever content type the uploader's server declared, so a
// mislabelled attachment is a real population, not a hypothetical.
//
// So when the bytes are not of the type the plan was made for, the original goes to the provider
// untouched and the vendor answers for itself. Skipping there would take an attachment that WAS
// being read before this feature existed and stop reading it (issue #697, holdout scenario s8).
export class MediaSourceMismatchError extends MediaConversionError {
  constructor(message: string) {
    super(message);
    this.name = "MediaSourceMismatchError";
  }
}

// The RGBA buffer a decode materialises is width*height*4 and exists in full before anything is
// encoded: a 12 MP photo is 48 MB, and the 48 MP ones current iPhones shoot are 192 MB. The cap is on
// PIXELS and not on the file, because HEIC's whole point is that the file is small — the 25 MB
// download ceiling in the Chatwoot client admits a 100 MP image at phone compression.
//
// It is also the only time bound there is. The decode is CPU inside WASM and nothing can interrupt
// it once entered, so an `AbortSignal` here would be decoration; bounding the pixels is what bounds
// the milliseconds (~450ms at 12 MP, measured).
export const MAX_SOURCE_PIXELS = 50_000_000;

// Overridable, and for the same reason `extractWithRetry` lets a battery move the clock: what these
// bound is MEMORY, and a test that cannot lower the cap can only exercise it by allocating the 200 MB
// the cap exists to prevent, while one that cannot stand in for the decoder cannot watch the native
// handles being released. Production passes neither.
export type ConvertOptions = {
  readonly maxSourcePixels?: number;
  // Stands in for `./heic`'s frame opener, so the battery can drive the refusal paths without a
  // fixture for each and can watch the decoder being released.
  readonly withFrames?: typeof withHeicFrames;
};

// The long edge every vision provider downscales to on its standard tier anyway (OpenAI and
// Anthropic both 1568 px), so handing over more is paying to ship bytes the vendor discards. It is
// also what keeps the result inside Anthropic's 10 MB base64 ceiling: encoded at the full 12 MP the
// same photo is a 7.5 MB JPEG, which base64 lands at exactly 10 MB (measured).
const MAX_OUTPUT_EDGE = 1568;

// 82 reads text off a photographed receipt without arguing with the vendors' own advice against
// heavy compression (docs: "heavy JPEG compression can make text difficult to read").
const JPEG_QUALITY = 82;

// ONE CONVERSION AT A TIME, process-wide. A message may carry eight attachments and the webhook
// extracts them in PARALLEL (the `Promise.all` in `handleVisualAttachments`), so without this gate
// eight HEICs hold eight RGBA buffers at once: 384 MB for eight 12 MP photos, on a VPS that also
// runs Postgres and Redis. Serialising costs about half a second per extra photo, which is invisible
// next to the provider round trip each one is waiting for anyway.
let gate: Promise<unknown> = Promise.resolve();

function serialized<T>(run: () => Promise<T>): Promise<T> {
  // Chained on BOTH settle paths, so one conversion throwing does not wedge the queue.
  const next = gate.then(run, run);
  gate = next.catch(() => undefined);
  return next;
}

// Exported for the battery only, in the shape `label-activity` uses for the same reason: what this
// primitive guarantees is that two conversions never HOLD THEIR BUFFERS AT THE SAME TIME, and that
// is invisible from outside — a caller's own timestamps are all taken in the tick that queues the
// work, long before any of it runs.
export const __serializedForTest = serialized;

// The dimensions come off the image handle before any pixel is decoded, which is what lets the cap
// below be applied before the memory is spent. Read through a check rather than trusted, and REFUSED
// when unusable: the cap is the only thing between a hostile 100 MP file and 400 MB of RGBA, so a
// libheif upgrade that changes this shape has to fail loudly instead of quietly removing the guard.
function frameDimensions(frame: unknown): { width: number; height: number } {
  const f = frame as { width?: unknown; height?: unknown };
  // `typeof x === "number"` is NOT enough, and the gap is the one that matters: NaN is a number, and
  // `NaN > cap` is false, so a NaN dimension would walk straight past the pixel cap and into a
  // decode of unknown size. Positive integers or nothing.
  if (!positiveInteger(f.width) || !positiveInteger(f.height))
    throw new MediaConversionError(
      "heic frame does not expose usable dimensions, so the pixel cap cannot be applied",
    );
  return { width: f.width, height: f.height };
}

function positiveInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

// Exported for the battery: the branch above cannot be reached through libheif, which always carries
// the dimensions, so the only way to exercise the refusal is to hand it the shape a future version
// might.
export const __frameDimensionsForTest = frameDimensions;

// The brands libheif accepts, checked here rather than left to the decoder, for two reasons. A
// mislabelled file has to be told apart from a broken one — they earn opposite answers, see
// `MediaSourceMismatchError` — and bytes that were never a HEIC should not cost a decoder at all.
const HEIC_BRANDS = new Set(["mif1", "msf1", "heic", "heix", "hevc", "hevx"]);

function heicBrand(bytes: ArrayBuffer): string | null {
  if (bytes.byteLength < 12) return null;
  // THE BOX BEFORE THE BRAND. `ftyp` at offset 4 is what makes offset 8 the major brand rather than
  // four bytes that happen to spell one: a JPEG whose first marker is a comment can carry "heic" at
  // offset 8 and decode perfectly as a JPEG. Reading the brand alone would call that file a broken
  // HEIC and SKIP it, which is the exact regression the brand check exists to prevent — the
  // attachment was readable and stops being read (PR #707 review round 7; holdout s8 is the same
  // failure arrived at from the other side).
  if (ascii(bytes, 4) !== "ftyp") return null;
  return ascii(bytes, 8);
}

function ascii(bytes: ArrayBuffer, offset: number): string {
  return String.fromCharCode(...new Uint8Array(bytes, offset, 4))
    .replace("\0", " ")
    .trim();
}

async function heicToJpeg(
  bytes: ArrayBuffer,
  opts: ConvertOptions,
): Promise<ArrayBuffer> {
  const brand = heicBrand(bytes);
  if (brand === null || !HEIC_BRANDS.has(brand))
    throw new MediaSourceMismatchError(
      `declared as heic but carries brand ${brand === null ? "<too short>" : `"${brand}"`}`,
    );
  const open = opts.withFrames ?? withHeicFrames;
  return await open(bytes, async (frames: readonly HeicFrame[]) => {
    // THE PRIMARY IMAGE, which is not the same as the first one. A HEIC may hold several top-level
    // images, and the file says which of them it is OF: the `pitm` box. libheif hands them back in
    // storage order, and the two disagree — measured on a two-image collection whose `pitm` points
    // at the second, where the first item is a different picture entirely.
    //
    // The animation rule the vendors state ("Animations are unsupported, and only the first frame is
    // used" — Anthropic) does not transfer, and that was the mistake here: a GIF's frames are one
    // picture over time, with no frame designated, while a HEIC collection is several pictures with
    // one designated. Taking the first would send a picture the sender did not send, and the
    // extraction would come back successful and about the wrong image (PR #707 review round 6).
    //
    // FALLING BACK TO THE FIRST when nothing is designated, and the honest note is that no file this
    // parser accepts reaches it: measured by renaming the `pitm` box to `free` (which the standard
    // says to ignore, so the box stops existing for a reader), libheif refuses the whole file with
    // `No 'pitm' box` and returns ZERO images. So the branch is not for the pitm-less file it looks
    // like it is for; it is for a library that hands back images without designating one, which this
    // version never does. It stays because without it that case throws "heic carries no image
    // frame" — a message about a file that plainly has frames — and because a test can kill it.
    const frame = frames.find((f) => f.primary) ?? frames[0];
    if (frame === undefined)
      throw new MediaConversionError("heic carries no image frame");
    const { width, height } = frameDimensions(frame);
    const pixels = width * height;
    const cap = opts.maxSourcePixels ?? MAX_SOURCE_PIXELS;
    if (pixels > cap)
      throw new MediaConversionError(
        `heic is ${width}x${height} (${pixels} px), over the ${cap} px cap`,
      );
    const raw = await frame.decode();
    return rasterToJpeg(raw, {
      maxEdge: MAX_OUTPUT_EDGE,
      quality: JPEG_QUALITY,
    });
  });
}

// A `Record` over the id union and not a lookup that can miss: adding an entry to MEDIA_CONVERTERS
// without writing its implementation is a compile error here, which is the whole reason the registry
// is split across two files.
const IMPLS: Record<
  MediaConverterId,
  (bytes: ArrayBuffer, opts: ConvertOptions) => Promise<ArrayBuffer>
> = {
  "heic-to-jpeg": heicToJpeg,
};

// ONE ERROR TYPE OUT, whatever went wrong inside. libheif answers with its own classes, and so does
// the WASM loader (a missing or unreadable binary is an `Error` from `readFileSync`), so without this
// the module's single-catch contract would hold for the refusals it writes itself and leak for
// everything underneath. The original is kept as `cause`, and its message is carried through because
// it is the only thing that says WHICH file failed.
export async function runMediaConverter(
  id: MediaConverterId,
  bytes: ArrayBuffer,
  opts: ConvertOptions = {},
): Promise<ArrayBuffer> {
  try {
    return await serialized(() => IMPLS[id](bytes, opts));
  } catch (err) {
    if (err instanceof MediaConversionError) throw err;
    const wrapped = new MediaConversionError(
      `${id} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    wrapped.cause = err;
    throw wrapped;
  }
}
