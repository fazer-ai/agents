// We own the libheif decoder rather than going through `heic-decode`, for licensing first: libheif
// is LGPL-3.0, and §4(d)(1) asks for a mechanism that works with a modified, interface-compatible
// library. The wrapper embeds the binary base64'd in a JS file; here it is `libheif.wasm` on disk,
// loaded lazily by an overridable path, so swapping libheif is copying a file. Owning it also lets
// us release the decoder on every failure path.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { FitAccumulator, type Rgba } from "./raster";

export type HeicFrame = {
  readonly width: number;
  readonly height: number;
  // `pitm`, the image the file DESIGNATES as the one it is of. Carried out because libheif returns
  // items in storage order and the designation is not part of it.
  readonly primary: boolean;
  decode(): Promise<{
    data: Uint8ClampedArray;
    width: number;
    height: number;
    // Carried on the DECODED buffer rather than the frame, because it describes those bytes: the
    // compositing step downstream is the only thing that needs it.
    premultiplied: boolean;
  }>;
};

type HeifImage = {
  get_width(): number;
  get_height(): number;
  is_primary(): boolean;
  is_premultiplied_alpha(): boolean;
  // `heif_image_handle_release`, and it is NOT covered by freeing the context: see the release below.
  free(): void;
  display(
    target: { data: Uint8ClampedArray; width: number; height: number },
    cb: (out: { data: Uint8ClampedArray } | null) => void,
  ): void;
};

// The C API underneath the embind wrapper, which is where libheif's grid calls live: the wrapper
// exposes whole-image decoding only. Every `heif_error` comes back through a pointer passed first
// (the wasm32 ABI for a returned struct), and every pointer is an offset into `HEAPU8`.
type LibHeifC = {
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  HEAPU32: Uint32Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _heif_context_alloc(): number;
  _heif_context_free(ctx: number): void;
  _heif_context_read_from_memory_without_copy(
    err: number,
    ctx: number,
    data: number,
    size: number,
    options: number,
  ): void;
  _heif_context_get_primary_image_handle(
    err: number,
    ctx: number,
    out: number,
  ): void;
  _heif_image_handle_release(handle: number): void;
  _heif_image_handle_get_width(handle: number): number;
  _heif_image_handle_get_height(handle: number): number;
  _heif_image_handle_has_alpha_channel(handle: number): number;
  _heif_image_handle_get_image_tiling(
    err: number,
    handle: number,
    processTransformations: number,
    out: number,
  ): void;
  _heif_image_handle_decode_image_tile(
    err: number,
    handle: number,
    out: number,
    colorspace: number,
    chroma: number,
    options: number,
    tileX: number,
    tileY: number,
  ): void;
  _heif_image_handle_get_grid_image_tile_id(
    err: number,
    handle: number,
    processTransformations: number,
    tileX: number,
    tileY: number,
    out: number,
  ): void;
  _heif_image_release(image: number): void;
  _heif_image_get_primary_width(image: number): number;
  _heif_image_get_primary_height(image: number): number;
  _heif_image_get_plane_readonly2(
    image: number,
    channel: number,
    outStride: number,
  ): number;
};

type LibHeif = LibHeifC & {
  ready: Promise<unknown>;
  HeifDecoder: new () => {
    decode(bytes: Uint8Array): HeifImage[];
    // Null until `decode` runs, and still null if libheif could not allocate a context, which is why
    // the release below is guarded rather than unconditional.
    decoder: { delete(): void } | null;
  };
};

// WHERE THE LIBRARY LIVES, and the override is the point rather than a convenience: it is what makes
// the copy replaceable without rebuilding anything of ours. Default is the one npm installed.
export const LIBHEIF_WASM_PATH_ENV = "VISION_LIBHEIF_WASM_PATH";

export function libheifWasmPath(): string {
  const override = (process.env[LIBHEIF_WASM_PATH_ENV] ?? "").trim();
  if (override !== "") return override;
  const entry = createRequire(import.meta.url).resolve(
    "libheif-js/libheif-wasm/libheif.js",
  );
  return join(dirname(entry), "libheif.wasm");
}

// LAZY, and cached across calls. The binary is 1.4 MB and instantiating it costs real milliseconds,
// which a deployment that never receives a HEIC should not pay at boot — and vision may not even be
// enabled. The promise is memoised rather than the module, so two conversions racing the first load
// wait on one instantiation instead of building two.
let loading: Promise<LibHeif> | null = null;

