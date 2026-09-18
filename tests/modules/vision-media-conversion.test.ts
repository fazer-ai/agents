import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import {
  __frameDimensionsForTest,
  __serializedForTest,
  MAX_SOURCE_PIXELS,
  MediaConversionError,
  MediaSourceMismatchError,
  runMediaConverter,
  storedPixels,
} from "@/modules/vision/convert";
import {
  __resetLibheifForTest,
  LIBHEIF_WASM_PATH_ENV,
  libheifWasmPath,
  loadLibheif,
  withHeicFrames,
} from "@/modules/vision/convert/heic";
import {
  fitRgba,
  flattenOntoWhite,
  rasterToJpeg,
} from "@/modules/vision/convert/raster";
import {
  MEDIA_CONVERTERS,
  mediaSubtype,
  normalizeMediaType,
  planImageConversion,
} from "@/modules/vision/media-conversion";
import { visionKindForMime } from "@/modules/vision/providers";

const HEIC = readFileSync(`${import.meta.dir}/../fixtures/media/recibo.heic`);
// A cutout: left half opaque red, right half fully transparent. Made the way iOS's "remove
// background" makes one, `sips -s format heic` from an RGBA PNG, and the alpha survives the decode
// (measured: the transparent half comes back with a = 0).
const ALPHA = readFileSync(
  `${import.meta.dir}/../fixtures/media/recorte-alpha.heic`,
);
// A three-image collection whose PRIMARY is the MIDDLE item: flat blue 512x512, flat red 2400x1200,
// flat green 300x300, with `pitm` pointing at the red one. Three and not two on purpose — with two,
// "take the last" and "take the designated" agree, and the mutation battery showed that a two-image
// fixture cannot tell the fix from a different wrong answer. Built with libheif's own encoder
// (`heif-enc azul512.png vermelho2400.png verde300.png`, which makes the first input primary) and
// then patching the two-byte item id inside the `pitm` box from 1 to 2, which is the only way to get
// the two orders to disagree — every encoder writes the primary first.
// A HEIC written with premultiplied alpha (`heif-enc --premultiplied-alpha`): 64x64 of a single
// pixel value, RGBA (100, 0, 0, 128), where the 100 is ALREADY the colour scaled by the alpha.
// libheif reports `is_premultiplied_alpha()` true for it and hands those exact bytes back.
const PREMULT = readFileSync(
  `${import.meta.dir}/../fixtures/media/alfa-premultiplicado.heic`,
);
// The SAME source PNG encoded without `--premultiplied-alpha`. It decodes to the identical bytes and
// differs only in the flag, which is what makes the flag the only thing that says which formula is
// owed.
const STRAIGHT = readFileSync(
  `${import.meta.dir}/../fixtures/media/alfa-straight.heic`,
);
// The premultiplied fixture with a 1x1 `clap` (clean aperture) crop spliced in: a `clap` box appended
// to `ipco`, one more association in `ipma`, and every `iloc` offset shifted by the 41 bytes those
// two added. libheif then reports the image as 1x1 while the file still stores 64x64, which is the
// disagreement the pixel cap has to survive.
const CLAP = readFileSync(
  `${import.meta.dir}/../fixtures/media/recorte-clap.heic`,
);
const COLECAO = readFileSync(
  `${import.meta.dir}/../fixtures/media/colecao-primaria-nao-e-a-primeira.heic`,
);
// A HEIC header carrying a real brand, with nothing behind it. The brand lives at offset 8, inside
// the `ftyp` box, which is why a string starting with "ftyp" is NOT one — the first four bytes are
// the box size.
const brandedHeic = (brand = "heic", extra = 0): ArrayBuffer => {
  const b = new Uint8Array(12 + extra);
  b.set([0, 0, 0, 12], 0);
  b.set(new TextEncoder().encode("ftyp"), 4);
  b.set(new TextEncoder().encode(brand), 8);
  return b.buffer as ArrayBuffer;
};

// A real HEIC cut short: the brand is intact, so the type did not lie, and the decode still fails.
const truncatedHeic = () => heicBytes().slice(0, 40);

// The first eight bytes of a real HEIC — box size and `ftyp` — and nothing behind them. Exactly the
// input that gets past a `ftyp` check and into a brand read that has no bytes to read.
const ftypPrefix = (total: number): ArrayBuffer => {
  const b = new Uint8Array(total);
  b.set([0, 0, 0, 12], 0);
  b.set(new TextEncoder().encode("ftyp"), 4);
  return b.buffer as ArrayBuffer;
};

const heicBytes = () =>
  HEIC.buffer.slice(
    HEIC.byteOffset,
    HEIC.byteOffset + HEIC.byteLength,
  ) as ArrayBuffer;

describe("normalizeMediaType / mediaSubtype", () => {
  test("strips parameters and case, and survives the absent mime", () => {
    expect(normalizeMediaType("IMAGE/HEIC")).toBe("image/heic");
    expect(normalizeMediaType("image/jpeg; charset=binary")).toBe("image/jpeg");
    expect(normalizeMediaType("  image/png  ")).toBe("image/png");
    expect(normalizeMediaType(null)).toBe("");
    expect(mediaSubtype("image/heic; x=1")).toBe("heic");
    // Not an image: there is no subtype to speak of, and answering "pdf" here would make a document
    // look up its own name in the image table.
    expect(mediaSubtype("application/pdf")).toBe("");
  });

  test("a PDF whose content type carries a parameter is still a document", () => {
    // The bug the dedupe fixed: `application/pdf; charset=binary` matched neither the equality nor
    // the `/pdf` suffix, so Chatwoot serving that spelling meant the document was never read.
    expect(visionKindForMime("application/pdf; charset=binary")).toBe(
      "document",
    );
    expect(visionKindForMime("APPLICATION/PDF")).toBe("document");
  });
});

