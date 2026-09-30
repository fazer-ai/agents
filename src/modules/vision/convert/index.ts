// THE CONVERTERS, server-side. The catalogue they answer to is ../media-conversion, which is written
// to be importable by the frontend (its sibling `document-support` already is); this file is where
// the decoders live, and it must never be pulled into that graph — libheif is 8.4 MB of WASM.

import type { MediaConverterId } from "../media-conversion";
import { decodeGridFitted, type HeicFrame, withHeicFrames } from "./heic";
import { encodeJpeg, rasterToJpeg } from "./raster";

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

// The declared type lied, which earns the opposite answer from "cannot be converted": the vendors
// sniff the bytes rather than trust the data URI's label, and Chatwoot serves whatever type the
// uploader declared. So bytes not of the planned type go to the provider untouched; skipping would
// stop reading an attachment that was readable.
export class MediaSourceMismatchError extends MediaConversionError {
  constructor(message: string) {
    super(message);
    this.name = "MediaSourceMismatchError";
  }
}

// Over the pixel cap: a legitimate picture, too large to decode here. Its own type because the
// customer can fix it (a screenshot, a photo at normal resolution) and a broken file cannot.
export class MediaTooLargeError extends MediaConversionError {
  constructor(message: string) {
    super(message);
    this.name = "MediaTooLargeError";
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

// Over the cap, a GRID image is still read: it is decoded tile by tile into the output, so memory is
// bounded by one tile plus the output, not by the image. What this second cap bounds is TIME, since
// every tile is still decoded: 200 MP is the largest mode phones shoot, and ~150 MP took ~4s here.
// A tile is decoded whole, so a tile over `MAX_SOURCE_PIXELS` is refused like an image would be.
export const MAX_TILED_SOURCE_PIXELS = 200_000_000;

// Overridable, and for the same reason `extractWithRetry` lets a battery move the clock: what these
// bound is MEMORY, and a test that cannot lower the cap can only exercise it by allocating the 200 MB
// the cap exists to prevent, while one that cannot stand in for the decoder cannot watch the native
// handles being released. Production passes neither.
export type ConvertOptions = {
  readonly maxSourcePixels?: number;
  readonly maxTiledSourcePixels?: number;
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

// WHAT THIS FILE IS, in the words the operator's line will use. Three answers and not two, because
// the two ways of not being a HEIC are different facts and the line names one of them: a 703-byte
// JPEG reported as `<too short>` sends whoever reads it looking for a truncated upload. The whole
// PR is about that line.
type HeicHeader =
  | { kind: "brand"; brand: string }
  | { kind: "too-short" }
  | { kind: "not-ftyp" };

function heicHeader(bytes: ArrayBuffer): HeicHeader {
  if (bytes.byteLength < 12) return { kind: "too-short" };
  // NOTE: the box before the brand: a JPEG whose first marker is a comment can carry "heic" at
  // offset 8, and reading the brand alone would call it a broken HEIC and skip a readable file.
  if (ascii(bytes, 4) !== "ftyp") return { kind: "not-ftyp" };
  // With `size == 1` the real size occupies the next 64 bits, so the brand sits at 16 and
  // offset 8 holds the high half of a length.
  const header = new DataView(bytes).getUint32(0) === 1 ? 16 : 8;
  if (bytes.byteLength < header + 4) return { kind: "too-short" };
  return { kind: "brand", brand: ascii(bytes, header) };
}

function headerReason(h: HeicHeader): string {
  if (h.kind === "too-short") return "is too short to carry one";
  if (h.kind === "not-ftyp") return "does not open with an `ftyp` box";
  return `carries brand "${h.brand}"`;
}

function ascii(bytes: ArrayBuffer, offset: number): string {
  return String.fromCharCode(...new Uint8Array(bytes, offset, 4))
    .replace("\0", " ")
    .trim();
}

// The size the file says it stores, read from the file rather than the decoder: with a `clap` crop,
// libheif reports the CROPPED size while decoding the whole stored image, so a 1x1 crop over 100 Mpx
// would pass a cap. On libheif-js 1.23.2 `get_ispe_width` answers 0 and the maximum-size limit refuses
// nothing, so this reads `ispe` (mandatory) via `meta` > `iprp` > `ipco` and takes the LARGEST. An
// unparseable file returns 0, and the cap falls back to the decoder's numbers.
const ISPE_CAP_DEPTH: ReadonlyArray<[string, number]> = [
  ["meta", 12], // FullBox: 4 more bytes of version/flags before the children
  ["iprp", 8],
  ["ipco", 8],
];

export function storedPixels(bytes: ArrayBuffer): number {
  const v = new DataView(bytes);
  let most = 0;
  const walk = (start: number, end: number, depth: number): void => {
    let i = start;
    while (i + 8 <= end) {
      const declared = v.getUint32(i);
      const type = ascii(bytes, i + 4);
      // The three ways a BMFF box states its size; stopping at `size == 1` would find no ispe
      // and hand the cap back to the cropped dimensions.
      //   0  the box runs to the end of the file
      //   1  the real size is the 64-bit value after the type
      //   n  the size, header included
      let size = declared;
      let header = 8;
      if (declared === 0) size = end - i;
      else if (declared === 1) {
        if (i + 16 > end) return;
        // Read as two 32-bit words rather than through `getBigUint64`: a non-zero high word means a
        // box of at least 4 GiB, which no buffer that reached here can contain, so it is out of
        // range for the same reason the length guard below is. Spelling it this way also keeps the
        // tree's one bounded `BigInt` parse the only cast of its kind
        // (tests/lib/caller-id-spelling.test.ts sweeps for the spelling, not for the intent).
        if (v.getUint32(i + 8) !== 0) return;
        size = v.getUint32(i + 12);
        header = 16;
      }
      if (size < header || i + size > end) return;
      if (type === "ispe" && i + header + 12 <= end)
        most = Math.max(
          most,
          v.getUint32(i + header + 4) * v.getUint32(i + header + 8),
        );
      const step = ISPE_CAP_DEPTH[depth];
      if (step !== undefined && type === step[0])
        walk(i + header + (step[1] - 8), i + size, depth + 1);
      i += size;
    }
  };
  try {
    walk(0, bytes.byteLength, 0);
  } catch {
    // A malformed file is not this function's problem: the decoder refuses it a moment later, and a
    // cap that threw here would turn a broken HEIC into an unhandled error instead of a skip.
    return 0;
  }
  return most;
}

async function heicToJpeg(
  bytes: ArrayBuffer,
  opts: ConvertOptions,
): Promise<ArrayBuffer> {
  const header = heicHeader(bytes);
  if (header.kind !== "brand" || !HEIC_BRANDS.has(header.brand))
    throw new MediaSourceMismatchError(
      `declared as heic but ${headerReason(header)}`,
    );
  const open = opts.withFrames ?? withHeicFrames;
  const cap = opts.maxSourcePixels ?? MAX_SOURCE_PIXELS;
  const whole = await open(bytes, async (frames: readonly HeicFrame[]) => {
    // The PRIMARY image (`pitm`), not the first: libheif returns a collection in storage
    // order, and unlike a GIF's frames these are separate pictures with one designated. The fallback
    // to the first is unreachable with this libheif (a file without `pitm` yields zero images); it
    // keeps "carries no image frame" from being thrown about a file that has frames.
    const frame = frames.find((f) => f.primary) ?? frames[0];
    if (frame === undefined)
      throw new MediaConversionError("heic carries no image frame");
    const { width, height } = frameDimensions(frame);
    // The larger of what the decoder reports and what the file says it stores, because a crop makes
    // the first smaller than the work the decode actually does.
    const stored = storedPixels(bytes);
    // FAIL CLOSED when the file will not say. `ispe` is mandatory in HEIF and every file libheif
    // accepts carries one, so finding none means the container is malformed or beyond this walker —
    // and falling back to the decoder's numbers there is precisely the hole, because the attacker
    // chooses the container. A guard that opens when it cannot read itself is not a guard.
    if (stored === 0)
      throw new MediaConversionError(
        "heic does not declare the size it stores, so the pixel cap cannot be applied",
      );
    // Both numbers come from `ispe`, while decode cost comes from the HEVC bitstream. libheif
    // refuses coded dimensions that disagree with the signalled ones BEFORE decoding; that is the
    // dependency's property, pinned by a test.
    const pixels = Math.max(width * height, stored);
    const tooLarge = new MediaTooLargeError(
      `heic is ${width}x${height} and stores ${pixels} px, over the ${cap} px cap`,
    );
    if (pixels > cap) return { tooLarge, pixels };
    const raw = await frame.decode();
    return rasterToJpeg(raw, {
      maxEdge: MAX_OUTPUT_EDGE,
      quality: JPEG_QUALITY,
    });
  });
  if (whole instanceof ArrayBuffer) return whole;
  // Decided inside, decoded outside: the whole-image decoder is released before the grid decode opens
  // its own context, so the two never hold the file at once.
  if (whole.pixels > (opts.maxTiledSourcePixels ?? MAX_TILED_SOURCE_PIXELS))
    throw whole.tooLarge;
  const grid = await decodeGridFitted(bytes, {
    maxEdge: MAX_OUTPUT_EDGE,
    maxTilePixels: cap,
  });
  if (grid.kind !== "decoded") throw whole.tooLarge;
  return encodeJpeg(grid.image, JPEG_QUALITY);
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
