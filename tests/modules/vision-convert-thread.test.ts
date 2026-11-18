import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import {
  MediaConversionError,
  MediaSourceMismatchError,
  MediaTooLargeError,
  runMediaConverter,
} from "@/modules/vision/convert";
import type { MediaConverterId } from "@/modules/vision/media-conversion";

const fixture = (name: string) =>
  new URL(`../fixtures/media-thread/${name}`, import.meta.url).href;

const RECIBO = readFileSync(`${import.meta.dir}/../fixtures/media/recibo.heic`);
const heic = (): ArrayBuffer =>
  RECIBO.buffer.slice(
    RECIBO.byteOffset,
    RECIBO.byteOffset + RECIBO.byteLength,
  ) as ArrayBuffer;

function gradient(width: number, height: number): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = (x * 255) / width;
      data[i + 1] = (y * 255) / height;
      data[i + 2] = ((x + y) * 128) / (width + height);
      data[i + 3] = 255;
    }
  return data;
}

const asArrayBuffer = (b: Uint8Array): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

// Built once, outside any probe: encoding them is synchronous work of the test's own.
const JPEG_PHOTO = asArrayBuffer(
  jpeg.encode({ data: gradient(4000, 3000), width: 4000, height: 3000 }, 90)
    .data,
);
const PNG_PHOTO = (() => {
  const png = new PNG({ width: 3000, height: 2000 });
  gradient(3000, 2000).copy(png.data);
  return asArrayBuffer(PNG.sync.write(png));
})();

// The longest the event loop went without turning while `run` was in flight, read by a
// `setImmediate` chain. The last stretch counts too: a conversion that holds the loop until it
// returns shows up there and nowhere else.
async function longestStall<T>(
  run: () => Promise<T>,
): Promise<{ result: T; stallMs: number; totalMs: number; turns: number }> {
  let last = performance.now();
  let stallMs = 0;
  let turns = 0;
  let probing = true;
  const tick = () => {
    const now = performance.now();
    stallMs = Math.max(stallMs, now - last);
    last = now;
    turns++;
    if (probing) setImmediate(tick);
  };
  setImmediate(tick);
  const startedAt = performance.now();
  const result = await run();
  const end = performance.now();
  probing = false;
  stallMs = Math.max(stallMs, end - last);
  return { result, stallMs, totalMs: end - startedAt, turns };
}

describe("a media conversion runs off the event loop", () => {
  // Relative and not a fixed number of milliseconds, so a loaded runner does not decide it: on the
  // calling thread the longest stall IS the conversion (all of it but the awaits), and in a thread
  // of its own the loop keeps turning for the whole of it.
  test.each<[string, MediaConverterId, () => ArrayBuffer]>([
    ["a real HEIC", "heic-to-jpeg", heic],
    ["a 12 MP JPEG", "jpeg-fit", () => JPEG_PHOTO],
    ["a 6 MP PNG", "png-fit", () => PNG_PHOTO],
  ])(
    "%s: the loop keeps turning while it converts",
    async (_, id, bytes) => {
      const { result, stallMs, totalMs, turns } = await longestStall(() =>
        runMediaConverter(id, bytes()),
      );
      expect(new Uint8Array(result).subarray(0, 2)).toEqual(
        new Uint8Array([0xff, 0xd8]),
      );
      expect(turns).toBeGreaterThan(10);
      expect(stallMs).toBeLessThan(totalMs / 2);
    },
    60_000,
  );

  test("the caller's bytes are still whole afterwards, for the original it may still send", async () => {
    const bytes = heic();
    await runMediaConverter("heic-to-jpeg", bytes);
    expect(bytes.byteLength).toBe(RECIBO.byteLength);
    const mismatch = asArrayBuffer(new Uint8Array(JPEG_PHOTO));
    await expect(
      runMediaConverter("heic-to-jpeg", mismatch),
    ).rejects.toBeInstanceOf(MediaSourceMismatchError);
    expect(mismatch.byteLength).toBe(JPEG_PHOTO.byteLength);
  });

  test("a refusal made in the thread comes back as the same class, with its limits applied there", async () => {
    const err = await runMediaConverter("heic-to-jpeg", heic(), {
      maxSourcePixels: 1000,
      maxTiledSourcePixels: 1000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaTooLargeError);
    expect((err as Error).message).toContain("over the 1000 px cap");
  });
});

describe("a conversion thread that fails is a MediaConversionError, never a hung attachment", () => {
  const realWorker = globalThis.Worker;
  afterEach(() => {
    globalThis.Worker = realWorker;
  });

  test.each([
    ["dies on the request", "worker-dies.ts", "crashed"],
    ["exits without answering", "worker-exits.ts", "exited without answering"],
    ["dies while loading", "worker-boot-fails.ts", "crashed"],
    ["never answers", "worker-hangs.ts", "did not finish within 300 ms"],
  ])(
    "a thread that %s",
    async (_, file, says) => {
      const err = await runMediaConverter("heic-to-jpeg", heic(), {
        workerUrl: fixture(file),
        timeoutMs: 300,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MediaConversionError);
      expect((err as Error).message).toContain(says);
      // The queue is not wedged by it: the next conversion runs and answers.
      const out = await runMediaConverter("heic-to-jpeg", heic());
      expect(new Uint8Array(out)[0]).toBe(0xff);
    },
    30_000,
  );

  test("a thread that cannot be created is refused the same way", async () => {
    globalThis.Worker = class {
      constructor() {
        throw new Error("no threads here");
      }
    } as unknown as typeof Worker;
    const err = await runMediaConverter("heic-to-jpeg", heic()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MediaConversionError);
    expect((err as Error).message).toContain("no threads here");
  });

  test("a burst of conversions holds one thread at a time, and every thread is ended", async () => {
    let alive = 0;
    let most = 0;
    let created = 0;
    globalThis.Worker = class extends realWorker {
      #ended = false;
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        created++;
        alive++;
        most = Math.max(most, alive);
      }
      override terminate() {
        if (!this.#ended) {
          this.#ended = true;
          alive--;
        }
        super.terminate();
      }
    } as typeof Worker;
    const outs = await Promise.all(
      Array.from({ length: 6 }, () =>
        runMediaConverter("heic-to-jpeg", heic()),
      ),
    );
    expect(outs.every((o) => new Uint8Array(o)[0] === 0xff)).toBe(true);
    expect(created).toBe(6);
    expect(most).toBe(1);
    expect(alive).toBe(0);
  }, 60_000);
});
