// The two steps every raster conversion ends with, kept apart from the format that starts it. A
// second decoder (TIFF, AVIF) brings its own way of producing RGBA and then wants exactly this: fit
// to the edge the vendors downscale to anyway, and encode something they read.

import jpeg from "jpeg-js";

export type Rgba = {
  readonly data: Uint8Array | Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  // WHAT THE RGB MEANS WHERE ALPHA IS NOT 255, which is a property of these bytes and not of the
  // file they came from. Premultiplied means the colour has already been multiplied by the alpha, so
  // compositing it must NOT multiply again. Absent is straight alpha, which is what every other
  // source here produces.
  readonly premultiplied?: boolean;
};

// AREA AVERAGE, not nearest neighbour. The thing being downscaled is a photo of a receipt or a
// prescription, and the model's job is to read the text on it: dropping 5 of every 6 pixels aliases
// thin strokes into noise, while averaging the box keeps them legible. It costs 21ms on a 12 MP
// image (measured), against ~450ms for the decode that precedes it.
//
// Returns the INPUT untouched when nothing needs scaling, so an image already within the edge is not
// copied for nothing.
export function fitRgba(src: Rgba, maxEdge: number): Rgba {
  const { width: sw, height: sh } = src;
  // NOT clamped to 1, because the line below is what forbids growing and clamping as well would be
  // a second expression of the same rule — one no test could tell from the first.
  const scale = maxEdge / Math.max(sw, sh);
  if (scale >= 1) return src;
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const out = new Uint8Array(dw * dh * 4);
  const fx = sw / dw;
  const fy = sh / dh;
  const s = src.data;
  // NOTE: no guard on the boxes: this only downscales, so `fx = sw / dw >= 1`, every box holds at
  // least one pixel (floor((x + 1) * fx) > floor(x * fx)), and the last ends at floor(dw * fx) = sw
  // (float error ~1e-12, far short of a pixel).
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.floor((y + 1) * fy);
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.floor((x + 1) * fx);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * sw + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          r += s[i] as number;
          g += s[i + 1] as number;
          b += s[i + 2] as number;
          a += s[i + 3] as number;
          n++;
        }
      }
      const o = (y * dw + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return { data: out, width: dw, height: dh };
}

// THE SAME AREA AVERAGE AS `fitRgba`, fed a piece at a time. A tiled source is decoded one tile after
// another and never exists whole, so the average is accumulated straight into the output: the memory
// is the output's sums plus the tile in hand, whatever the source size. The boxes are `fitRgba`'s own
// (source column `sx` falls in the box `x` with floor(x * fx) <= sx < floor((x + 1) * fx)) and the
// division truncates the same way, so the result is byte for byte what fitting the whole image gives.
export class FitAccumulator {
  readonly width: number;
  readonly height: number;
  private readonly colOf: Int32Array;
  private readonly rowOf: Int32Array;
  private readonly sums: Uint32Array;
  private readonly counts: Uint32Array;

  constructor(sourceWidth: number, sourceHeight: number, maxEdge: number) {
    const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
    this.width =
      scale < 1 ? Math.max(1, Math.round(sourceWidth * scale)) : sourceWidth;
    this.height =
      scale < 1 ? Math.max(1, Math.round(sourceHeight * scale)) : sourceHeight;
    this.colOf = boxIndex(sourceWidth, this.width);
    this.rowOf = boxIndex(sourceHeight, this.height);
    this.sums = new Uint32Array(this.width * this.height * 4);
    this.counts = new Uint32Array(this.width * this.height);
  }

  // `piece` is opaque and sits at (left, top) of the source. The caller clips it to the source: a
  // grid's edge tiles are padded past the image, and that padding is not part of it.
  add(piece: Rgba, left: number, top: number): void {
    // Out of range, the box lookup is `undefined` and every write lands on a NaN index, which a
    // typed array silently drops: a misplaced piece would vanish instead of failing.
    if (
      left < 0 ||
      top < 0 ||
      left + piece.width > this.colOf.length ||
      top + piece.height > this.rowOf.length
    )
      throw new Error(
        `piece ${piece.width}x${piece.height} at ${left},${top} is outside the ${this.colOf.length}x${this.rowOf.length} source`,
      );
    const s = piece.data;
    for (let y = 0; y < piece.height; y++) {
      const row = (this.rowOf[top + y] as number) * this.width;
      let i = y * piece.width * 4;
      for (let x = 0; x < piece.width; x++, i += 4) {
        const o = row + (this.colOf[left + x] as number);
        const k = o * 4;
        this.sums[k] = (this.sums[k] as number) + (s[i] as number);
        this.sums[k + 1] = (this.sums[k + 1] as number) + (s[i + 1] as number);
        this.sums[k + 2] = (this.sums[k + 2] as number) + (s[i + 2] as number);
        this.sums[k + 3] = (this.sums[k + 3] as number) + (s[i + 3] as number);
        this.counts[o] = (this.counts[o] as number) + 1;
      }
    }
  }