describe("planImageConversion", () => {
  // The table's source is each vendor's own documentation, read 2026-09-17, and for OpenAI also the
  // live API's 400, which enumerates ['png', 'jpeg', 'gif', 'webp'].
  const cases: Array<[string, string, "as-is" | "convert"]> = [
    // HEIC: the type the issue is about. Gemini documents it; the other two do not.
    ["openai", "image/heic", "convert"],
    ["anthropic", "image/heic", "convert"],
    ["gemini", "image/heic", "as-is"],
    ["gemini", "image/heif", "as-is"],
    ["openai", "image/heif", "convert"],
    // An endpoint we cannot speak for. Converting is the safe hand-off, because every vendor reads
    // a JPEG and none of them promised to read a HEIC.
    ["openai-compatible", "image/heic", "convert"],
    ["openrouter", "image/heic", "convert"],
    // What every provider reads: never touched, so the 98.6% of attachments that need nothing pay
    // nothing.
    ["openai", "image/jpeg", "as-is"],
    ["openai", "image/png", "as-is"],
    ["openai", "image/webp", "as-is"],
    ["anthropic", "image/gif", "as-is"],
    ["gemini", "image/png", "as-is"],
    // No converter exists, so the bytes go and the vendor answers for itself — deliberately NOT a
    // refusal (see the note on the two outcomes).
    ["openai", "image/tiff", "as-is"],
    ["openai", "image/avif", "as-is"],
    // A document is not this table's business.
    ["openai", "application/pdf", "as-is"],
    ["gemini", "application/pdf", "as-is"],
  ];

  for (const [provider, mimeType, action] of cases) {
    test(`${provider} + ${mimeType} -> ${action}`, () => {
      expect(planImageConversion({ provider, mimeType }).action).toBe(action);
    });
  }

  test("the parameterised spelling plans the same as the bare one", () => {
    expect(
      planImageConversion({
        provider: "openai",
        mimeType: "IMAGE/HEIC; charset=binary",
      }),
    ).toEqual({
      action: "convert",
      converter: "heic-to-jpeg",
      to: "image/jpeg",
    });
  });

  test("an absent mime converts nothing", () => {
    expect(
      planImageConversion({ provider: "openai", mimeType: null }).action,
    ).toBe("as-is");
  });

  test("every converter's target is native to every listed provider", async () => {
    // THE INVARIANT THAT REPLACES A RUNTIME BRANCH. `planImageConversion` does not check that the
    // type it converts INTO is one the provider reads, because today it always is; this is what
    // holds that true. A converter added with a target some listed provider cannot read fails here,
    // which is the moment the missing branch has to be written.
    for (const spec of MEDIA_CONVERTERS) {
      for (const provider of ["openai", "anthropic", "gemini"]) {
        const some = [...spec.from][0] as string;
        const plan = planImageConversion({ provider, mimeType: some });
        if (plan.action !== "convert") continue;
        // The target, planned for the same provider, must need no conversion of its own.
        expect(
          planImageConversion({ provider, mimeType: plan.to }).action,
        ).toBe("as-is");
      }
    }
  });

  test("every registered converter has an implementation", async () => {
    // The runtime mirror of the compile-time guarantee: `IMPLS` is a `Record` over the id union, so
    // this can only fail if the union and the registry are edited apart.
    for (const spec of MEDIA_CONVERTERS) {
      expect(spec.from.size).toBeGreaterThan(0);
      expect(spec.to).toMatch(/^[a-z]+\/[a-z0-9+.-]+$/);
      // Rejects for the CONTENT, never with "unknown converter", and always as this module's own
      // error type even when the refusal came from the third-party decoder.
      await expect(
        runMediaConverter(spec.id, brandedHeic()),
      ).rejects.toBeInstanceOf(MediaConversionError);
    }
  });
});

describe("frameDimensions", () => {
  test("reads the dimensions the runtime carries", () => {
    expect(
      __frameDimensionsForTest({ width: 4032, height: 3024, decode: () => {} }),
    ).toEqual({ width: 4032, height: 3024 });
  });

  test("refuses a frame without them instead of decoding unbounded", () => {
    // libheif ships no types at all, so the shape above is ours, asserted at runtime rather than by
    // the compiler: a library version that stops carrying the dimensions would silently remove the
    // pixel cap. It has to fail loudly instead.
    for (const frame of [
      { decode: () => {} },
      { width: 100, decode: () => {} },
      { width: "100", height: "80", decode: () => {} },
      // NaN is a `number` and `NaN > cap` is false, so a typeof-only check would let it walk past
      // the pixel cap into a decode of unknown size.
      { width: Number.NaN, height: 80, decode: () => {} },
      { width: 100, height: Number.POSITIVE_INFINITY, decode: () => {} },
      { width: 0, height: 80, decode: () => {} },
      { width: -100, height: 80, decode: () => {} },
      { width: 100.5, height: 80, decode: () => {} },
    ]) {
      expect(() => __frameDimensionsForTest(frame)).toThrow(
        MediaConversionError,
      );
    }
  });
});

