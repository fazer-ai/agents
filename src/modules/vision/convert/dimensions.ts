// WHAT AN IMAGE MEASURES, read off its header without decoding a pixel. A provider limit on
// dimensions (Anthropic refuses a side over 8000 px) has to be known BEFORE the call, and decoding a
// 36 MP photo to learn its size would spend the memory the decision is meant to save. Bytes no
// header reader recognises answer null and go as they came.

import { imageSize } from "../decorative";

export type ImageDimensions = { width: number; height: number };

// Sniffed from the bytes by the reader the ornament check already trusts (PNG, GIF, WebP, JPEG), and
// not from the declared type: a mislabelled file is caught by the converter, which sends it as
// received.
export function readImageDimensions(
  bytes: ArrayBuffer,
): ImageDimensions | null {
  const size = imageSize(bytes);
  if (!size || size[0] <= 0 || size[1] <= 0) return null;
  return { width: size[0], height: size[1] };
}

export function isJpeg(bytes: ArrayBuffer): boolean {
  const b = new Uint8Array(bytes, 0, Math.min(3, bytes.byteLength));
  return b.length === 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 8) return false;
  const b = new Uint8Array(bytes, 0, 8);
  return PNG_SIGNATURE.every((v, i) => b[i] === v);
}

// The Exif Orientation tag (0x0112) in APP1, 1 when absent or unreadable. Read because re-encoding
// the pixels drops the tag: a photo a phone stored landscape and flagged "rotate 90" would otherwise
// reach the model sideways.
export function readJpegOrientation(bytes: ArrayBuffer): number {
  try {
    if (!isJpeg(bytes)) return 1;
    const v = new DataView(bytes);
    let i = 2;
    while (i + 4 <= bytes.byteLength) {
      if (v.getUint8(i) !== 0xff) return 1;
      const marker = v.getUint8(i + 1);
      // Any marker may be preceded by 0xFF fill bytes, which carry no length.
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xda || marker === 0xd9) return 1;
      const length = v.getUint16(i + 2);
      if (marker === 0xe1 && length >= 16) {
        const start = i + 4;
        const id = String.fromCharCode(...new Uint8Array(bytes, start, 6));
        if (id === "Exif\0\0")
          return exifOrientation(v, start + 6, i + 2 + length);
      }
      i += 2 + length;
    }
  } catch {
    // A malformed Exif block is not worth refusing the photo over: it is read upright.
  }
  return 1;
}

function exifOrientation(v: DataView, tiff: number, end: number): number {
  const order = v.getUint16(tiff);
  const little = order === 0x4949;
  if (!little && order !== 0x4d4d) return 1;
  const ifd = tiff + v.getUint32(tiff + 4, little);
  if (ifd + 2 > end) return 1;
  const count = v.getUint16(ifd, little);
  for (let k = 0; k < count; k++) {
    const entry = ifd + 2 + k * 12;
    if (entry + 12 > end) return 1;
    if (v.getUint16(entry, little) === 0x0112) {
      const value = v.getUint16(entry + 8, little);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}