export function loadLibheif(): Promise<LibHeif> {
  if (loading === null) {
    loading = (async () => {
      const path = libheifWasmPath();
      const factory = createRequire(import.meta.url)(
        "libheif-js/libheif-wasm/libheif.js",
      ) as (opts: { wasmBinary: Uint8Array }) => LibHeif;
      const lib = factory({ wasmBinary: readFileSync(path) });
      await lib.ready;
      return lib;
    })().catch((err) => {
      // A failed load must not poison every later attempt: the file may have been replaced while the
      // process was up, which is exactly the swap this module is shaped to allow.
      loading = null;
      throw err;
    });
  }
  return loading;
}

// Exported for the battery only. The memo is the whole point of `loadLibheif`, and it is also what
// makes "which file did it actually read" untestable from outside: the first successful load wins
// for the rest of the process. Dropping it is the only way to ask the question twice.
export function __resetLibheifForTest(): void {
  loading = null;
}

// Everything is released on every path out, including a file that parses to zero images. Two
// releases, and neither covers the other: the context via `decoder.delete()` (the embind destructor
// for `heif_context_free`; calling both throws), and each image via `image.free()`
// (`heif_image_handle_release`), which freeing the context does NOT do and which holds the DECODED
// image. The leak is invisible from outside (RSS is dominated by the returned RGBA and GC timing), so
// `lib` lets a test stand in for the library and assert every handle is released.
export async function withHeicFrames<T>(
  bytes: ArrayBuffer,
  use: (frames: readonly HeicFrame[]) => Promise<T>,
  lib?: LibHeif,
): Promise<T> {
  const libheif = lib ?? (await loadLibheif());
  const decoder = new libheif.HeifDecoder();
  let images: HeifImage[] = [];
  try {
    images = decoder.decode(new Uint8Array(bytes));
    return await use(
      images.map((image) => ({
        // Read eagerly: the caller needs them to apply its pixel cap BEFORE any pixel is decoded,
        // and after the release below the handle is gone.
        width: image.get_width(),
        height: image.get_height(),
        primary: image.is_primary(),
        decode: () => displayImage(image),
      })),
    );
  } finally {
    // Images before the context: a handle holds a reference into it. `free()` is idempotent (it
    // nulls its own pointer), and a `decode` that threw leaves the list empty.
    for (const image of images) image.free();
    decoder.decoder?.delete();
  }
}

function displayImage(image: HeifImage): Promise<{
  data: Uint8ClampedArray;
  width: number;
  height: number;
  premultiplied: boolean;
}> {
  const width = image.get_width();
  const height = image.get_height();
  const premultiplied = image.is_premultiplied_alpha();
  return new Promise((resolve, reject) => {
    image.display(
      { data: new Uint8ClampedArray(width * height * 4), width, height },
      (out) =>
        out
          ? resolve({ data: out.data, width, height, premultiplied })
          : reject(new Error("libheif could not render the image")),
    );
  });
}

// libheif's enum values, from heif_image.h and heif_tiling.h in the version the binary is built from.
const HEIF_COLORSPACE_RGB = 1;
const HEIF_CHROMA_INTERLEAVED_RGBA = 11;
const HEIF_CHANNEL_INTERLEAVED = 10;
// `struct heif_image_tiling` on wasm32: an int version, eight uint32 (columns, rows, tile width and
// height, image width and height, top and left offset), a uint8 and eight more uint32 after padding.
// The two offsets are not read: see `placement`.
const TILING_STRUCT_BYTES = 72;

export type GridDecode =
  | { kind: "not-a-grid" }
  | { kind: "tile-too-large"; tileWidth: number; tileHeight: number }
  // A crop, or a transform whose padded side cannot be told apart: see `placement`.
  | { kind: "unsupported"; reason: string }
  | { kind: "decoded"; image: Rgba };

