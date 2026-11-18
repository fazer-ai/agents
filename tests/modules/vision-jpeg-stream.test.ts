import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import jpeg from "jpeg-js";
import {
  convertInline,
  MediaConversionError,
  runMediaConverter,
  type WholeJpegDecode,
} from "@/modules/vision/convert/index";
import { decodeJpegFitted } from "@/modules/vision/convert/jpeg-stream";
import {
  encodeJpeg,
  fitRgba,
  type Rgba,
} from "@/modules/vision/convert/raster";

// Every fixture is 1601x33: over the 1568 edge, so it is fitted, and 33 rows leave the last band
// partial. Written by libjpeg's cjpeg from a noisy gradient, one file per layout it can produce; the
// progressive ones and the gray 2x2 one from a black-to-white gradient at quality 92, so that their
// coefficients do not fit in 8 bits.
const DIR = `${import.meta.dir}/../fixtures/media/jpeg-faixas`;
const FIT = { maxEdge: 1568, maxPixels: 50_000_000 };

function read(name: string): Uint8Array {
  return new Uint8Array(readFileSync(`${DIR}/${name}`));
}

function ab(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function wholeFit(bytes: Uint8Array): Rgba {
  return fitRgba(
    jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true }),
    1568,
  );
}

function sameRaster(got: Rgba | null, want: Rgba): boolean {
  if (got === null) return false;
  return (
    got.width === want.width &&
    got.height === want.height &&
    Buffer.from(got.data).equals(Buffer.from(want.data))
  );
}

function refusingWholeDecode() {
  return mock((): ReturnType<WholeJpegDecode> => {
    throw new Error("the whole-image decoder was reached");
  });
}

// Where the first segment with this marker starts and ends. The walk is valid up to the first scan,
// which every segment it is asked for here precedes or is.
function segment(
  bytes: Uint8Array,
  marker: number,
): { at: number; end: number } {
  let at = 2;
  while (bytes[at + 1] !== marker)
    at += 2 + (((bytes[at + 2] as number) << 8) | (bytes[at + 3] as number));
  return {
    at,
    end:
      at + 2 + (((bytes[at + 2] as number) << 8) | (bytes[at + 3] as number)),
  };
}

// The file with `extra` inserted just before its end-of-image marker.
function beforeEnd(bytes: Uint8Array, extra: Uint8Array): Uint8Array {
  return Buffer.concat([bytes.subarray(0, -2), extra, bytes.subarray(-2)]);
}

async function convertsAsBefore(bytes: Uint8Array): Promise<boolean> {
  const out = await runMediaConverter("jpeg-fit", ab(bytes));
  return Buffer.from(out).equals(Buffer.from(encodeJpeg(wholeFit(bytes), 82)));
}

