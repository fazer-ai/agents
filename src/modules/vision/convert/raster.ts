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
  // NO GUARD ON THE BOXES, neither against an empty one nor against one running past the edge,
  // because neither can happen and a branch for an impossible case is code no test can kill. The
  // early return above means this only ever downscales, so `dw <= sw` and `fx = sw / dw >= 1`, and
  // from that:
  //
  //   non-empty   for fx >= 1, floor((x + 1) * fx) >= floor(x * fx + 1) > floor(x * fx), so every
  //               box holds at least one pixel and `n` is never zero
  //   in bounds   the last box ends at floor(dw * fx) = floor(dw * (sw / dw)) = sw, and the float
  //               error in that product is ~1e-12, twelve orders of magnitude short of the whole
  //               pixel it would take to read past the buffer
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

// JPEG HAS NO ALPHA, and the decoders hand us some: measured on a HEIC made by iOS's own "remove
// background" (`sips -s format heic` from an RGBA PNG), the transparent half comes back with a = 0
// and whatever RGB happened to be under it, which jpeg-js writes verbatim — a cutout would reach the
// model as a black rectangle. White is the composite every viewer uses for a cutout and the neutral
// for a photographed document.
//
// BEFORE the resize, not after, because the area average has no notion of alpha: averaging a box
// that straddles a cutout's edge would mix transparent pixels' RGB into the visible ones and leave a
// dark fringe. Flattening first means `fitRgba` only ever averages real colour.
//
// Returns the INPUT untouched when every pixel is opaque, which is every camera photo, so the common
// case pays one comparison per pixel and no allocation.
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
  // CLAMPED, not wrapping. Premultiplied colour is supposed to be at most its alpha, and lossy HEVC
  // does not have to honour that: a decoded pixel of [129, 129, 129, 128] composites to 256, which a
  // plain Uint8Array stores as 0 — a BLACK pixel where the arithmetic asked for white. Saturating is
  // the correct answer and costs nothing (PR #707 review round 11).
  const out = new Uint8ClampedArray(s.length);
  // Premultiplied colour is ALREADY scaled by its alpha, so multiplying again darkens everything
  // translucent: a pixel of (100, 0, 0, 128) over white comes out 177 instead of 227 (PR #707 review
  // round 10).
  //
  // THE FLAG IS THE ONLY THING THAT SAYS WHICH FORMULA APPLIES, and that is measured rather than
  // assumed: the same PNG encoded twice, with and without `heif-enc --premultiplied-alpha`, decodes
  // to the IDENTICAL bytes `[100, 0, 0, 128]` and differs only in what
  // `is_premultiplied_alpha()` answers. So ignoring it is not a worse guess, it is having no
  // information at all — which is also why the defect is invisible from both sides: the output does
  // not look broken, and the pixels do not say which formula was owed.
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

// NOTE: jpeg-js indexes the array rather than requiring a Buffer, so the RGBA a decoder handed us
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
// box that straddles a cutout's edge — 54 levels of red on the measured case, invisible in a green
// test. Keeping the sequence in a named step is what lets a test assert it; spelled out at each call
// site, the order was a mutation nothing could kill.
export function rasterToJpeg(
  raw: Rgba,
  opts: { maxEdge: number; quality: number },
): ArrayBuffer {
  return encodeJpeg(fitRgba(flattenOntoWhite(raw), opts.maxEdge), opts.quality);
}
