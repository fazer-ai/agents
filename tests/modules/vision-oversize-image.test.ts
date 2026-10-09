import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import {
  readImageDimensions,
  readJpegOrientation,
} from "@/modules/vision/convert/dimensions";
import {
  MediaConversionError,
  MediaSourceMismatchError,
  MediaTooLargeError,
  runMediaConverter,
} from "@/modules/vision/convert/index";
import {
  MAX_IMAGE_EDGE,
  planImageConversion,
} from "@/modules/vision/media-conversion";
import { getVisionProvider, VisionError } from "@/modules/vision/providers";

// Anthropic refuses an image with a side over 8000 px (400 "At least one of the image dimensions
// exceed max allowed size: 8000 pixels", measured against the live API with a 4536x8064 phone photo
// and with the same photo at 4500x8000, which passes). OpenAI and Gemini downscale on their side,
// which is why the same photos fail only once vision is configured with Claude.

function solid(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    // A left-to-right ramp, so a rotation or a flip shows up as a different first column.
    const x = (i / 4) % width;
    data[i] = Math.round((x / width) * 255);
    data[i + 1] = 80;
    data[i + 2] = 160;
    data[i + 3] = 255;
  }
  return data;
}

function jpegOf(width: number, height: number): Buffer {
  return jpeg.encode({ data: solid(width, height), width, height }, 80)
    .data as Buffer;
}

function pngOf(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  png.data = Buffer.from(solid(width, height));
  return PNG.sync.write(png);
}

// An APP1 Exif segment carrying only the Orientation tag, inserted right after SOI, which is where a
// camera writes it.
function withOrientation(jpg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write("MM\0*", 0, "latin1");
  tiff.writeUInt32BE(8, 4); // IFD0 offset
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(0x0112, 10); // Orientation
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14); // count
  tiff.writeUInt16BE(orientation, 18); // value, left-justified in the 4-byte slot
  tiff.writeUInt32BE(0, 22); // next IFD
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpg.subarray(0, 2), header, payload, jpg.subarray(2)]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([head.subarray(4), data]))
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([head, data, tail]);
}

function ihdr(width: number, height: number, interlace: number): Buffer {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(width, 0);
  d.writeUInt32BE(height, 4);
  d[8] = 8; // bit depth
  d[9] = 6; // RGBA
  d[12] = interlace;
  return chunk("IHDR", d);
}

// A PNG assembled chunk by chunk, so the tests can write what no encoder would: a second IHDR, or
// pixel data far larger than the header admits.
function rawPng(chunks: Buffer[]): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...chunks,
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Every Adam7 pass of a width x height RGBA image, each scanline a zero filter byte and zero pixels.
function interlacedPixels(width: number, height: number): Buffer {
  const passes = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ] as const;
  let size = 0;
  for (const [xs, ys, dx, dy] of passes) {
    const w = width > xs ? Math.ceil((width - xs) / dx) : 0;
    const h = height > ys ? Math.ceil((height - ys) / dy) : 0;
    if (w > 0 && h > 0) size += h * (1 + w * 4);
  }
  return Buffer.alloc(size);
}

function ab(b: Buffer): ArrayBuffer {
  return b.buffer.slice(
    b.byteOffset,
    b.byteOffset + b.byteLength,
  ) as ArrayBuffer;
}