describe("flattenOntoWhite", () => {
  test("leaves a fully opaque image untouched, allocation included", () => {
    const src = {
      data: new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]),
      width: 2,
      height: 1,
    };
    expect(flattenOntoWhite(src)).toBe(src);
  });

  test("composites over white and never mutates the caller's buffer", () => {
    const data = new Uint8Array([
      // opaque, half-transparent, fully transparent
      10, 20, 30, 255, 0, 0, 0, 128, 0, 0, 0, 0,
    ]);
    const src = { data, width: 3, height: 1 };
    const out = flattenOntoWhite(src);
    expect(out).not.toBe(src);
    expect([...out.data]).toEqual([
      10, 20, 30, 255,
      // 0 * (128/255) + 255 * (1 - 128/255) = 127.0…, truncated by the byte store
      127,
      127, 127, 255, 255, 255, 255, 255,
    ]);
    // The input is what the decoder handed us and the caller may still be holding it.
    expect([...data.slice(8)]).toEqual([0, 0, 0, 0]);
  });

  test("flattening BEFORE the resize is what keeps the cutout edge from darkening", () => {
    // The claim in the comment, with the arithmetic that makes it a claim. Three pixels, two opaque
    // red and one transparent black (what iOS leaves under a cutout), downscaled to two so the
    // second box STRADDLES the edge:
    //
    //   flatten, then fit   px1 is (220,30,30) and px2 is white, so the box averages to
    //                       ((220+255)/2, (30+255)/2, …) = (237, 142, 142)
    //   fit, then flatten   the box first averages colour AND alpha to (110,15,15) at a = 127, and
    //                       compositing that half-transparent dark value gives (183, 135, 135)
    //
    // 183 against 237 is the dark fringe, on every cutout, invisible in a green test.
    const src = {
      data: new Uint8Array([220, 30, 30, 255, 220, 30, 30, 255, 0, 0, 0, 0]),
      width: 3,
      height: 1,
    };
    const out = fitRgba(flattenOntoWhite(src), 2);
    expect([out.width, out.height]).toEqual([2, 1]);
    expect([...out.data.slice(0, 4)]).toEqual([220, 30, 30, 255]);
    expect([...out.data.slice(4, 8)]).toEqual([237, 142, 142, 255]);
  });

  test("the order inside rasterToJpeg is what the encoded bytes show", () => {
    // Driven through the real step, not through its parts, because the ORDER is what is asserted and
    // a test that composes the parts itself cannot see the step change. One-pixel vertical stripes,
    // opaque red beside transparent black, halved: EVERY output box straddles an edge, so the whole
    // image is one flat value and JPEG reproduces it exactly.
    //
    //   flatten, then fit   ((220+255)/2, (30+255)/2, …) = (237, 142, 142)
    //   fit, then flatten   colour and alpha average first to (110,15,15) at a = 127, and
    //                       compositing that gives (183, 135, 135)
    const w = 64;
    const h = 16;
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (x % 2 === 0) {
          data[i] = 220;
          data[i + 1] = 30;
          data[i + 2] = 30;
          data[i + 3] = 255;
        }
        // odd columns stay (0,0,0,0): transparent black, what iOS leaves under a cutout
      }
    const out = rasterToJpeg(
      { data, width: w, height: h },
      {
        maxEdge: w / 2,
        quality: 100,
      },
    );
    const img = jpeg.decode(new Uint8Array(out));
    expect([img.width, img.height]).toEqual([32, 8]);
    const mid = ((img.height >> 1) * img.width + (img.width >> 1)) * 4;
    // Room for JPEG, nowhere near the 54 levels of red that the wrong order costs.
    expect(img.data[mid]).toBeGreaterThan(225);
    expect(img.data[mid]).toBeLessThan(250);
  });

  test("premultiplied colour is not scaled by its alpha a second time", async () => {
    // Review round 10. libheif answers `is_premultiplied_alpha()` and hands back colour that is
    // already multiplied by the alpha; compositing it with the straight-alpha formula multiplies
    // again and darkens everything translucent. The arithmetic, on the fixture's (100, 0, 0, 128):
    //
    //   premultiplied (right)   100 + 255 * (1 - 128/255) = 227
    //   straight (wrong)        100 * (128/255) + 255 * (1 - 128/255) = 177
    //
    // Fifty levels of red on every cutout edge, and nothing about the output looks broken.
    const out = await runMediaConverter(
      "heic-to-jpeg",
      PREMULT.buffer.slice(
        PREMULT.byteOffset,
        PREMULT.byteOffset + PREMULT.byteLength,
      ) as ArrayBuffer,
    );
    const img = jpeg.decode(new Uint8Array(out));
    const mid = ((img.height >> 1) * img.width + (img.width >> 1)) * 4;
    expect(img.data[mid] as number).toBeGreaterThan(215);
    expect(img.data[mid] as number).toBeLessThan(240);
  });

  test("the two files decode to the SAME bytes, so only the flag can tell them apart", async () => {
    // Measured, and it is what makes this a correctness question rather than a heuristic one: the
    // same PNG encoded with and without `--premultiplied-alpha` comes back byte-identical. Nothing
    // in the pixels says which formula is owed, so discarding the flag is not a worse guess — it is
    // no information. Independently reproduced by the verifier's a5 addendum.
    const asArrayBuffer = (b: Buffer) =>
      b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    const raw = async (b: Buffer) =>
      withHeicFrames(asArrayBuffer(b), async (frames) => {
        const f = frames[0] as (typeof frames)[number];
        const d = await f.decode();
        return {
          first: [...d.data.slice(0, 4)],
          premultiplied: d.premultiplied,
        };
      });
    const pre = await raw(PREMULT);
    const straight = await raw(STRAIGHT);
    expect(pre.first).toEqual(straight.first);
    expect(pre.first).toEqual([100, 0, 0, 128]);
    expect([pre.premultiplied, straight.premultiplied]).toEqual([true, false]);
    // And the two conversions therefore differ only because the flag was read.
    const red = async (b: Buffer) => {
      const img = jpeg.decode(
        new Uint8Array(
          await runMediaConverter("heic-to-jpeg", asArrayBuffer(b)),
        ),
      );
      return img.data[
        ((img.height >> 1) * img.width + (img.width >> 1)) * 4
      ] as number;
    };
    expect(await red(PREMULT)).toBeGreaterThan(215);
    expect(await red(STRAIGHT)).toBeLessThan(200);
  });

  test("the formula follows the buffer's own flag, not the file it came from", () => {
    // Asserted on the primitive with both flags over the same bytes, so the two arms are one
    // comparison instead of two fixtures.
    const bytes = () => ({
      data: new Uint8Array([100, 0, 0, 128]),
      width: 1,
      height: 1,
    });
    expect(flattenOntoWhite({ ...bytes(), premultiplied: true }).data[0]).toBe(
      227,
    );
    expect(flattenOntoWhite({ ...bytes(), premultiplied: false }).data[0]).toBe(
      177,
    );
    // Absent means straight, which is what every other source here produces.
    expect(flattenOntoWhite(bytes()).data[0]).toBe(177);
    // AND IT SATURATES. Premultiplied colour is supposed to be at most its alpha, and lossy HEVC
    // does not have to honour that: [129, 129, 129, 128] composites to 256, which a plain
    // `Uint8Array` stores as 0 — a black pixel where the arithmetic asked for white (round 11, P2).
    expect(
      flattenOntoWhite({
        data: new Uint8Array([129, 129, 129, 128]),
        width: 1,
        height: 1,
        premultiplied: true,
      }).data[0],
    ).toBe(255);
  });

  test("a real HEIC cutout reaches the encoder white, not black", async () => {
    const out = await runMediaConverter(
      "heic-to-jpeg",
      ALPHA.buffer.slice(
        ALPHA.byteOffset,
        ALPHA.byteOffset + ALPHA.byteLength,
      ) as ArrayBuffer,
    );
    const img = jpeg.decode(new Uint8Array(out));
    const at = (x: number, y: number) => {
      const i = (y * img.width + x) * 4;
      return [img.data[i], img.data[i + 1], img.data[i + 2]];
    };
    // The opaque half keeps its colour, the transparent half is white. JPEG is lossy, so both are
    // asserted with room.
    const [lr, lg, lb] = at(Math.floor(img.width * 0.2), 10) as number[];
    const [rr, rg, rb] = at(Math.floor(img.width * 0.8), 10) as number[];
    expect(lr).toBeGreaterThan(180);
    expect(lg).toBeLessThan(90);
    expect(lb).toBeLessThan(90);
    expect(rr).toBeGreaterThan(240);
    expect(rg).toBeGreaterThan(240);
    expect(rb).toBeGreaterThan(240);
  });
});

