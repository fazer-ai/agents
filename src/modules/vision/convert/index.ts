// THE CONVERTERS, server-side. The catalogue they answer to is ../media-conversion, which is written
// to be importable by the frontend (its sibling `document-support` already is); this file is where
// the decoders live, and it must never be pulled into that graph — libheif is 8.4 MB of WASM.

import decode from "heic-decode";
import type { MediaConverterId } from "../media-conversion";
import { type Rgba, rasterToJpeg } from "./raster";

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
  // `heic-decode`'s `decode.all`, injectable so the battery can see `dispose` being called.
  readonly decodeAll?: (arg: { buffer: Uint8Array }) => Promise<unknown[]>;
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

// The dimensions of the frame `heic-decode` defers, which the runtime carries on the frame object
// and `@types/heic-decode` 2.0.0 does not declare (measured 2026-09-17: the object's own keys are
// `width`, `height`, `decode`). Read through a check rather than a cast, and REFUSED when absent:
// the pixel cap below is the only thing between a hostile 100 MP file and 400 MB of RGBA, so a
// library upgrade that moves this shape has to fail loudly instead of quietly removing the guard.
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

// Exported for the battery: the branch below cannot be reached through `heic-decode`, which always
// carries the dimensions, so the only way to exercise the refusal is to hand it the shape a future
// version might.
export const __frameDimensionsForTest = frameDimensions;

// WHO OWNS THE NATIVE HANDLES, and `heic-decode`'s two entry points answer differently. Read off its
// source (2.1.0), not its types: the one-shot `decode()` disposes in its own `finally`, while
// `decode.all()` hands ownership to the caller and attaches `dispose` to the returned ARRAY as a
// NON-ENUMERABLE property — which is why probing a frame's own keys shows `width`, `height` and
// `decode`, and no hint that anything needs releasing. `dispose` runs `image.free()` for every image
// and `decoder.decoder.delete()`, so skipping it strands one decoder context and every image handle
// of that file in the WASM heap, per conversion, for the life of the process.
//
// Measured before this: RSS 431 -> 476 -> 518 MB across three conversions of the same 12 MP photo,
// ~45 MB each and never returned — which I first wrote off as GC lag. The serialisation gate bounds
// how many buffers exist AT ONCE and does nothing about a leak, so this was growth no amount of
// serialising would have stopped.
//
// `@types/heic-decode` 2.0.0 does not declare `dispose`, so it is read through a check. Absent, the
// conversion still proceeds: the cost of a missing dispose is a leak, and refusing every photo would
// be worse. What keeps that from being silent is the battery, which asserts the library still carries
// it — an upgrade that drops it fails CI instead of failing in production three weeks later.
function disposeFrames(frames: unknown): void {
  const dispose = (frames as { dispose?: unknown }).dispose;
  if (typeof dispose === "function")
    (dispose as (this: unknown) => void).call(frames);
}

// Exported for the battery, for the reason above: this is the seam where "the library still releases
// its handles" is checked instead of assumed.
export const __disposeFramesForTest = disposeFrames;

async function heicToJpeg(
  bytes: ArrayBuffer,
  opts: ConvertOptions,
): Promise<ArrayBuffer> {
  // `all()` returns the frame list and DEFERS the pixel work to each frame's own `decode()`, in ~7ms
  // (measured). That is what lets the cap be read before the memory is spent; the one-shot
  // `decode()` would have allocated the whole buffer just to tell us it was too big.
  const decodeAll = opts.decodeAll ?? decode.all;
  const frames = (await decodeAll({
    buffer: new Uint8Array(bytes),
  })) as Array<{ decode(): Promise<Rgba> }>;
  try {
    // The FIRST frame, which is the still. A burst or a Live Photo carries several, and taking the
    // first is what the vendors do with the animated formats they do accept ("Animations are
    // unsupported, and only the first frame is used" — Anthropic), so the customer's photo and our
    // reading of it agree.
    const frame = frames[0];
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
  } finally {
    // In `finally`, because the refusals above are the paths that leaked most visibly: an oversized
    // file allocates the decoder and every handle before the cap is even read, and the throw used to
    // walk straight past the release.
    disposeFrames(frames);
  }
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

// ONE ERROR TYPE OUT, whatever went wrong inside. The decoders are third-party and answer with
// their own classes — `heic-decode` throws a bare `TypeError("input buffer is not a HEIC image")`
// for a file that is not one — so without this the module's single-catch contract would hold for
// the refusals it writes itself and quietly leak for the ones the library writes. The original is
// kept as `cause`, and its message is carried through because it is the only thing that says WHICH
// file failed.
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