  result(): Rgba {
    const out = new Uint8Array(this.width * this.height * 4);
    for (let o = 0; o < this.counts.length; o++) {
      const n = this.counts[o] as number;
      const k = o * 4;
      out[k] = (this.sums[k] as number) / n;
      out[k + 1] = (this.sums[k + 1] as number) / n;
      out[k + 2] = (this.sums[k + 2] as number) / n;
      out[k + 3] = (this.sums[k + 3] as number) / n;
    }
    return { data: out, width: this.width, height: this.height };
  }
}

// For each source coordinate, the output box it averages into, by the same floor bounds `fitRgba`
// iterates.
function boxIndex(sourceLength: number, outLength: number): Int32Array {
  const map = new Int32Array(sourceLength);
  const f = sourceLength / outLength;
  // Each box starts where the previous ended, which for d > 0 is floor(d * f), as in `fitRgba`.
  let s = 0;
  for (let d = 0; d < outLength; d++) {
    const end = Math.floor((d + 1) * f);
    for (; s < end; s++) map[s] = d;
  }
  return map;
}

// JPEG has no alpha, and decoders hand some back (an iOS background-removed HEIC): jpeg-js writes the
// RGB under a = 0 verbatim, so a cutout would reach the model as a black rectangle. White, as every
// viewer composites a cutout. BEFORE the resize, since the area average ignores alpha and would leave
// a dark fringe. Returns the INPUT untouched when every pixel is opaque (every camera photo).
export function flattenOntoWhite(src: Rgba): Rgba {
  const s = src.data;
  let transparent = false;
  for (let i = 3; i < s.length; i += 4) {
    if (s[i] !== 255) {
      transparent = true;
      break;
    }
  }
  if (!transparent) return src;
  // Clamped, not wrapping: lossy HEVC can decode premultiplied colour above its alpha
  // ([129, 129, 129, 128] composites to 256), which a plain Uint8Array stores as a BLACK 0.
  const out = new Uint8ClampedArray(s.length);
  // Premultiplied colour is ALREADY scaled by its alpha, so multiplying again darkens anything
  // translucent. Only the flag says which formula applies: the same image with and without
  // premultiplied alpha decodes to IDENTICAL bytes.
  const premultiplied = src.premultiplied === true;
  for (let i = 0; i < s.length; i += 4) {
    const a = (s[i + 3] as number) / 255;
    const bg = 255 * (1 - a);
    const k = premultiplied ? 1 : a;
    out[i] = (s[i] as number) * k + bg;
    out[i + 1] = (s[i + 1] as number) * k + bg;
    out[i + 2] = (s[i + 2] as number) * k + bg;
    out[i + 3] = 255;
  }
  return { data: out, width: src.width, height: src.height };
}

// Jpeg-js indexes the array rather than requiring a Buffer, so the RGBA a decoder handed us
// goes in as it came — a `Buffer.from` here would copy 48 MB per 12 MP photo to change nothing.
export function encodeJpeg(src: Rgba, quality: number): ArrayBuffer {
  const out = jpeg.encode(
    {
      data: src.data as unknown as Buffer,
      width: src.width,
      height: src.height,
    },
    quality,
  );
  const bytes = out.data;
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

// THE WHOLE TAIL OF A RASTER CONVERSION, in one place and in this order. Every decoder that produces
// RGBA ends here, and the ORDER is the part worth naming: flatten, then fit, then encode. Flattening
// after the fit averages colour and alpha together and composites the result, which darkens every
// box that straddles a cutout's edge, a shift a green test does not see. The sequence lives in this
// named step so a test can assert it; spelled out at each call site, no test would catch a swap.
export function rasterToJpeg(
  raw: Rgba,
  opts: { maxEdge: number; quality: number },
): ArrayBuffer {
  return encodeJpeg(fitRgba(flattenOntoWhite(raw), opts.maxEdge), opts.quality);
}
