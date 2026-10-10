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
  MAX_TILED_SOURCE_PIXELS,
  MediaConversionError,
  MediaSourceMismatchError,
  MediaTooLargeError,
  runMediaConverter,
  storedPixels,
} from "@/modules/vision/convert";
import {
  __placementForTest,
  __resetLibheifForTest,
  decodeGridFitted,
  LIBHEIF_WASM_PATH_ENV,
  libheifWasmPath,
  loadLibheif,
  withHeicFrames,
} from "@/modules/vision/convert/heic";
import {
  FitAccumulator,
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

// Stored as a GRID: 2400x1600 in 5x4 tiles of 512x512, as phones store their photos.
const HEIC = readFileSync(`${import.meta.dir}/../fixtures/media/recibo.heic`);
// A grid with an `irot`: 2000x1300 stored in 4x3 tiles, shown rotated to 1300x2000, so the tiles are
// laid out in the TRANSFORMED image as 3x4 and its edge tiles are padded past it. Colour quadrants,
// a black block and two diagonals, so a misplaced or unrotated tile changes the pixels. Built with
// `heif-enc --cut-tiles 512 --rotate-cw 90`.
const GRID_ROTATED = readFileSync(
  `${import.meta.dir}/../fixtures/media/grade-rotacionada.heic`,
);
// The same source turned 180 and 270 degrees: 180 runs BOTH shown axes backwards along the stored
// ones, so both paddings move to the start; 270 swaps the axes the other way from 90.
const GRID_ROTATED_180 = readFileSync(
  `${import.meta.dir}/../fixtures/media/grade-rotacionada-180.heic`,
);
const GRID_ROTATED_270 = readFileSync(
  `${import.meta.dir}/../fixtures/media/grade-rotacionada-270.heic`,
);
// A SQUARE grid, 2000x2000 in 4x4 tiles, turned 180 and 90 degrees: the size alone cannot say
// whether the axes were swapped, so only the tile mapping can.
const GRID_SQUARE_180 = readFileSync(
  `${import.meta.dir}/../fixtures/media/grade-quadrada-180.heic`,
);
const GRID_SQUARE_90 = readFileSync(
  `${import.meta.dir}/../fixtures/media/grade-quadrada-90.heic`,
);
// A grid with alpha: 1100x700 in 3x2 tiles, left half opaque red, a band of blue at alpha 128, the
// rest transparent. A tile decode leaves the alpha out, so this one is not read tile by tile.
// Tiles 250 px wide, whose rows libheif pads to a 1008-byte stride instead of the 1000 bytes of
// pixels, so reading a row has to follow the stride.
const GRID_TILE_250 = readFileSync(
  `${import.meta.dir}/../fixtures/media/grade-tile-250.heic`,
);
const GRID_ALPHA = readFileSync(
  `${import.meta.dir}/../fixtures/media/grade-alfa.heic`,
);
// A cutout: left half opaque red, right half fully transparent. Made the way iOS's "remove
// background" makes one, `sips -s format heic` from an RGBA PNG; the alpha survives the decode (the
// transparent half comes back with a = 0).
const ALPHA = readFileSync(
  `${import.meta.dir}/../fixtures/media/recorte-alpha.heic`,
);
// A three-image collection whose PRIMARY is the MIDDLE item: flat blue 512x512, flat red 2400x1200,
// flat green 300x300, with `pitm` pointing at the red one. Three and not two: with two, "take the
// last" and "take the designated" agree. Built with `heif-enc azul512.png vermelho2400.png
// verde300.png`, then the two-byte item id in `pitm` patched from 1 to 2 (every encoder writes the
// primary first, so patching is the only way to make the two orders disagree).
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
// The same crop, with a 16-byte EXTENDED-SIZE `free` box spliced after `ftyp` (32-bit size of 1, the
// real size in the 64 bits after the type) and the `iloc` offsets moved with it. libheif reads it
// exactly like the file above; a walker that stops at the first `size == 1` reads nothing past it.
const CLAP_EXT = readFileSync(
  `${import.meta.dir}/../fixtures/media/recorte-clap-caixa-estendida.heic`,
);
// And the same crop again with the CONTAINER itself extended: `meta` rewritten with a 32-bit size of
// 1 and its real size in the 64 bits after the type. Here the extended header has to move where the
// children start, not just how far the box reaches.
const CLAP_META_EXT = readFileSync(
  `${import.meta.dir}/../fixtures/media/recorte-clap-meta-estendido.heic`,
);
// …and the same crop with the `ftyp` ITSELF extended: 32-bit size of 1, real size in the 64 bits
// after the type, `iloc` offsets moved by the 8 bytes that added. The brand is then at offset 16,
// and offset 8 holds the high half of a length — four zero bytes that spell no brand at all.
const CLAP_FTYP_EXT = readFileSync(
  `${import.meta.dir}/../fixtures/media/recorte-clap-ftyp-estendido.heic`,
);
// A 2000x2000 HEVC image whose `ispe` was rewritten to say 1x1. Both numbers the cap can read come
// from `ispe`, so a file like this one is what the cap CANNOT see — and it is refused before a pixel
// is decoded, which is the property the cap rests on. See the test.
const ISPE_MENOR = readFileSync(
  `${import.meta.dir}/../fixtures/media/ispe-menor-que-o-codificado.heic`,
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
    // NOTE: Chatwoot can serve `application/pdf; charset=binary`, which matches neither an equality
    // nor a `/pdf` suffix check.
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
    // NOTE: HEIC: Gemini documents it; the other two do not.
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
    // Flatten BEFORE fit. Two opaque red pixels and one transparent black (what iOS leaves
    // under a cutout), downscaled to two so the second box straddles the edge: flatten-then-fit gives
    // (237, 142, 142); fit-then-flatten averages colour AND alpha first and gives (183, 135, 135),
    // a dark fringe on every cutout.
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

  test("the two files decode to the SAME bytes, so only the flag can tell them apart", async () => {
    // The same PNG encoded with and without `--premultiplied-alpha` decodes byte-identical, so
    // nothing in the pixels says which formula is owed: without the flag there is no information.
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
    // `Uint8Array` stores as 0, a black pixel where the arithmetic asked for white.
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
    // A malformed file throws after the decoder is built and must still release it. The probe
    // is a malloc(1) against libheif's own heap: the pointer it returns is the boundary of what is
    // allocated, so two probes with the allocation released in between are equal, and any residual
    // shows up as the difference.
    const lib = (await loadLibheif()) as unknown as {
      _malloc(n: number): number;
      _free(p: number): void;
    };
    const probe = () => {
      const p = lib._malloc(1);
      lib._free(p);
      return p;
    };
    // NOTE: one pass first, to take the allocator's own one-time step (440 bytes) out of the probe.
    await withHeicFrames(truncatedHeic(), async (f) => f.length);
    const before = probe();
    for (let i = 0; i < 50; i++)
      await withHeicFrames(truncatedHeic(), async (f) => f.length);
    // NOTE: not "bounded", not "small": ZERO.
    expect(probe() - before).toBe(0);
  });

  test("every image handle is released, on every path out, and before the context", async () => {
    // Freeing the CONTEXT does not free the image handles, and a handle retains the decoded
    // image, so the wasm heap grows with every conversion that skips `image.free()`. Asserted by
    // standing in for the library: a real heap reading takes a minute of decoding, and the ORDER is
    // part of the contract (a handle holds a reference into the context, so the context goes last).
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

    // NOTE: the refusal paths are the ones most prone to skip a release, so each gets its own check.
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
    // A HEIC may carry several top-level images and name one in its `pitm` box; libheif returns
    // them in storage order. Taking the first yields a successful extraction of the wrong picture,
    // with nothing downstream looking wrong. The fixture's `pitm` designates the red one, neither the
    // first nor the last.
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
    // The fallback is NOT for a file with no `pitm` (libheif refuses that with `No 'pitm' box`
    // and zero images). It answers a library that returns images without designating one, which this
    // version never does, hence the stand-in; without it that case throws "heic carries no image
    // frame". Driven through `runMediaConverter`, because the selection lives in the converter.
    const solid = (w: number, h: number, r: number) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = r;
        data[i + 3] = 255;
      }
      return { data, width: w, height: h, premultiplied: false };
    };
    // The real fixture's bytes, because the cap reads the declared size out of them and a synthetic
    // header declares nothing — the frames are what is being stood in for here, not the container.
    const out = await runMediaConverter("heic-to-jpeg", heicBytes(), {
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

  test("refuses an image stored in one piece over the pixel cap instead of allocating it", async () => {
    // The cutout is 400x400 and not a grid, so a cap just under it exercises the guard without the
    // 200 MB the real cap is there to prevent.
    const bytes = ALPHA.buffer.slice(
      ALPHA.byteOffset,
      ALPHA.byteOffset + ALPHA.byteLength,
    ) as ArrayBuffer;
    const refused = runMediaConverter("heic-to-jpeg", bytes, {
      maxSourcePixels: 400 * 400 - 1,
    });
    await expect(refused).rejects.toThrow(/over the 159999 px cap/);
    await expect(refused).rejects.toBeInstanceOf(MediaTooLargeError);
    // And the real cap admits it, so the guard is not simply always on.
    expect(400 * 400).toBeLessThan(MAX_SOURCE_PIXELS);
  });

  test("a crop cannot shrink the file past the pixel cap", async () => {
    // With a `clap` crop, `get_width`/`get_height` report the CROPPED size while the decode
    // materialises the whole stored image, so a 1x1 crop over 100 Mpx walks past a cap on the
    // reported size. The cap reads the size out of the file because, on the installed build,
    // `heif_image_handle_get_ispe_width` returns 0 and `heif_context_set_maximum_image_size_limit`
    // refuses nothing.
    const clap = CLAP.buffer.slice(
      CLAP.byteOffset,
      CLAP.byteOffset + CLAP.byteLength,
    ) as ArrayBuffer;

    // The disagreement itself, asserted first: without it the test below passes for the wrong reason.
    await withHeicFrames(clap, async (frames) => {
      expect([frames[0]?.width, frames[0]?.height]).toEqual([1, 1]);
    });
    expect(storedPixels(clap)).toBe(64 * 64);

    // NOTE: one pixel of cap, which the reported (cropped) size fits exactly.
    await expect(
      runMediaConverter("heic-to-jpeg", clap, { maxSourcePixels: 1 }),
    ).rejects.toThrow(/stores 4096 px, over the 1 px cap/);
    // And it still converts under a cap that admits what it really stores.
    expect(
      (await runMediaConverter("heic-to-jpeg", clap, { maxSourcePixels: 4096 }))
        .byteLength,
    ).toBeGreaterThan(0);
  });

  test("an extended-size box does not blind the cap", async () => {
    // BMFF states a box size three ways (`n`, `0` for "to the end of the file", `1` for "the
    // real size is the 64 bits after the type"). A walker that only understands the first stops at
    // the others and reports "no declared size", which must not fall back to the cropped dimensions.
    const ext = CLAP_EXT.buffer.slice(
      CLAP_EXT.byteOffset,
      CLAP_EXT.byteOffset + CLAP_EXT.byteLength,
    ) as ArrayBuffer;
    // The file is read by libheif exactly like its twin, so the difference is entirely in the walk.
    await withHeicFrames(ext, async (frames) => {
      expect([frames[0]?.width, frames[0]?.height]).toEqual([1, 1]);
    });
    expect(storedPixels(ext)).toBe(64 * 64);
    await expect(
      runMediaConverter("heic-to-jpeg", ext, { maxSourcePixels: 1 }),
    ).rejects.toThrow(/stores 4096 px, over the 1 px cap/);

    // And when the CONTAINER is the extended one, the eight extra bytes move where its children
    // begin. A walker that reaches past the box but not into it reads nothing either.
    const metaExt = CLAP_META_EXT.buffer.slice(
      CLAP_META_EXT.byteOffset,
      CLAP_META_EXT.byteOffset + CLAP_META_EXT.byteLength,
    ) as ArrayBuffer;
    expect(storedPixels(metaExt)).toBe(64 * 64);
    await expect(
      runMediaConverter("heic-to-jpeg", metaExt, { maxSourcePixels: 1 }),
    ).rejects.toThrow(/stores 4096 px, over the 1 px cap/);

    // A size the walk cannot hold is a size it does not get to truncate. The same `free` box with
    // 2^32 added to its declared size: reading only the low word would find 16 there, walk on, and
    // report the `ispe` of a file whose boxes do not line up. The walk stops instead, finds no
    // declared size, and the caller fails closed.
    const huge = new Uint8Array(CLAP_EXT);
    new DataView(huge.buffer, huge.byteOffset).setUint32(28 + 8, 1);
    expect(
      storedPixels(
        huge.buffer.slice(
          huge.byteOffset,
          huge.byteOffset + huge.byteLength,
        ) as ArrayBuffer,
      ),
    ).toBe(0);
  });

  test("an extended-size ftyp still carries a brand, eight bytes later", async () => {
    // Offset 8 is the brand only when the header ends there: with `size == 1` the real size
    // takes the next 64 bits and the brand sits at 16. Misread, the file below (which libheif decodes)
    // reads as `carries brand "   "`, a source mismatch that hands the original HEIC to a provider
    // that refuses it, and the attachment stops being read.
    const ext = CLAP_FTYP_EXT.buffer.slice(
      CLAP_FTYP_EXT.byteOffset,
      CLAP_FTYP_EXT.byteOffset + CLAP_FTYP_EXT.byteLength,
    ) as ArrayBuffer;
    await withHeicFrames(ext, async (frames) => {
      expect([frames[0]?.width, frames[0]?.height]).toEqual([1, 1]);
    });
    expect(
      (await runMediaConverter("heic-to-jpeg", ext, {})).byteLength,
    ).toBeGreaterThan(0);
    // And the cap still reads the size the file stores, through the same extended header.
    await expect(
      runMediaConverter("heic-to-jpeg", ext, { maxSourcePixels: 1 }),
    ).rejects.toThrow(/stores 4096 px, over the 1 px cap/);

    // The other side of the same header: sixteen bytes is a whole extended header and no brand, so
    // the file is too short to carry one — not a file whose brand is four zero bytes.
    const stub = new Uint8Array(16);
    new DataView(stub.buffer).setUint32(0, 1);
    stub.set(new TextEncoder().encode("ftyp"), 4);
    new DataView(stub.buffer).setBigUint64(8, 20n);
    await expect(
      runMediaConverter("heic-to-jpeg", stub.buffer as ArrayBuffer, {}),
    ).rejects.toThrow(/is too short to carry one/);
  });

  test("an ispe that understates the coded image is refused by the decoder, not decoded", async () => {
    // Both numbers the cap reads come from `ispe`, while a decode's cost is set by the HEVC
    // bitstream, so a file declaring 1x1 and coding 2000x2000 passes any cap. libheif closes that: it
    // compares coded against signalled dimensions and refuses BEFORE decoding (no heap growth). This
    // pins that property of the dependency, which an upgrade could change: the file below is admitted
    // by any cap and must still never be decoded.
    const bytes = ISPE_MENOR.buffer.slice(
      ISPE_MENOR.byteOffset,
      ISPE_MENOR.byteOffset + ISPE_MENOR.byteLength,
    ) as ArrayBuffer;
    expect(storedPixels(bytes)).toBe(1);
    await expect(
      runMediaConverter("heic-to-jpeg", bytes, { maxSourcePixels: 50_000 }),
    ).rejects.toThrow(/could not render the image/);
  });

  test("a file that will not declare its size is refused, not converted on trust", async () => {
    // FAIL CLOSED. `ispe` is mandatory in HEIF and every file libheif accepts carries one, so finding
    // none means the container is malformed or beyond this walker — and the attacker is the one who
    // chooses the container. Driven through the frame seam, because reaching this branch needs a file
    // that decodes to a frame AND hides its `ispe`, which is a combination no real encoder writes.
    await expect(
      runMediaConverter("heic-to-jpeg", brandedHeic(), {
        withFrames: (async (_b, use) =>
          use([
            {
              width: 2,
              height: 2,
              primary: true,
              decode: async () => ({
                data: new Uint8ClampedArray(2 * 2 * 4).fill(255),
                width: 2,
                height: 2,
                premultiplied: false,
              }),
            },
          ])) as typeof withHeicFrames,
      }),
    ).rejects.toThrow(/does not declare the size it stores/);
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

  test("the operator's line names WHICH of the three things the file is", async () => {
    // The three ways of not being a convertible HEIC are different facts on the line. Reported
    // as one, a 703-byte JPEG reads as `<too short>` and sends the reader after a truncated upload.
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

const buf = (b: Buffer) =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

// What the whole-image path produces for the same file: decode it all, flatten, fit.
async function wholeFitted(bytes: ArrayBuffer, maxEdge: number) {
  return await withHeicFrames(bytes, async (frames) => {
    const frame = frames.find((f) => f.primary) ?? frames[0];
    if (!frame) throw new Error("no frame");
    return fitRgba(flattenOntoWhite(await frame.decode()), maxEdge);
  });
}

describe("a grid HEIC over the pixel cap", () => {
  const cases: [string, Buffer, number][] = [
    ["a grid, downscaled", HEIC, 1568],
    ["a rotated grid, downscaled", GRID_ROTATED, 1568],
    [
      "a rotated grid at full size, where only the padding is cut",
      GRID_ROTATED,
      4000,
    ],
    ["a grid turned 180 degrees, at full size", GRID_ROTATED_180, 4000],
    ["a grid turned 270 degrees, at full size", GRID_ROTATED_270, 4000],
    ["a grid turned 180 degrees, downscaled", GRID_ROTATED_180, 700],
    ["a grid whose rows are padded past the tile", GRID_TILE_250, 4000],
    ["a square grid turned 180 degrees", GRID_SQUARE_180, 4000],
    ["a square grid turned 90 degrees", GRID_SQUARE_90, 4000],
    ["a grid scaled to a fractional width", GRID_ROTATED, 1001],
    ["a grid scaled to a box that does not divide its tiles", HEIC, 333],
  ];
  for (const [name, file, maxEdge] of cases) {
    test(`${name}: tile by tile gives the same pixels as the whole decode`, async () => {
      const whole = await wholeFitted(buf(file), maxEdge);
      const grid = await decodeGridFitted(buf(file), {
        maxEdge,
        maxTilePixels: MAX_SOURCE_PIXELS,
      });
      if (grid.kind !== "decoded") throw new Error(grid.kind);
      expect([grid.image.width, grid.image.height]).toEqual([
        whole.width,
        whole.height,
      ]);
      expect(Buffer.from(grid.image.data).equals(Buffer.from(whole.data))).toBe(
        true,
      );
    });
  }

  // 7101 / 1568 * 1568 is 7100.999..., which floors to 7100: the last box has to end at the source's
  // edge anyway, or the last column is dropped (fitRgba) or averaged into the FIRST box (a map
  // whose last entry keeps its default 0).
  test("the last source column lands in the last box, whatever the float rounding", () => {
    const sw = 7101;
    const row = new Uint8Array(sw * 4).fill(255);
    row.set([0, 0, 0, 255], (sw - 1) * 4);
    const src = { data: row, width: sw, height: 1 };
    const whole = fitRgba(src, 1568);
    const fit = new FitAccumulator(sw, 1, 1568);
    fit.add(src, 0, 0);
    const pieces = fit.result();
    expect(whole.width).toBe(1568);
    expect(whole.data[0]).toBe(255);
    expect(whole.data[(1568 - 1) * 4]).toBeLessThan(255);
    expect(Buffer.from(pieces.data).equals(Buffer.from(whole.data))).toBe(true);
  });

  // A file declares its own size, and a grid of 150,000,000x1 passes both caps: nothing may be
  // allocated per SOURCE coordinate, only per output pixel and per tile in hand.
  test("the accumulator allocates by the output and the piece, never by the source's size", () => {
    const sw = 3_000_000_000;
    const fit = new FitAccumulator(sw, 1, 1568);
    fit.add(
      { data: new Uint8Array(4 * 4).fill(255), width: 4, height: 1 },
      sw - 4,
      0,
    );
    fit.add(
      { data: new Uint8Array([0, 0, 0, 255]), width: 1, height: 1 },
      0,
      0,
    );
    const out = fit.result();
    expect(out.width).toBe(1568);
    expect(Array.from(out.data.slice(0, 4))).toEqual([0, 0, 0, 255]);
    expect(Array.from(out.data.slice((1568 - 1) * 4))).toEqual([
      255, 255, 255, 255,
    ]);
  });

  test("a piece's boxes match fitRgba's at every offset, not just from the origin", () => {
    const sw = 7101;
    const row = new Uint8Array(sw * 4);
    for (let x = 0; x < sw; x++)
      row.set([x % 251, (x * 7) % 253, (x * 13) % 255, 255], x * 4);
    const whole = fitRgba({ data: row, width: sw, height: 1 }, 1000);
    const fit = new FitAccumulator(sw, 1, 1000);
    for (let left = 0; left < sw; left += 333) {
      const w = Math.min(333, sw - left);
      fit.add(
        { data: row.slice(left * 4, (left + w) * 4), width: w, height: 1 },
        left,
        0,
      );
    }
    expect(Buffer.from(fit.result().data).equals(Buffer.from(whole.data))).toBe(
      true,
    );
  });

  test("a piece placed outside the source fails instead of vanishing", () => {
    const fit = new FitAccumulator(10, 10, 5);
    const piece = { data: new Uint8Array(4 * 4 * 4), width: 4, height: 4 };
    for (const [left, top] of [
      [-1, 0],
      [0, -1],
      [7, 0],
      [0, 7],
    ] as const)
      expect(() => fit.add(piece, left, top)).toThrow(
        /outside the 10x10 source/,
      );
    expect(() => fit.add(piece, 6, 6)).not.toThrow();
  });

  test("an image stored in one piece is not a grid, whatever its size", async () => {
    expect(
      await decodeGridFitted(buf(ALPHA), {
        maxEdge: 1568,
        maxTilePixels: MAX_SOURCE_PIXELS,
      }),
    ).toEqual({ kind: "not-a-grid" });
  });

  test("the converter reads a grid over the cap instead of refusing it", async () => {
    const out = await runMediaConverter("heic-to-jpeg", heicBytes(), {
      maxSourcePixels: 2400 * 1600 - 1,
    });
    const img = jpeg.decode(new Uint8Array(out));
    expect([img.width, img.height]).toEqual([1568, 1045]);
  });

  test("a grid cut short fails as a conversion, not as a size refusal, and takes nothing down", async () => {
    const cut = heicBytes().slice(0, Math.floor(HEIC.byteLength * 0.7));
    const failed = runMediaConverter("heic-to-jpeg", cut, {
      maxSourcePixels: 2400 * 1600 - 1,
    });
    await expect(failed).rejects.toThrow(/libheif tile \d+,\d+ failed/);
    await expect(failed).rejects.not.toBeInstanceOf(MediaTooLargeError);
    // And the next conversion still works.
    const out = await runMediaConverter("heic-to-jpeg", heicBytes());
    expect(jpeg.decode(new Uint8Array(out)).width).toBe(1568);
  });

  test("a grid whose tile is itself over the cap is refused, since a tile is decoded whole", async () => {
    await expect(
      runMediaConverter("heic-to-jpeg", heicBytes(), {
        maxSourcePixels: 512 * 512 - 1,
      }),
    ).rejects.toBeInstanceOf(MediaTooLargeError);
  });

  test("a grid over the tiled cap is refused: every tile is still decoded, so size is time", async () => {
    const refused = runMediaConverter("heic-to-jpeg", heicBytes(), {
      maxSourcePixels: 1_000_000,
      maxTiledSourcePixels: 2400 * 1600 - 1,
    });
    await expect(refused).rejects.toBeInstanceOf(MediaTooLargeError);
    await expect(refused).rejects.toThrow(/over the 1000000 px cap/);
    // And the real tiled cap covers the largest phone mode, 200 MP.
    expect(MAX_TILED_SOURCE_PIXELS).toBeGreaterThanOrEqual(16320 * 12240);
  });

  // Every allocation, handle, image and context the grid decode takes is given back, on success and
  // when a tile fails halfway: the heap never returns memory to the process, so a leak per photo is
  // a leak for the life of the process.
  async function counted(failTile?: [number, number]) {
    const lib = (await loadLibheif()) as unknown as Record<string, unknown>;
    const live = { malloc: 0, context: 0, handle: 0, image: 0 };
    const wrap = new Proxy(lib, {
      get(target, key) {
        const v = target[key as string];
        if (typeof v !== "function") return v;
        const fn = v as (...a: number[]) => number;
        return (...a: number[]) => {
          if (key === "_heif_image_handle_decode_image_tile" && failTile) {
            const [x, y] = failTile;
            if (a[6] === x && a[7] === y) {
              (target.HEAP32 as Int32Array)[(a[0] as number) >> 2] = 1;
              return;
            }
          }
          const r = fn.apply(target, a);
          if (key === "_malloc") live.malloc++;
          if (key === "_free") live.malloc--;
          if (key === "_heif_context_alloc") live.context++;
          if (key === "_heif_context_free") live.context--;
          if (key === "_heif_context_get_primary_image_handle") live.handle++;
          if (key === "_heif_context_get_image_handle") live.handle++;
          if (key === "_heif_image_handle_release") live.handle--;
          if (key === "_heif_image_handle_decode_image_tile") live.image++;
          if (key === "_heif_image_release") live.image--;
          return r;
        };
      },
    });
    const run = decodeGridFitted(
      buf(HEIC),
      { maxEdge: 1568, maxTilePixels: MAX_SOURCE_PIXELS },
      wrap as never,
    );
    return { run, live };
  }

  test("a grid with alpha is not read tile by tile, since a tile decode drops the alpha", async () => {
    expect(
      await decodeGridFitted(buf(GRID_ALPHA), {
        maxEdge: 1568,
        maxTilePixels: MAX_SOURCE_PIXELS,
      }),
    ).toEqual({ kind: "unsupported", reason: "a grid with alpha" });
    // So over the cap it is refused as before, not handed to the model on black.
    await expect(
      runMediaConverter("heic-to-jpeg", buf(GRID_ALPHA), {
        maxSourcePixels: 1100 * 700 - 1,
      }),
    ).rejects.toBeInstanceOf(MediaTooLargeError);
  });

  // Tiles are decoded whole, padding included, so a grid whose tiles cover far more than the image
  // (a thin one: 150,000,000x1 in 512x512 tiles decodes 512 times its pixels) is time the pixel cap
  // does not see.
  test("a grid whose tiles cover more than twice the image is refused", async () => {
    const lib = (await loadLibheif()) as unknown as Record<string, unknown>;
    const shrunk = new Proxy(lib, {
      get(target, key) {
        if (key === "_heif_image_handle_get_width") return () => 400;
        if (key === "_heif_image_handle_get_height") return () => 400;
        const v = target[key as string];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    expect(
      await decodeGridFitted(
        buf(HEIC),
        { maxEdge: 1568, maxTilePixels: MAX_SOURCE_PIXELS },
        shrunk as never,
      ),
    ).toEqual({
      kind: "unsupported",
      reason: "a grid whose tiles cover more than twice the image",
    });
  });

  // The tiling reports the first tile's size; a malformed grid can carry a bigger tile further on,
  // which libheif allocates before rejecting. Here one tile of the real receipt grid is made to
  // declare 2000x2000: nothing may be decoded, and every handle opened to measure is given back.
  for (const lie of [
    "_heif_image_handle_get_ispe_width",
    "_heif_image_handle_get_ispe_height",
  ])
    test(`a grid with a tile larger than it declares (${lie.slice(-5)}) is refused before any tile is decoded`, async () => {
      const lib = (await loadLibheif()) as unknown as Record<string, unknown>;
      let decoded = 0;
      let measured = 0;
      let liar = -1;
      const open = new Set<number>();
      const tampered = new Proxy(lib, {
        get(target, key) {
          const v = target[key as string];
          if (typeof v !== "function") return v;
          const fn = v as (...a: number[]) => number;
          return (...a: number[]) => {
            if (key === "_heif_image_handle_decode_image_tile") decoded++;
            const r = fn.apply(target, a);
            if (key === "_heif_context_get_image_handle") {
              const h = (target.HEAPU32 as Uint32Array)[
                (a[3] as number) >> 2
              ] as number;
              open.add(h);
              // The seventh tile measured is the one that lies.
              if (++measured === 7) liar = h;
            }
            if (key === "_heif_image_handle_release")
              open.delete(a[0] as number);
            if (key === lie && a[0] === liar) return 2000;
            return r;
          };
        },
      });
      expect(
        await decodeGridFitted(
          buf(HEIC),
          { maxEdge: 1568, maxTilePixels: MAX_SOURCE_PIXELS },
          tampered as never,
        ),
      ).toEqual({
        kind: "unsupported",
        reason: "a grid with a tile larger than it declares",
      });
      expect(decoded).toBe(0);
      expect(measured).toBe(7);
      expect(open.size).toBe(0);
    });

  test("everything the grid decode takes is released after a success", async () => {
    const { run, live } = await counted();
    expect((await run).kind).toBe("decoded");
    expect(live).toEqual({ malloc: 0, context: 0, handle: 0, image: 0 });
  });

  test("and after a tile fails halfway through", async () => {
    const { run, live } = await counted([2, 1]);
    await expect(run).rejects.toThrow(/tile 2,1/);
    expect(live).toEqual({ malloc: 0, context: 0, handle: 0, image: 0 });
  });

  test("the heap does not grow from one grid to the next", async () => {
    const lib = await loadLibheif();
    const opts = { maxEdge: 1568, maxTilePixels: MAX_SOURCE_PIXELS };
    await decodeGridFitted(buf(HEIC), opts);
    const after = (lib as unknown as { HEAPU8: Uint8Array }).HEAPU8.length;
    for (let i = 0; i < 4; i++) await decodeGridFitted(buf(HEIC), opts);
    expect((lib as unknown as { HEAPU8: Uint8Array }).HEAPU8.length).toBe(
      after,
    );
  });

  const tiling = (
    columns: number,
    rows: number,
    width: number,
    height: number,
  ) => ({
    columns,
    rows,
    tileWidth: 512,
    tileHeight: 512,
    width,
    height,
  });

  test("a crop inside the grid is refused rather than placed", () => {
    expect(
      __placementForTest(
        tiling(4, 3, 2000, 1300),
        tiling(4, 3, 1990, 1300),
        1990,
        1300,
        (_t, x, y) => y * 4 + x,
      ),
    ).toBe("a cropped grid");
  });

  test("a padded axis one tile long cannot say which way it runs, so it is refused", () => {
    expect(
      __placementForTest(
        tiling(4, 1, 2000, 500),
        tiling(4, 1, 2000, 500),
        2000,
        500,
        (_t, x, y) => y * 4 + x,
      ),
    ).toBe("a padded grid axis one tile long");
  });

  test("an unpadded axis one tile long needs no direction", () => {
    expect(
      __placementForTest(
        tiling(4, 1, 2000, 512),
        tiling(4, 1, 2000, 512),
        2000,
        512,
        (_t, x, y) => y * 4 + x,
      ),
    ).toEqual({ leftOffset: 0, topOffset: 0 });
  });
});
