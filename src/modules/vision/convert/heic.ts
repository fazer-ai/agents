// OWNERSHIP OF THE DECODER, ours rather than the library's, and the reason is licensing before it is
// anything else. libheif is LGPL-3.0 and this product is proprietary, so §4(d)(1) of that licence
// asks for "a suitable shared library mechanism" — one that "will operate properly with a modified
// version of the Library that is interface-compatible". The `heic-decode` wrapper reaches libheif
// through `libheif-js/wasm-bundle`, which base64's the binary INSIDE a 1.9 MB JavaScript file:
// nothing an operator can replace without rebuilding. Here the binary is the 1.4 MB `libheif.wasm`
// on disk, loaded by path, and the path is overridable — so swapping libheif is copying a file.
//
// The same change happens to answer two engineering findings from the review of #697: we now release
// the decoder on the failure paths the library never returned a handle for, and the WASM is loaded
// lazily instead of at import time.
//
// Byte-identity with the previous path was measured before the swap: the same fixture through
// `heic-decode` and through this module returns 15,360,000 bytes of RGBA with zero differences.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export type HeicFrame = {
  readonly width: number;
  readonly height: number;
  decode(): Promise<{
    data: Uint8ClampedArray;
    width: number;
    height: number;
  }>;
};

type HeifImage = {
  get_width(): number;
  get_height(): number;
  display(
    target: { data: Uint8ClampedArray; width: number; height: number },
    cb: (out: { data: Uint8ClampedArray } | null) => void,
  ): void;
};

type LibHeif = {
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

// THE DECODER IS ALWAYS RELEASED, on every path out, because it is ours from the moment it is built.
// This is what `heic-decode` could not offer: it constructs the decoder and only then decides whether
// to hand the caller anything to release, so a file that parses to zero images strands the context
// with no handle left to free it (measured at 6.5 KB per malformed file; PR #707 review round 2).
//
// `delete()` is the whole release and the only one: it is the embind destructor bound to
// `heif_context_free`, so calling both throws "Cannot pass deleted object as a pointer". Measured
// over 500 malformed files: no release drifts the wasm heap by 400 KB, either call alone by 440
// bytes, which is one allocator step and not per-file. Forty full decodes of the 2400x1600 fixture
// leave the same 440, so the wrapper releases the image handles with the context.
export async function withHeicFrames<T>(
  bytes: ArrayBuffer,
  use: (frames: readonly HeicFrame[]) => Promise<T>,
): Promise<T> {
  const libheif = await loadLibheif();
  const decoder = new libheif.HeifDecoder();
  try {
    const images = decoder.decode(new Uint8Array(bytes));
    return await use(
      images.map((image) => ({
        // Read eagerly: the caller needs them to apply its pixel cap BEFORE any pixel is decoded,
        // and after `decoder.delete()` the handle is gone.
        width: image.get_width(),
        height: image.get_height(),
        decode: () => displayImage(image),
      })),
    );
  } finally {
    decoder.decoder?.delete();
  }
}

function displayImage(
  image: HeifImage,
): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const width = image.get_width();
  const height = image.get_height();
  return new Promise((resolve, reject) => {
    image.display(
      { data: new Uint8ClampedArray(width * height * 4), width, height },
      (out) =>
        out
          ? resolve({ data: out.data, width, height })
          : reject(new Error("libheif could not render the image")),
    );
  });
}