// A GRID image decoded one tile at a time into `FitAccumulator`, so what is alive at once is one
// decoded tile plus the output's sums, never the full image. Tiles are asked for in the TRANSFORMED
// image (rotation and mirror applied), which is the picture the file shows and the one the
// whole-image decode produces.
// Returns `not-a-grid` for an image stored in one piece, since decoding its single "tile" is decoding
// the whole image. Everything allocated is released on every path out.
export async function decodeGridFitted(
  bytes: ArrayBuffer,
  opts: { maxEdge: number; maxTilePixels: number },
  lib?: LibHeifC,
): Promise<GridDecode> {
  const c = lib ?? (await loadLibheif());
  const err = c._malloc(12);
  const out = c._malloc(4);
  const tiling = c._malloc(TILING_STRUCT_BYTES);
  const data = c._malloc(bytes.byteLength);
  const ctx = c._heif_context_alloc();
  let handle = 0;
  const check = (what: string) => {
    const code = c.HEAP32[err >> 2] as number;
    if (code !== 0)
      throw new Error(
        `libheif ${what} failed (${code}/${c.HEAP32[(err >> 2) + 1]})`,
      );
  };
  try {
    c.HEAPU8.set(new Uint8Array(bytes), data);
    c._heif_context_read_from_memory_without_copy(
      err,
      ctx,
      data,
      bytes.byteLength,
      0,
    );
    check("read");
    c._heif_context_get_primary_image_handle(err, ctx, out);
    check("primary handle");
    handle = c.HEAPU32[out >> 2] as number;
    const readTiling = (transformed: number) => {
      c.HEAPU8.fill(0, tiling, tiling + TILING_STRUCT_BYTES);
      c._heif_image_handle_get_image_tiling(err, handle, transformed, tiling);
      check("tiling");
      const t = (i: number) => c.HEAPU32[(tiling >> 2) + i] as number;
      return {
        columns: t(1),
        rows: t(2),
        tileWidth: t(3),
        tileHeight: t(4),
        width: t(5),
        height: t(6),
      };
    };
    const stored = readTiling(0);
    const shown = readTiling(1);
    const { columns, rows, tileWidth, tileHeight } = shown;
    if (columns * rows <= 1) return { kind: "not-a-grid" };
    if (tileWidth * tileHeight > opts.maxTilePixels)
      return { kind: "tile-too-large", tileWidth, tileHeight };
    // A tile decode does not carry the alpha, which lives in an auxiliary image of its own: the
    // transparent part comes back black and opaque, and a cutout would reach the model on black.
    if (c._heif_image_handle_has_alpha_channel(handle) !== 0)
      return { kind: "unsupported", reason: "a grid with alpha" };
    const width = c._heif_image_handle_get_width(handle);
    const height = c._heif_image_handle_get_height(handle);
    // Tiles are decoded whole, padding included, so the work is what they cover and not the image:
    // a thin grid (150,000,000x1 in 512x512 tiles) decodes 512 times its pixels, time the cap on the
    // image's pixels does not see. A photo's grid covers it plus at most one tile per axis.
    if (columns * rows * tileWidth * tileHeight > 2 * width * height)
      return {
        kind: "unsupported",
        reason: "a grid whose tiles cover more than twice the image",
      };
    const tileId = (transformed: number, x: number, y: number) => {
      c._heif_image_handle_get_grid_image_tile_id(
        err,
        handle,
        transformed,
        x,
        y,
        out,
      );
      check(`tile id ${x},${y}`);
      return c.HEAPU32[out >> 2] as number;
    };
    const place = placement(stored, shown, width, height, tileId);
    if (typeof place === "string")
      return { kind: "unsupported", reason: place };
    const { leftOffset, topOffset } = place;
    const fit = new FitAccumulator(width, height, opts.maxEdge);
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < columns; tx++) {
        const piece = decodeTile(c, handle, err, out, tx, ty, check);
        try {
          const left = tx * tileWidth - leftOffset;
          const top = ty * tileHeight - topOffset;
          const clipped = clipTile(c, piece, left, top, width, height);
          if (clipped === null) continue;
          fit.add(clipped.rgba, clipped.left, clipped.top);
        } finally {
          c._heif_image_release(piece);
        }
      }
    }
    return { kind: "decoded", image: fit.result() };
  } finally {
    if (handle !== 0) c._heif_image_handle_release(handle);
    c._heif_context_free(ctx);
    for (const p of [err, out, tiling, data]) c._free(p);
  }
}

type Tiling = {
  columns: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  width: number;
  height: number;
};