describe("image dimensions read off the header, without decoding", () => {
  test("a JPEG reports its stored width and height", () => {
    expect(readImageDimensions(ab(jpegOf(321, 123)))).toEqual({
      width: 321,
      height: 123,
    });
  });

  test("a PNG reports its IHDR width and height", () => {
    expect(readImageDimensions(ab(pngOf(321, 123)))).toEqual({
      width: 321,
      height: 123,
    });
  });

  test("bytes no header reader recognises report nothing", () => {
    expect(readImageDimensions(new ArrayBuffer(3))).toBeNull();
    expect(
      readImageDimensions(ab(Buffer.from("not an image at all, just text"))),
    ).toBeNull();
  });

  test("the Exif orientation is read, and a JPEG without one is upright", () => {
    expect(readJpegOrientation(ab(withOrientation(jpegOf(8, 4), 6)))).toBe(6);
    // Fill bytes before the APP1 marker are legal and carry no length.
    const padded = withOrientation(jpegOf(8, 4), 6);
    expect(
      readJpegOrientation(
        ab(
          Buffer.concat([
            padded.subarray(0, 2),
            Buffer.from([0xff, 0xff]),
            padded.subarray(2),
          ]),
        ),
      ),
    ).toBe(6);
    expect(readJpegOrientation(ab(jpegOf(8, 4)))).toBe(1);
  });
});

describe("planImageConversion with the provider's dimension limit", () => {
  test("Anthropic's limit is 8000 px", () => {
    expect(MAX_IMAGE_EDGE.anthropic).toBe(8000);
  });

  test("over the limit on Anthropic, a JPEG and a PNG are downscaled", () => {
    const over = { width: 4536, height: 8064 };
    expect(
      planImageConversion({
        provider: "anthropic",
        mimeType: "image/jpeg",
        dimensions: over,
      }),
    ).toEqual({ action: "convert", converter: "jpeg-fit", to: "image/jpeg" });
    expect(
      planImageConversion({
        provider: "anthropic",
        mimeType: "image/png",
        dimensions: { width: 9000, height: 300 },
      }),
    ).toEqual({ action: "convert", converter: "png-fit", to: "image/jpeg" });
  });

  test("at the limit, below it, or with no dimensions, it goes as it came", () => {
    for (const dimensions of [
      { width: 4500, height: 8000 },
      { width: 1000, height: 1000 },
      null,
      undefined,
    ])
      expect(
        planImageConversion({
          provider: "anthropic",
          mimeType: "image/jpeg",
          dimensions,
        }).action,
      ).toBe("as-is");
  });

  test("a file over Anthropic's 10 MB base64 ceiling is re-encoded even under 8000 px", () => {
    // 7,864,320 raw bytes is exactly 10 MiB as base64; one byte more crosses it.
    const small = { width: 3000, height: 4000 };
    expect(
      planImageConversion({
        provider: "anthropic",
        mimeType: "image/jpeg",
        dimensions: small,
        byteLength: 7_864_321,
      }).action,
    ).toBe("convert");
    expect(
      planImageConversion({
        provider: "anthropic",
        mimeType: "image/jpeg",
        dimensions: small,
        byteLength: 7_864_320,
      }).action,
    ).toBe("as-is");
    expect(
      planImageConversion({
        provider: "openai",
        mimeType: "image/jpeg",
        dimensions: small,
        byteLength: 20_000_000,
      }).action,
    ).toBe("as-is");
  });

  test("a provider that downscales on its side is left alone at any size", () => {
    for (const provider of ["openai", "gemini"])
      expect(
        planImageConversion({
          provider,
          mimeType: "image/jpeg",
          dimensions: { width: 4536, height: 8064 },
        }).action,
      ).toBe("as-is");
  });

  test("a type there is no decoder for goes as-is, and the vendor answers for itself", () => {
    expect(
      planImageConversion({
        provider: "anthropic",
        mimeType: "image/webp",
        dimensions: { width: 9000, height: 9000 },
      }).action,
    ).toBe("as-is");
  });
});

