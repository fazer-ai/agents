import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import jpeg from "jpeg-js";
import {
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
// partial. Written by libjpeg's cjpeg from one noisy gradient, one file per layout it can produce.
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

describe("a JPEG over the edge is decoded a band at a time", () => {
  // One file per layout, because each walks a different path: MCU shape (the five samplings and
  // gray), restart markers in the middle of a band, and the layouts that keep every coefficient
  // (progressive, one scan per component). The oracle is jpeg-js plus fitRgba, what ran before.
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
    "scan-por-componente.jpg",
  ])("%s comes out byte for byte as the whole-image decode", (name) => {
    expect(
      sameRaster(decodeJpegFitted(read(name), FIT), wholeFit(read(name))),
    ).toBe(true);
  });

  test("the conversion takes the band decoder and sends the same JPEG as before", async () => {
    const bytes = read("amostragem-2x2.jpg");
    const decodeWholeJpeg = refusingWholeDecode();
    const out = await runMediaConverter("jpeg-fit", ab(bytes), {
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
    await runMediaConverter("jpeg-fit", ab(read(name)), {
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

  test("a sampling factor past the standard's 4 is left to jpeg-js", () => {
    const bytes = read("amostragem-2x2.jpg");
    let sof = 2;
    while (!(bytes[sof] === 0xff && bytes[sof + 1] === 0xc0))
      sof +=
        2 + (((bytes[sof + 2] as number) << 8) | (bytes[sof + 3] as number));
    bytes[sof + 11] = 0x55; // the first component's sampling, 2x2 before
    expect(decodeJpegFitted(bytes, FIT)).toBeNull();
  });

  // A file the band decoder covers but cannot finish is refused by it, never handed to jpeg-js: that
  // would allocate the whole image, which is what a forged or cut file must not get to do.
  test.each([
    ["cut in half", (b: Uint8Array) => b.subarray(0, b.length >> 1)],
    [
      "declaring more rows than it carries",
      (b: Uint8Array) => {
        const forged = b.slice();
        let sof = 2;
        while (!(forged[sof] === 0xff && forged[sof + 1] === 0xc0))
          sof +=
            2 +
            (((forged[sof + 2] as number) << 8) | (forged[sof + 3] as number));
        forged[sof + 5] = 0x1f; // 33 rows become 8000
        forged[sof + 6] = 0x40;
        return forged;
      },
    ],
  ])(
    "a file %s is refused without the whole-image decode",
    async (_, damage) => {
      const decodeWholeJpeg = refusingWholeDecode();
      const outcome = runMediaConverter(
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