describe("a JPEG over the edge is decoded a band at a time", () => {
  // One file per layout, because each walks a different path: MCU shape (the five samplings, gray,
  // and gray declared 2x2), restart markers in the middle of a band, and the layouts that keep every
  // coefficient (progressive, with refinement down from bit 2, and one scan per component). The
  // oracle is jpeg-js plus fitRgba, what ran before.
  test.each([
    "amostragem-2x2.jpg",
    "amostragem-2x1.jpg",
    "amostragem-1x1.jpg",
    "amostragem-4x1.jpg",
    "amostragem-1x2.jpg",
    "cinza.jpg",
    "restart.jpg",
    "restart-cinza.jpg",
    "progressivo.jpg",
    "progressivo-cinza.jpg",
    "progressivo-refinamentos.jpg",
    "cinza-amostragem-2x2.jpg",
    "scan-por-componente.jpg",
  ])("%s comes out byte for byte as the whole-image decode", (name) => {
    expect(
      sameRaster(decodeJpegFitted(read(name), FIT), wholeFit(read(name))),
    ).toBe(true);
  });

  test("the conversion takes the band decoder and sends the same JPEG as before", async () => {
    const bytes = read("amostragem-2x2.jpg");
    const decodeWholeJpeg = refusingWholeDecode();
    const out = await convertInline("jpeg-fit", ab(bytes), {
      decodeWholeJpeg,
    });
    expect(decodeWholeJpeg).not.toHaveBeenCalled();
    expect(
      Buffer.from(out).equals(Buffer.from(encodeJpeg(wholeFit(bytes), 82))),
    ).toBe(true);
  });

  test.each([
    ["aritmetico.jpg", "arithmetic coding"],
    ["cmyk.jpg", "four components"],
  ])("%s (%s) is left to jpeg-js", async (name) => {
    expect(decodeJpegFitted(read(name), FIT)).toBeNull();
    const decodeWholeJpeg = mock(
      (data: Uint8Array, opts: Parameters<WholeJpegDecode>[1]) =>
        jpeg.decode(data, opts),
    );
    await convertInline("jpeg-fit", ab(read(name)), {
      decodeWholeJpeg,
    }).catch(() => undefined);
    expect(decodeWholeJpeg).toHaveBeenCalledTimes(1);
  });

  test("an image already within the edge stays on jpeg-js, which costs little there", async () => {
    const small = jpeg.encode(
      {
        data: new Uint8Array(400 * 300 * 4).fill(200),
        width: 400,
        height: 300,
      },
      80,
    ).data;
    expect(decodeJpegFitted(new Uint8Array(small), FIT)).toBeNull();
  });

  // Each of these makes jpeg-js do something the band decoder does not reproduce (a sampling factor
  // past 4 floors a row of the band before, zero throws, a repeated id aliases two components).
  test.each([
    [
      "a sampling factor past the standard's 4",
      (b: Uint8Array, sof: number) => {
        b[sof + 11] = 0x55;
      },
    ],
    [
      "a sampling factor of zero",
      (b: Uint8Array, sof: number) => {
        b[sof + 11] = 0x02;
      },
    ],
    [
      "two components with the same id",
      (b: Uint8Array, sof: number) => {
        // In the frame and in the scan, or the scan's lookup of the lost id would decline first.
        const sos = segment(b, 0xda).at;
        b[sof + 13] = b[sof + 10] as number;
        b[sos + 7] = b[sos + 5] as number;
      },
    ],
  ])("%s is left to jpeg-js", (_, damage) => {
    const bytes = read("amostragem-2x2.jpg");
    damage(bytes, segment(bytes, 0xc0).at);
    expect(decodeJpegFitted(bytes, FIT)).toBeNull();
  });

  // jpeg-js reads the quantization tables once every segment is parsed, so a table redefined after
  // the scan applies to the blocks already decoded, which a band already drawn cannot follow.
  test("a quantization table redefined after the scan converts as before", async () => {
    const bytes = read("amostragem-2x2.jpg");
    const { at, end } = segment(bytes, 0xdb);
    const table = bytes.slice(at, end);
    table.fill(1, 5, 69);
    expect(await convertsAsBefore(beforeEnd(bytes, table))).toBe(true);
  });

  // jpeg-js decodes a second sequential scan over the blocks of the first, after the bands of the
  // first were drawn.
  test("a second scan of the same components converts as before", async () => {
    const bytes = read("amostragem-2x2.jpg");
    const scan = bytes.slice(segment(bytes, 0xda).at, -2);
    expect(await convertsAsBefore(beforeEnd(bytes, scan))).toBe(true);
  });

  // A file the band decoder covers but cannot finish is refused by it, never handed to jpeg-js: that
  // would allocate the whole image, which is what a forged or cut file must not get to do.
  test.each([
    ["cut in half", (b: Uint8Array) => b.subarray(0, b.length >> 1)],
    [
      "cut before its scan",
      (b: Uint8Array) => b.subarray(0, segment(b, 0xda).at),
    ],
    [
      "declaring more rows than it carries",
      (b: Uint8Array) => {
        const forged = b.slice();
        const sof = segment(forged, 0xc0).at;
        forged[sof + 5] = 0x1f; // 33 rows become 8000
        forged[sof + 6] = 0x40;
        return forged;
      },
    ],
  ])(
    "a file %s is refused without the whole-image decode",
    async (_, damage) => {
      const decodeWholeJpeg = refusingWholeDecode();
      const outcome = convertInline(
        "jpeg-fit",
        ab(damage(read("amostragem-2x2.jpg"))),
        { decodeWholeJpeg },
      );
      await expect(outcome).rejects.toBeInstanceOf(MediaConversionError);
      await expect(outcome).rejects.not.toThrow("whole-image decoder");
      expect(decodeWholeJpeg).not.toHaveBeenCalled();
    },
  );
});