describe("the fit converters", () => {
  test("an over-limit JPEG comes back a JPEG within the limit, aspect kept", async () => {
    const out = Buffer.from(
      await runMediaConverter("jpeg-fit", ab(jpegOf(8100, 600))),
    );
    const d = jpeg.decode(out, { useTArray: true });
    expect(Math.max(d.width, d.height)).toBeLessThanOrEqual(1568);
    expect(
      Math.abs(d.width / d.height - 8100 / 600) / (8100 / 600),
    ).toBeLessThan(0.01);
  });

  test("an over-limit PNG comes back a JPEG within the limit, aspect kept", async () => {
    const out = Buffer.from(
      await runMediaConverter("png-fit", ab(pngOf(600, 8100))),
    );
    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xd8);
    const d = jpeg.decode(out, { useTArray: true });
    expect(Math.max(d.width, d.height)).toBeLessThanOrEqual(1568);
    expect(d.height).toBeGreaterThan(d.width);
  });

  test("the Exif orientation is applied, since re-encoding drops the tag", async () => {
    // Stored landscape, displayed portrait: what a phone held upright writes.
    const out = Buffer.from(
      await runMediaConverter(
        "jpeg-fit",
        ab(withOrientation(jpegOf(8100, 600), 6)),
      ),
    );
    const d = jpeg.decode(out, { useTArray: true });
    expect(d.height).toBeGreaterThan(d.width);
    expect(readJpegOrientation(ab(out))).toBe(1);
    // Turned CLOCKWISE, which is what 6 means: the stored left edge (the dark end of the ramp) ends
    // on top. Counter-clockwise would put it at the bottom with the same portrait shape.
    const red = (y: number) =>
      d.data[(y * d.width + (d.width >> 1)) * 4] as number;
    expect(red(2)).toBeLessThan(red(d.height - 3) - 100);
  });

  test("a header over the pixel cap is refused before any decode", async () => {
    await expect(
      runMediaConverter("jpeg-fit", ab(jpegOf(400, 300)), {
        maxSourcePixels: 1000,
      }),
    ).rejects.toBeInstanceOf(MediaTooLargeError);
  });

  test("a JPEG with more than one frame header is refused before it is decoded", async () => {
    // jpeg-js would allocate buffers for every SOF before refusing the second.
    const jpg = jpegOf(16, 8);
    let sof = 2;
    while (!(jpg[sof] === 0xff && jpg[sof + 1] === 0xc0))
      sof += 2 + jpg.readUInt16BE(sof + 2);
    const frame = jpg.subarray(sof, sof + 2 + jpg.readUInt16BE(sof + 2));
    const repeated = Buffer.concat([
      jpg.subarray(0, sof),
      frame,
      frame,
      jpg.subarray(sof + frame.length),
    ]);
    await expect(runMediaConverter("jpeg-fit", ab(repeated))).rejects.toThrow(
      "more than one frame",
    );
  });

  test("a PNG whose header is repeated is refused before pngjs reads the second one", async () => {
    // pngjs decodes with the LAST IHDR, so the cap checked against the first would not hold.
    const png = rawPng([
      ihdr(9000, 1, 0),
      // Its pixel data fits the FIRST header's length too, so only the IHDR check refuses it.
      ihdr(100, 80, 0),
      chunk("IDAT", deflateSync(Buffer.alloc(80 * (1 + 400)))),
    ]);
    await expect(
      runMediaConverter("png-fit", ab(png), { maxSourcePixels: 9000 }),
    ).rejects.toThrow("repeated IHDR");
  });

  test("interlaced pixel data larger than its header admits is refused before it is inflated", async () => {
    // 8 KB of IDAT that inflates to 8 MiB under a 9000x1 header (whose data is ~36 KB).
    const bomb = rawPng([
      ihdr(9000, 1, 1),
      chunk("IDAT", deflateSync(Buffer.alloc(8 * 1024 * 1024))),
    ]);
    // Refused by the bounded inflate, not by pngjs after it materialised the whole stream.
    const err = await runMediaConverter("png-fit", ab(bomb)).catch((e) => e);
    expect(err).toBeInstanceOf(MediaConversionError);
    expect(String(err.message)).toContain("does not inflate within");
  });

  test("a bit depth the color type does not allow is refused before it sizes the inflate", async () => {
    const forged = ihdr(100, 80, 0);
    forged[8 + 8] = 255; // the depth byte, past the length and type
    const err = await runMediaConverter(
      "png-fit",
      ab(rawPng([forged, chunk("IDAT", deflateSync(Buffer.alloc(16)))])),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(MediaConversionError);
    expect(String(err.message)).toContain("bit depth");
  });

  test("an honest interlaced PNG still converts", async () => {
    const png = rawPng([
      ihdr(37, 23, 1),
      chunk("IDAT", deflateSync(interlacedPixels(37, 23))),
    ]);
    const out = Buffer.from(await runMediaConverter("png-fit", ab(png)));
    const d = jpeg.decode(out, { useTArray: true });
    expect([d.width, d.height]).toEqual([37, 23]);
  });

  test("bytes that are not the declared type are a mismatch, sent as received", async () => {
    await expect(
      runMediaConverter("jpeg-fit", ab(pngOf(10, 10))),
    ).rejects.toBeInstanceOf(MediaSourceMismatchError);
    await expect(
      runMediaConverter("png-fit", ab(jpegOf(10, 10))),
    ).rejects.toBeInstanceOf(MediaSourceMismatchError);
  });
});