// WHERE THE TOP-LEFT TILE SITS in the shown image. A grid's padding lies past the stored right and
// bottom edges, and a rotation or mirror can move it to the left or top. libheif 1.23.2 reports that
// offset wrong (276 for a 90-degree turn whose tiles start 236 px in), so it is derived from which
// stored tile each shown tile is: per shown axis, the stored axis it runs along and whether it runs
// backwards, which puts the stored end padding at the shown start. A crop is refused, since it moves
// the picture by an amount this does not read, and so is a padded axis only one tile long, whose
// direction no second tile tells.
function placement(
  stored: Tiling,
  shown: Tiling,
  width: number,
  height: number,
  tileId: (transformed: number, x: number, y: number) => number,
): { leftOffset: number; topOffset: number } | string {
  const where = new Map<number, [number, number]>();
  for (let y = 0; y < stored.rows; y++)
    for (let x = 0; x < stored.columns; x++) where.set(tileId(0, x, y), [x, y]);
  const at = (x: number, y: number) => {
    const p = where.get(tileId(1, x, y));
    if (p === undefined)
      throw new Error("libheif mapped a tile outside its grid");
    return p;
  };
  const origin = at(0, 0);
  // Whether the shown axes run along the stored ones or across them, read off a second tile: the
  // sizes cannot say it for a square grid, where a 180-degree turn and a 90-degree one agree on them.
  const swapped =
    shown.columns > 1
      ? (at(1, 0)[0] as number) === (origin[0] as number)
      : (at(0, 1)[1] as number) === (origin[1] as number);
  const [storedWidth, storedHeight] = swapped
    ? [stored.height, stored.width]
    : [stored.width, stored.height];
  if (width !== storedWidth || height !== storedHeight) return "a cropped grid";
  // Padding at the END of each stored axis, in pixels.
  const pad = [
    stored.columns * stored.tileWidth - stored.width,
    stored.rows * stored.tileHeight - stored.height,
  ];
  // The shown axis runs along stored axis `swapped ? 1 - i : i`; which way is read off its second
  // tile when it has one.
  const offset = (axis: 0 | 1, count: number): number | string => {
    const storedAxis = swapped ? 1 - axis : axis;
    if ((pad[storedAxis] as number) === 0) return 0;
    if (count < 2) return "a padded grid axis one tile long";
    const next = axis === 0 ? at(1, 0) : at(0, 1);
    const backwards =
      (next[storedAxis] as number) < (origin[storedAxis] as number);
    return backwards ? (pad[storedAxis] as number) : 0;
  };
  const leftOffset = offset(0, shown.columns);
  const topOffset = offset(1, shown.rows);
  if (typeof leftOffset === "string") return leftOffset;
  if (typeof topOffset === "string") return topOffset;
  return { leftOffset, topOffset };
}

function decodeTile(
  c: LibHeifC,
  handle: number,
  err: number,
  out: number,
  tx: number,
  ty: number,
  check: (what: string) => void,
): number {
  c._heif_image_handle_decode_image_tile(
    err,
    handle,
    out,
    HEIF_COLORSPACE_RGB,
    HEIF_CHROMA_INTERLEAVED_RGBA,
    0,
    tx,
    ty,
  );
  check(`tile ${tx},${ty}`);
  return c.HEAPU32[out >> 2] as number;
}

// The part of a decoded tile that lies inside the image, copied out of the wasm heap row by row (the
// plane's stride can be wider than the tile). Null when none of it does.
function clipTile(
  c: LibHeifC,
  image: number,
  left: number,
  top: number,
  width: number,
  height: number,
): { rgba: Rgba; left: number; top: number } | null {
  const tw = c._heif_image_get_primary_width(image);
  const th = c._heif_image_get_primary_height(image);
  const x0 = Math.max(0, left);
  const y0 = Math.max(0, top);
  const x1 = Math.min(width, left + tw);
  const y1 = Math.min(height, top + th);
  if (x1 <= x0 || y1 <= y0) return null;
  const strideAt = c._malloc(4);
  try {
    const plane = c._heif_image_get_plane_readonly2(
      image,
      HEIF_CHANNEL_INTERLEAVED,
      strideAt,
    );
    if (plane === 0) throw new Error("libheif tile has no interleaved plane");
    const stride = c.HEAPU32[strideAt >> 2] as number;
    const w = x1 - x0;
    const h = y1 - y0;
    const data = new Uint8ClampedArray(w * h * 4);
    const heap = c.HEAPU8;
    for (let y = 0; y < h; y++) {
      const from = plane + (y0 - top + y) * stride + (x0 - left) * 4;
      data.set(heap.subarray(from, from + w * 4), y * w * 4);
    }
    return { rgba: { data, width: w, height: h }, left: x0, top: y0 };
  } finally {
    c._free(strideAt);
  }
}

// Exported for the battery: a crop and a one-tile padded axis are refusals no fixture here reaches.
export const __placementForTest = placement;