describe("fitRgba", () => {
  const solid = (w: number, h: number) => ({
    data: new Uint8Array(w * h * 4).fill(200),
    width: w,
    height: h,
  });

  test("returns the input untouched when it already fits", () => {
    const src = solid(100, 80);
    const out = fitRgba(src, 1568);
    expect(out).toBe(src);
  });

  test("an image exactly ON the edge is not copied either", () => {
    // The boundary, and the only input that separates `scale >= 1` from `scale > 1`: at exactly the
    // edge a `>` would fall through and rebuild the whole buffer through 1x1 boxes, producing the
    // same pixels at the cost of a second 6 MB allocation per photo.
    const src = solid(1568, 1000);
    expect(fitRgba(src, 1568)).toBe(src);
  });

  test("scales the long edge down and keeps the aspect ratio", () => {
    const out = fitRgba(solid(4032, 3024), 1568);
    expect(out.width).toBe(1568);
    expect(out.height).toBe(1176);
    expect(out.data.length).toBe(1568 * 1176 * 4);
  });

  test("the portrait case scales on the OTHER edge", () => {
    const out = fitRgba(solid(3024, 4032), 1568);
    expect(out.height).toBe(1568);
    expect(out.width).toBe(1176);
  });

  test("an extreme ratio never rounds an edge to zero", () => {
    const out = fitRgba(solid(8000, 3), 1568);
    expect(out.width).toBe(1568);
    expect(out.height).toBe(1);
    // No NaN got averaged in: a box that rounded empty would divide by zero and paint the row black.
    expect([...out.data.slice(0, 4)]).toEqual([200, 200, 200, 200]);
  });

  test("averages the box instead of dropping pixels", () => {
    // Two columns, one black and one white: halving must produce the average, not whichever pixel
    // nearest-neighbour happened to land on.
    const data = new Uint8Array(2 * 1 * 4);
    data.set([0, 0, 0, 255], 0);
    data.set([200, 200, 200, 255], 4);
    const out = fitRgba({ data, width: 2, height: 1 }, 1);
    expect(out.width).toBe(1);
    expect(out.data[0]).toBe(100);
  });
});