describe("a provider 4xx keeps the provider's own words", () => {
  const LIMIT_MESSAGE =
    "messages.0.content.0.image.source.base64.data: At least one of the image dimensions exceed max allowed size: 8000 pixels";

  function anthropicReplying(status: number, body: string): typeof fetch {
    return (async () =>
      new Response(body, {
        status,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
  }

  async function failureOf(fetchImpl: typeof fetch): Promise<VisionError> {
    const provider = getVisionProvider("anthropic");
    if (!provider) throw new Error("no anthropic provider");
    try {
      await provider.extract({
        bytes: ab(jpegOf(8, 8)),
        mimeType: "image/jpeg",
        kind: "image",
        prompt: "x",
        model: "claude-haiku-5-5",
        apiKey: "sk-ant-test",
        baseURL: "https://anthropic.test/v1",
        fetchImpl,
        timeoutMs: 5000,
      });
    } catch (err) {
      return err as VisionError;
    }
    throw new Error("expected a failure");
  }

  test("the cause is kept on the error, out of the message, and the status stays where retry reads it", async () => {
    const err = await failureOf(
      anthropicReplying(
        400,
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: LIMIT_MESSAGE },
        }),
      ),
    );
    expect(err).toBeInstanceOf(VisionError);
    expect(err.status).toBe(400);
    // The server chose those words, so they may quote the customer: `.message` reaches the
    // operator-facing stores and carries only the status and a refusal named in our words.
    expect(err.message).toBe(
      "vision anthropic failed with 400 (image dimensions exceed max allowed size)",
    );
    expect(err.providerMessage).toContain(
      "exceed max allowed size: 8000 pixels",
    );
  });

  test("an enormous message is cut, and a body that is not an error object adds nothing", async () => {
    const huge = await failureOf(
      anthropicReplying(
        400,
        JSON.stringify({
          error: { message: `INICIO ${"x".repeat(50_000)} FIM` },
        }),
      ),
    );
    expect(huge.providerMessage).toContain("INICIO");
    expect(huge.providerMessage).not.toContain("FIM");
    expect(huge.providerMessage?.length ?? 0).toBeLessThan(400);

    expect(huge.message).toBe("vision anthropic failed with 400");

    const bytes = await failureOf(
      anthropicReplying(
        400,
        JSON.stringify({
          error: {
            message:
              "messages.0.content.0.image.source.base64: image exceeds 10 MB maximum: 22199956 bytes > 10485760 bytes",
          },
        }),
      ),
    );
    expect(bytes.message).toBe(
      "vision anthropic failed with 400 (image bytes exceed max allowed size)",
    );

    const prose = await failureOf(anthropicReplying(400, "<html>oops</html>"));
    expect(prose.providerMessage).toBeNull();
    expect(prose.message).toBe("vision anthropic failed with 400");
  });
});
