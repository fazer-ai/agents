import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import decode from "heic-decode";
import jpeg from "jpeg-js";
import {
  __disposeFramesForTest,
  __frameDimensionsForTest,
  __serializedForTest,
  MAX_SOURCE_PIXELS,
  MediaConversionError,
  runMediaConverter,
} from "@/modules/vision/convert";
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
        runMediaConverter(spec.id, new ArrayBuffer(4)),
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
    // `@types/heic-decode` 2.0.0 does not declare these fields, so a library version that stops
    // carrying them would silently remove the pixel cap. It has to fail loudly instead.
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

  test("the source HEIC is what a decoder says it is", async () => {
    // Guards the fixture itself: a truncated or re-encoded file would make every assertion above
    // pass for the wrong reason.
    const raw = await decode({ buffer: new Uint8Array(heicBytes()) });
    expect([raw.width, raw.height]).toEqual([2400, 1600]);
  });

  test("the library still hands its handles to us, non-enumerably", async () => {
    // THE CONTRACT THIS PR DEPENDS ON, asserted against the real library. `decode.all()` does not
    // dispose on its own (the one-shot `decode()` does), and it attaches `dispose` to the returned
    // ARRAY as a non-enumerable property, so neither the types nor a key probe reveal it. An upgrade
    // that moves or drops it has to fail here, not three weeks later as memory growth in production.
    const frames = await decode.all({ buffer: new Uint8Array(heicBytes()) });
    expect(Array.isArray(frames)).toBe(true);
    expect(Object.keys(frames)).not.toContain("dispose");
    expect(typeof (frames as unknown as { dispose?: unknown }).dispose).toBe(
      "function",
    );
    __disposeFramesForTest(frames);
  });

  test("the handles are released on every path out, refusals included", async () => {
    // The refusals are the paths that leaked most: the decoder and every handle are allocated by
    // `decode.all()` before the cap is even read. Driven through an injected decoder, because
    // "someone called dispose" is not visible from the bytes that come back.
    const calls: string[] = [];
    const framesFor = (width: number, height: number, decodes = true) => {
      const frames: unknown[] = [
        {
          width,
          height,
          decode: async () => {
            if (!decodes) throw new Error("decoder blew up");
            return { data: new Uint8Array(width * height * 4), width, height };
          },
        },
      ];
      Object.defineProperty(frames, "dispose", {
        enumerable: false,
        value: () => calls.push("dispose"),
      });
      return frames;
    };

    await runMediaConverter("heic-to-jpeg", new ArrayBuffer(8), {
      decodeAll: async () => framesFor(40, 30),
    });
    expect(calls).toEqual(["dispose"]);

    calls.length = 0;
    await expect(
      runMediaConverter("heic-to-jpeg", new ArrayBuffer(8), {
        decodeAll: async () => framesFor(4000, 3000),
        maxSourcePixels: 100,
      }),
    ).rejects.toBeInstanceOf(MediaConversionError);
    expect(calls).toEqual(["dispose"]);

    calls.length = 0;
    await expect(
      runMediaConverter("heic-to-jpeg", new ArrayBuffer(8), {
        decodeAll: async () => framesFor(40, 30, false),
      }),
    ).rejects.toBeInstanceOf(MediaConversionError);
    expect(calls).toEqual(["dispose"]);

    calls.length = 0;
    await expect(
      runMediaConverter("heic-to-jpeg", new ArrayBuffer(8), {
        decodeAll: async () => {
          const frames: unknown[] = [];
          Object.defineProperty(frames, "dispose", {
            enumerable: false,
            value: () => calls.push("dispose"),
          });
          return frames;
        },
      }),
    ).rejects.toBeInstanceOf(MediaConversionError);
    expect(calls).toEqual(["dispose"]);
  });

  test("a collection without dispose converts anyway instead of refusing", async () => {
    // A missing dispose costs a leak; refusing every photo over it would cost the feature.
    const out = await runMediaConverter("heic-to-jpeg", new ArrayBuffer(8), {
      decodeAll: async () => [
        {
          width: 40,
          height: 30,
          decode: async () => ({
            data: new Uint8Array(40 * 30 * 4),
            width: 40,
            height: 30,
          }),
        },
      ],
    });
    expect(out.byteLength).toBeGreaterThan(0);
    expect(() => __disposeFramesForTest([])).not.toThrow();
    expect(() => __disposeFramesForTest({ dispose: 42 })).not.toThrow();
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

  test("the decoder's own TypeError comes out as this module's error", async () => {
    // `heic-decode` throws a bare `TypeError("input buffer is not a HEIC image")`. The caller has one
    // catch, so a leaked foreign class is a contract break even though both are Errors; the original
    // stays reachable as `cause`.
    const promise = runMediaConverter(
      "heic-to-jpeg",
      new TextEncoder().encode("not a heic at all").buffer as ArrayBuffer,
    );
    await expect(promise).rejects.toBeInstanceOf(MediaConversionError);
    await expect(promise).rejects.toThrow(/not a HEIC image/);
    const err = await promise.catch((e: unknown) => e);
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(TypeError);
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