describe("heic-to-jpeg", () => {
  test("what the implementation emits is the type the catalogue promises", async () => {
    // The catalogue's `to` is what the request carries as its mime, and the implementation is what
    // fills the bytes. Nothing in the type system ties the two, so changing one without the other
    // would send a JPEG labelled as something else — or the reverse — and the vendor would answer
    // about a file we never sent. Driven off the catalogue so a second converter is covered the day
    // it is added, with its own magic number named here.
    const MAGIC: Record<string, readonly number[]> = {
      "image/jpeg": [0xff, 0xd8],
      "image/png": [0x89, 0x50],
    };
    for (const spec of MEDIA_CONVERTERS) {
      const magic = MAGIC[spec.to];
      // A converter whose target has no magic listed is one nobody checked: name it above.
      expect(magic).toBeDefined();
      if (spec.from.has("image/heic")) {
        const out = new Uint8Array(
          await runMediaConverter(spec.id, heicBytes()),
        );
        expect([...out.slice(0, (magic as readonly number[]).length)]).toEqual([
          ...(magic as readonly number[]),
        ]);
      }
    }
  });

  test("produces a JPEG a decoder reads, fitted to the vendors' edge", async () => {
    const out = await runMediaConverter("heic-to-jpeg", heicBytes());
    const bytes = new Uint8Array(out);
    const img = jpeg.decode(bytes);
    // The fixture is 2400x1600, so the long edge lands on the cap and the ratio holds.
    expect(img.width).toBe(1568);
    expect(img.height).toBe(1045);
    // And it is smaller than the RGBA it came from, which is the only reason to encode at all.
    expect(out.byteLength).toBeLessThan(1568 * 1045 * 4);
  });

  test("the wasm binary is a replaceable file on disk, and the path is overridable", () => {
    // THE LICENSING SHAPE, asserted. libheif is LGPL-3.0 in a proprietary product, and §4(d)(1) of
    // that licence asks for a mechanism that "will operate properly with a modified version of the
    // Library that is interface-compatible". A 1.9 MB JavaScript file with the binary base64'd
    // inside it — what `libheif-js/wasm-bundle` ships, and what this module deliberately does not
    // use — is not one. A file on disk, found by a path the operator can override, is.
    const path = libheifWasmPath();
    expect(path.endsWith("libheif.wasm")).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(1_000_000);

    const before = process.env[LIBHEIF_WASM_PATH_ENV];
    try {
      process.env[LIBHEIF_WASM_PATH_ENV] = "/outro/lugar/libheif.wasm";
      expect(libheifWasmPath()).toBe("/outro/lugar/libheif.wasm");
      // Blank is not an override: an empty env var in a compose file must not point the loader at "".
      process.env[LIBHEIF_WASM_PATH_ENV] = "   ";
      expect(libheifWasmPath()).toBe(path);
    } finally {
      if (before === undefined) delete process.env[LIBHEIF_WASM_PATH_ENV];
      else process.env[LIBHEIF_WASM_PATH_ENV] = before;
    }
  });

  test("the loader really reads the binary at that path, and says so when it cannot", async () => {
    // The override is only worth the licence claim if it CHANGES WHICH BINARY RUNS. Asserted in both
    // directions: a path with nothing at it has to fail, and a copy of the binary somewhere else has
    // to convert. A loader that let emscripten find the package's own file would pass the second and
    // silently ignore the first.
    const real = libheifWasmPath();
    const copia = join(tmpdir(), `libheif-copia-${process.pid}.wasm`);
    const before = process.env[LIBHEIF_WASM_PATH_ENV];
    try {
      __resetLibheifForTest();
      process.env[LIBHEIF_WASM_PATH_ENV] = join(tmpdir(), "nao-existe.wasm");
      await expect(loadLibheif()).rejects.toThrow();
      // No reset here, deliberately: a failed load must not poison the next attempt on its own, or
      // an operator who fixed the path would have to restart the process. The recovery is the
      // module's, not the test's.
      copyFileSync(real, copia);
      process.env[LIBHEIF_WASM_PATH_ENV] = copia;
      const out = await runMediaConverter("heic-to-jpeg", heicBytes());
      expect(new Uint8Array(out)[0]).toBe(0xff);
    } finally {
      if (before === undefined) delete process.env[LIBHEIF_WASM_PATH_ENV];
      else process.env[LIBHEIF_WASM_PATH_ENV] = before;
      rmSync(copia, { force: true });
      __resetLibheifForTest();
    }
  });

  test("a failure from underneath the module still comes out as OUR error", async () => {
    // libheif and the WASM loader answer with their own classes — an unreadable binary is a plain
    // `Error` from readFileSync — and the caller catches one type. Without the wrap, a missing file
    // would surface as an ENOENT the service reads as "not a conversion failure".
    const before = process.env[LIBHEIF_WASM_PATH_ENV];
    try {
      __resetLibheifForTest();
      process.env[LIBHEIF_WASM_PATH_ENV] = join(tmpdir(), "nao-existe.wasm");
      const err = await runMediaConverter("heic-to-jpeg", heicBytes()).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(MediaConversionError);
      // The original is kept, because it is the only thing that says WHICH file failed.
      expect((err as Error).cause).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("heic-to-jpeg failed");
    } finally {
      if (before === undefined) delete process.env[LIBHEIF_WASM_PATH_ENV];
      else process.env[LIBHEIF_WASM_PATH_ENV] = before;
      __resetLibheifForTest();
    }
  });

  test("withHeicFrames decodes the real fixture and hands the dimensions back first", async () => {
    const seen = await withHeicFrames(heicBytes(), async (frames) => {
      expect(frames.length).toBe(1);
      const f = frames[0] as (typeof frames)[number];
      // Dimensions BEFORE any pixel work, which is what the cap needs.
      expect([f.width, f.height]).toEqual([2400, 1600]);
      const raw = await f.decode();
      return [raw.width, raw.height, raw.data.length] as const;
    });
    expect(seen).toEqual([2400, 1600, 2400 * 1600 * 4]);
  });

  test("the decoder is released even when the body throws", async () => {
    // The `finally` is what makes the ownership ours on every path, including the ones libheif's own
    // wrapper never returned a handle for. Observable here only as "the throw comes through and the
    // next call still works" — a wedged or leaked decoder shows up as the second call failing.
    await expect(
      withHeicFrames(heicBytes(), async () => {
        throw new Error("estourou no meio");
      }),
    ).rejects.toThrow("estourou no meio");
    const again = await withHeicFrames(heicBytes(), async (f) => f.length);
    expect(again).toBe(1);
  });

  test("a file that parses to no image still releases the decoder", async () => {
    // The case the previous wrapper could not release: it built the decoder and only then decided
    // whether to hand the caller anything to free. Truncated, brand intact, so it reaches libheif.
    const out = await withHeicFrames(truncatedHeic(), async (f) => f.length);
    expect(out).toBe(0);
  });

  test("a rejected file leaves NOTHING behind in the wasm heap", async () => {
    // The round 2 finding, as an assertion instead of a claim. A malformed file is the case the old
    // wrapper could not release — it built the decoder and threw before returning a handle — and it
    // cost 6.5 KB each. The probe is a malloc(1) against libheif's own heap: the pointer it returns
    // is the boundary of what is allocated, so two probes with the allocation released in between
    // are equal, and any residual shows up as the difference.
    const lib = (await loadLibheif()) as unknown as {
      _malloc(n: number): number;
      _free(p: number): void;
    };
    const probe = () => {
      const p = lib._malloc(1);
      lib._free(p);
      return p;
    };
    // One pass first, to take the allocator's own one-time step (440 bytes) out of the measurement.
    await withHeicFrames(truncatedHeic(), async (f) => f.length);
    const before = probe();
    for (let i = 0; i < 50; i++)
      await withHeicFrames(truncatedHeic(), async (f) => f.length);
    // Not "bounded", not "small": ZERO. Measured flat at 100, 500, 1000 and 2000 files too.
    expect(probe() - before).toBe(0);
  });

  test("every image handle is released, on every path out, and before the context", async () => {
    // Review round 5, and the finding my own round 2 measurement missed: freeing the CONTEXT does not
    // free the image handles, and what a handle retains is the decoded image. Measured over 400
    // conversions of the 2400x1600 fixture, the wasm heap grows 4.3 -> 9.5 -> 15.75 -> 23.25 MB
    // without `image.free()` and stays at 0 with it.
    //
    // Asserted here by standing in for the library, because measuring it takes a minute of real
    // decoding and because the ORDER is part of the contract: a handle holds a reference into the
    // context, so the context cannot go first.
    const trail: string[] = [];
    const fake = (n: number) =>
      ({
        ready: Promise.resolve(),
        HeifDecoder: class {
          decoder = { delete: () => trail.push("context") };
          decode() {
            return Array.from({ length: n }, (_, i) => ({
              get_width: () => 10,
              get_height: () => 10,
              is_primary: () => i === 0,
              free: () => trail.push(`image ${i}`),
              display: () => undefined,
            }));
          }
        },
      }) as unknown as Parameters<typeof withHeicFrames>[2];

    await withHeicFrames(heicBytes(), async () => "ok", fake(2));
    expect(trail).toEqual(["image 0", "image 1", "context"]);

    // The refusal paths are the ones that leaked in both review rounds, so each gets its own check.
    trail.length = 0;
    await expect(
      withHeicFrames(
        heicBytes(),
        async () => {
          throw new Error("estourou");
        },
        fake(1),
      ),
    ).rejects.toThrow("estourou");
    expect(trail).toEqual(["image 0", "context"]);

    // And a file that parses to nothing still releases the context it allocated.
    trail.length = 0;
    await withHeicFrames(heicBytes(), async (f) => f.length, fake(0));
    expect(trail).toEqual(["context"]);
  });

  test("converts the image the file DESIGNATES, not the one stored first", async () => {
    // Review round 6. A HEIC may carry several top-level images and name one of them in its `pitm`
    // box; libheif returns them in storage order, and the two disagree. Taking the first sends a
    // picture the sender did not send, and the extraction comes back successful and about the wrong
    // image — the worst shape a defect can have here, because nothing downstream looks wrong.
    //
    // Measured on the fixture: item order is blue 512x512, red 2400x1200, green 300x300, and `pitm`
    // designates the red one — neither the first nor the last.
    const out = await runMediaConverter(
      "heic-to-jpeg",
      COLECAO.buffer.slice(
        COLECAO.byteOffset,
        COLECAO.byteOffset + COLECAO.byteLength,
      ) as ArrayBuffer,
    );
    const img = jpeg.decode(new Uint8Array(out));
    // 2400x1200 fitted to the 1568 edge, which 512x512 could never produce.
    expect([img.width, img.height]).toEqual([1568, 784]);
    const mid = ((img.height >> 1) * img.width + (img.width >> 1)) * 4;
    const [r, g, b] = [
      img.data[mid],
      img.data[mid + 1],
      img.data[mid + 2],
    ] as number[];
    expect(r).toBeGreaterThan(180);
    expect(b).toBeLessThan(90);
    // And not the blue one, which is the failure this guards.
    expect(g).toBeLessThan(90);
  });

  test("images with nothing designated convert the first instead of reading as empty", async () => {
    // The fallback, and what it is actually for. It is NOT for a file with no `pitm`: measured by
    // renaming that box to `free` (the standard says to ignore `free`, so it stops existing for a
    // reader), libheif refuses the file outright with `No 'pitm' box` and returns zero images, so
    // such a file never reaches this branch. What the branch answers for is a library that returns
    // images without designating one, which this version never does — hence standing in for it.
    // Without the fallback that case would throw "heic carries no image frame" about a file that
    // plainly has frames. Driven through `runMediaConverter` and not through `withHeicFrames`,
    // because the selection being asserted lives in the converter.
    const solid = (w: number, h: number, r: number) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = r;
        data[i + 3] = 255;
      }
      return { data, width: w, height: h, premultiplied: false };
    };
    const out = await runMediaConverter("heic-to-jpeg", brandedHeic(), {
      withFrames: (async (_b, use) =>
        use([
          {
            width: 40,
            height: 20,
            primary: false,
            decode: async () => solid(40, 20, 200),
          },
          {
            width: 8,
            height: 8,
            primary: false,
            decode: async () => solid(8, 8, 10),
          },
        ])) as typeof withHeicFrames,
    });
    const img = jpeg.decode(new Uint8Array(out));
    // The first one, 40x20 and red — not the 8x8, and not a refusal.
    expect([img.width, img.height]).toEqual([40, 20]);
    expect(img.data[0]).toBeGreaterThan(150);
  });

  test("a file with no designated image still converts its only one", async () => {
    // The fallback, and the case every ordinary photo takes: one image, which libheif reports as
    // primary. Asserted so a library version that stops answering `is_primary` fails here instead of
    // converting nothing.
    await withHeicFrames(heicBytes(), async (frames) => {
      expect(frames.map((f) => f.primary)).toEqual([true]);
    });
    const out = await runMediaConverter("heic-to-jpeg", heicBytes());
    expect(jpeg.decode(new Uint8Array(out)).width).toBe(1568);
  });

  test("refuses a source over the pixel cap instead of allocating it", async () => {
    // The fixture is 3.84 Mpx, so a cap just under it exercises the guard without the 200 MB the
    // real cap is there to prevent.
    await expect(
      runMediaConverter("heic-to-jpeg", heicBytes(), {
        maxSourcePixels: 2400 * 1600 - 1,
      }),
    ).rejects.toThrow(/over the 3839999 px cap/);
    // And the real cap admits it, so the guard is not simply always on.
    expect(2400 * 1600).toBeLessThan(MAX_SOURCE_PIXELS);
  });

  test("a crop cannot shrink the file past the pixel cap", async () => {
    // Review round 11, P1. A HEIC may carry a `clap` crop, and libheif's `get_width`/`get_height`
    // then report the CROPPED size while the decode still materialises the whole stored image. A cap
    // applied to the reported size is therefore no cap at all: a 1x1 crop over a 100 Mpx picture
    // walks straight past it.
    //
    // Neither mechanism available in libheif answers this on the installed build, and both were
    // measured: `heif_image_handle_get_ispe_width` returns 0 even for a plain file whose dimensions
    // it should report, and `heif_context_set_maximum_image_size_limit` refuses nothing at any value,
    // set before the read or after it. So the cap reads the size out of the file.
    const clap = CLAP.buffer.slice(
      CLAP.byteOffset,
      CLAP.byteOffset + CLAP.byteLength,
    ) as ArrayBuffer;

    // The disagreement itself, asserted first: without it the test below passes for the wrong reason.
    await withHeicFrames(clap, async (frames) => {
      expect([frames[0]?.width, frames[0]?.height]).toEqual([1, 1]);
    });
    expect(storedPixels(clap)).toBe(64 * 64);

    // One pixel of cap. The reported size fits it exactly, which is what made this a bypass.
    await expect(
      runMediaConverter("heic-to-jpeg", clap, { maxSourcePixels: 1 }),
    ).rejects.toThrow(/stores 4096 px, over the 1 px cap/);
    // And it still converts under a cap that admits what it really stores.
    expect(
      (await runMediaConverter("heic-to-jpeg", clap, { maxSourcePixels: 4096 }))
        .byteLength,
    ).toBeGreaterThan(0);
  });

  test("the declared size is read from the file, and an unreadable one does not throw", () => {
    const of = (b: Buffer) =>
      storedPixels(
        b.buffer.slice(
          b.byteOffset,
          b.byteOffset + b.byteLength,
        ) as ArrayBuffer,
      );
    expect(of(HEIC)).toBe(2400 * 1600);
    expect(of(ALPHA)).toBe(400 * 400);
    // A collection reports the LARGEST, because `ipco` holds every item's properties and a cap is
    // only ever wrong by underestimating.
    expect(of(COLECAO)).toBe(2400 * 1200);
    // Nothing parseable: zero, so the cap falls back to the decoder's numbers instead of refusing
    // every file or throwing where a skip belongs.
    expect(storedPixels(new ArrayBuffer(8))).toBe(0);
    expect(storedPixels(brandedHeic())).toBe(0);
    expect(storedPixels(truncatedHeic())).toBe(0);
  });

  test("bytes whose declared type lied are a MISMATCH, not a conversion failure", async () => {
    // The two are answered oppositely by the caller — one falls back to the original, the other
    // skips — so they cannot share an error class. The brand check runs before the decoder, so
    // libheif never sees a file it would reject for not being HEIC at all: what reaches it always
    // carries a brand we accept, and its own complaints are about the bytes behind that header.
    for (const bytes of [
      new TextEncoder().encode("not a heic at all").buffer as ArrayBuffer,
      // starts with "ftyp", which is NOT where the brand lives: the first four bytes are the size
      new TextEncoder().encode("ftypheic and then junk").buffer as ArrayBuffer,
      brandedHeic("avif"),
      new ArrayBuffer(4),
      // 8 to 11 bytes is the window where the brand's own slice would read out of bounds: the guard
      // has to answer "not that type" there, not let a RangeError surface as a conversion failure
      // and turn a fallback into a skip. Two spellings of it, because they fail differently — the
      // zeroed ones stop at the `ftyp` check, and these stop at the length, which is the only thing
      // standing between an 11-byte file with a real box header and a RangeError.
      new ArrayBuffer(8),
      new ArrayBuffer(11),
      ftypPrefix(8),
      ftypPrefix(11),
    ]) {
      await expect(
        runMediaConverter("heic-to-jpeg", bytes),
      ).rejects.toBeInstanceOf(MediaSourceMismatchError);
    }
    // Every brand the library accepts is accepted here, so a real file is never mistaken for a lie.
    for (const brand of ["mif1", "msf1", "heic", "heix", "hevc", "hevx"]) {
      const err = await runMediaConverter(
        "heic-to-jpeg",
        brandedHeic(brand),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MediaConversionError);
      expect(err).not.toBeInstanceOf(MediaSourceMismatchError);
    }
  });

  test("a JPEG carrying an accepted brand at offset 8 is a MISMATCH, not a broken HEIC", async () => {
    // Review round 7. Offset 8 is the major brand only when offset 4 says `ftyp`; on its own it is
    // four bytes that can spell one by accident. A JPEG whose first marker is a comment puts the
    // comment's payload exactly there, and the file decodes perfectly as a JPEG.
    //
    // Getting this wrong costs the SAME regression the brand check was written to prevent: the file
    // would be called a broken HEIC, the conversion would fail, and the attachment would be skipped
    // — an attachment the vendor reads by sniffing, and read before this feature existed.
    const real = new Uint8Array(
      jpeg.encode(
        { data: new Uint8Array(8 * 8 * 4).fill(180), width: 8, height: 8 },
        80,
      ).data,
    );
    // SOI, then a COM segment (0xFFFE) whose declared length is 10: two length bytes plus eight of
    // payload, which puts payload bytes 2..5 on file offsets 8..11.
    const armadilha = new Uint8Array(real.length + 12);
    armadilha.set([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x0a, 0x20, 0x20], 0);
    armadilha.set(new TextEncoder().encode("heic"), 8);
    armadilha.set([0x20, 0x20], 12);
    armadilha.set(real.subarray(2), 14);

    // The two facts that make this the regression rather than a curiosity: those bytes DO spell an
    // accepted brand at the offset the check reads, and the file IS a readable JPEG.
    expect(String.fromCharCode(...armadilha.subarray(8, 12))).toBe("heic");
    expect(jpeg.decode(armadilha).width).toBe(8);
    // `ftyp` is what the check now requires at offset 4, and a JPEG has 0xFFFE there.
    expect(String.fromCharCode(...armadilha.subarray(4, 8))).not.toBe("ftyp");

    await expect(
      runMediaConverter("heic-to-jpeg", armadilha.buffer as ArrayBuffer),
    ).rejects.toBeInstanceOf(MediaSourceMismatchError);
  });

  test("the operator's line names WHICH of the three things the file is", async () => {
    // The three ways of not being a convertible HEIC are different facts, and the line is the whole
    // point of this PR. Reported as one, a 703-byte JPEG reads as `<too short>` and sends whoever is
    // looking at it after a truncated upload (PR #707, found by the verifier's a4 addendum).
    const message = async (bytes: ArrayBuffer) => {
      const out: unknown = await runMediaConverter("heic-to-jpeg", bytes).catch(
        (e: unknown) => e,
      );
      expect(out).toBeInstanceOf(MediaSourceMismatchError);
      return (out as Error).message;
    };

    expect(await message(new ArrayBuffer(8))).toContain(
      "is too short to carry one",
    );
    // Long enough, and not an ISO base-media file at all: a real JPEG.
    const jpg = new Uint8Array(
      jpeg.encode(
        { data: new Uint8Array(8 * 8 * 4).fill(180), width: 8, height: 8 },
        80,
      ).data,
    );
    expect(jpg.byteLength).toBeGreaterThan(12);
    expect(await message(jpg.buffer as ArrayBuffer)).toContain(
      "does not open with an `ftyp` box",
    );
    // An ISO base-media file that is simply another format.
    expect(await message(brandedHeic("avif"))).toContain(
      'carries brand "avif"',
    );
  });

  test("a truncated but correctly branded HEIC is a conversion failure, not a mismatch", async () => {
    // The type did not lie; the file is broken. The caller must skip this one rather than hand the
    // provider bytes it has already said it cannot read.
    const err = await runMediaConverter("heic-to-jpeg", truncatedHeic()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MediaConversionError);
    expect(err).not.toBeInstanceOf(MediaSourceMismatchError);
  });

  test("the gate lets no two conversions hold their buffers at once", async () => {
    // Asserted on the PRIMITIVE, because the guarantee is invisible from outside: a caller's own
    // timestamps are all taken in the tick that queues the work, before any of it has run. Three
    // jobs that each yield twice (as a decode and an encode do) would interleave without the gate.
    const trail: string[] = [];
    const job = (name: string) => async () => {
      trail.push(`enter ${name}`);
      await Promise.resolve();
      await Promise.resolve();
      trail.push(`exit ${name}`);
      return name;
    };
    const out = await Promise.all(
      ["a", "b", "c"].map((n) => __serializedForTest(job(n))),
    );
    expect(out).toEqual(["a", "b", "c"]);
    expect(trail).toEqual([
      "enter a",
      "exit a",
      "enter b",
      "exit b",
      "enter c",
      "exit c",
    ]);
  });

  test("a throwing job does not wedge the gate behind it", async () => {
    const boom = __serializedForTest(async () => {
      throw new Error("boom");
    });
    await expect(boom).rejects.toThrow("boom");
    await expect(__serializedForTest(async () => "depois")).resolves.toBe(
      "depois",
    );
  });

  test("a failed conversion does not wedge the queue behind it", async () => {
    await expect(
      runMediaConverter("heic-to-jpeg", new ArrayBuffer(8)),
    ).rejects.toBeInstanceOf(MediaConversionError);
    const out = await runMediaConverter("heic-to-jpeg", heicBytes());
    expect(out.byteLength).toBeGreaterThan(0);
  });
});
