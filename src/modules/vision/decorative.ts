// IS THIS BODY IMAGE AN ORNAMENT? (issue #864)
//
// An email body carries the customer's photo next to signature icons and the logos of the emails it
// quotes. Measured on one production mailbox, 4,663 body images in 14 days: one store logo quoted
// 1,490 times (908x140), icons at 144x144 about 900 times, a 720x150 banner, a 24x24 glyph. The
// rule below drops 2,437 of them and, of the 1,429 images that appear exactly once (where the
// photos are), only 15, all icons and banners.
//
// Small in both sides, or small in one and at least three times as long in the other. An iPhone
// photo sent at the small size (148x320) stays; a banner (720x150) goes.
//
// Only the header is read, PNG, GIF, WebP and JPEG. An image whose size it cannot read (HEIC, the
// iPhone camera default) is KEPT: dropping it would drop photos.

const SMALL_SIDE = 160;
const BANNER_RATIO = 3;

function pngSize(b: Uint8Array, v: DataView): [number, number] | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || !sig.every((x, i) => b[i] === x)) return null;
  return [v.getUint32(16), v.getUint32(20)];
}

function gifSize(b: Uint8Array, v: DataView): [number, number] | null {
  if (b.length < 10 || String.fromCharCode(...b.subarray(0, 4)) !== "GIF8")
    return null;
  return [v.getUint16(6, true), v.getUint16(8, true)];
}

function webpSize(b: Uint8Array, v: DataView): [number, number] | null {
  if (
    b.length < 31 ||
    String.fromCharCode(...b.subarray(0, 4)) !== "RIFF" ||
    String.fromCharCode(...b.subarray(8, 12)) !== "WEBP"
  )
    return null;
  const chunk = String.fromCharCode(...b.subarray(12, 16));
  if (chunk === "VP8X")
    return [
      1 + (v.getUint32(24, true) & 0xffffff),
      1 + (v.getUint32(27, true) & 0xffffff),
    ];
  if (chunk === "VP8 ")
    return [v.getUint16(26, true) & 0x3fff, v.getUint16(28, true) & 0x3fff];
  if (chunk === "VP8L") {
    const bits = v.getUint32(21, true);
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
  }
  return null;
}

function jpegSize(b: Uint8Array, v: DataView): [number, number] | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = v.getUint8(i + 1);
    if (marker === 0xff) {
      i++;
      continue;
    }
    const len = v.getUint16(i + 2);
    // SOF0..SOF15, minus DHT (C4), JPG (C8) and DAC (CC), which share the range.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    )
      return [v.getUint16(i + 7), v.getUint16(i + 5)];
    i += 2 + len;
  }
  return null;
}

export function imageSize(bytes: ArrayBuffer): [number, number] | null {
  const b = new Uint8Array(bytes);
  const v = new DataView(bytes);
  try {
    return (
      pngSize(b, v) ?? gifSize(b, v) ?? webpSize(b, v) ?? jpegSize(b, v) ?? null
    );
  } catch {
    return null;
  }
}

export function isDecorativeImage(bytes: ArrayBuffer): boolean {
  const size = imageSize(bytes);
  if (!size) return false;
  const small = Math.min(...size);
  const large = Math.max(...size);
  if (small <= 0) return false;
  return (
    large <= SMALL_SIDE ||
    (small <= SMALL_SIDE && large >= BANNER_RATIO * small)
  );
}
