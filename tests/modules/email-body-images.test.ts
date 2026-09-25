import { describe, expect, test } from "bun:test";
import {
  bodyImagesBesides,
  emailBodyImageUrlsFrom,
  servedBy,
} from "@/modules/chatwoot/email-body-images";
import {
  incomingRenderable,
  normalizeChatwootEvent,
} from "@/modules/chatwoot/normalize";
import { renderInboundMessage } from "@/modules/chatwoot/render";
import { isDecorativeImage } from "@/modules/vision/decorative";

// ISSUE #864: the picture a customer puts in an email body is kept by Chatwoot's mailbox INSIDE the
// body (a blob URL in `html_content.full`, or an `<img>` appended to `text_content.full` when the
// mail has no HTML part), never as an attachment. These are the two pure questions the fix asks:
// which URLs in the body are Chatwoot's own blobs, and which of those images are ornaments.

const BLOB =
  "https://chat.example.com/rails/active_storage/blobs/redirect/eyJfcmFpbHMiOnsiZGF0YSI6MTIzfX0=--abc/image0.jpeg";
const BLOB2 =
  "https://chat.example.com/rails/active_storage/blobs/redirect/eyJfcmFpbHMiOnsiZGF0YSI6NDU2fX0=--def/print.png";

describe("emailBodyImageUrlsFrom", () => {
  test("the iPhone shape: no HTML, the image appended to the plain text", () => {
    const ca = {
      email: {
        html_content: { full: "" },
        text_content: {
          full: `Segue o documento.\n\nEnviado do meu iPhone\n\n<img src="${BLOB}" alt="image0.jpeg">`,
        },
      },
    };
    expect(emailBodyImageUrlsFrom(ca)).toEqual([BLOB]);
  });

  test("the pasted shape: blob URLs in the HTML, in body order, each once", () => {
    const ca = {
      email: {
        html_content: {
          full: `<div>Oi<img src="${BLOB}"><br><img alt="x" src='${BLOB2}'><img src="${BLOB}"></div>`,
        },
        text_content: { full: "Oi" },
      },
    };
    expect(emailBodyImageUrlsFrom(ca)).toEqual([BLOB, BLOB2]);
  });

  test("a remote image the quoted HTML links to is not a Chatwoot blob", () => {
    const ca = {
      email: {
        html_content: {
          full: `<img src="https://cdn.shop.example/logo.png"><img src="${BLOB}"><img src="cid:abc@x">`,
        },
      },
    };
    expect(emailBodyImageUrlsFrom(ca)).toEqual([BLOB]);
  });

  test("a blob path relative to the Chatwoot host is kept, for the instance to resolve", () => {
    const ca = {
      email: {
        html_content: {
          full: `<img src="/rails/active_storage/blobs/redirect/x--y/a.png"><img src="//cdn.shop.example/rails/active_storage/blobs/redirect/z/b.png"><img src="rails/active_storage/blobs/redirect/w/c.png">`,
        },
      },
    };
    // A protocol-relative URL names another host, and a path without the leading slash is relative
    // to a page nobody knows: neither is this Chatwoot's.
    expect(emailBodyImageUrlsFrom(ca)).toEqual([
      "/rails/active_storage/blobs/redirect/x--y/a.png",
    ]);
  });

  test("a URL that only mentions the blob path, or climbs out of it, is not a blob", () => {
    const host = "https://chat.example.com";
    const ca = {
      email: {
        html_content: {
          full: [
            `${host}/api/v1/accounts/1/conversations?x=/rails/active_storage/`,
            `${host}/rails/active_storage/../../api/v1/profile`,
            `${host}/rails/active_storage/%2e%2e/%2e%2e/api/v1/profile`,
            "/rails/active_storage/../../api/v1/profile",
            `${host}/x#/rails/active_storage/`,
          ]
            .map((u) => `<img src="${u}">`)
            .join(""),
        },
      },
    };
    expect(emailBodyImageUrlsFrom(ca)).toEqual([]);
  });

  test("the host check itself refuses a path outside Active Storage", () => {
    const host = "https://chat.example.com";
    expect(
      servedBy(`${host}/rails/active_storage/blobs/redirect/s/a.png`, host),
    ).toBe(true);
    expect(
      servedBy(`${host}/api/v1/profile?x=/rails/active_storage/`, host),
    ).toBe(false);
    expect(
      servedBy(`${host}/rails/active_storage/../api/v1/profile`, host),
    ).toBe(false);
  });

  test("the src attribute is read as HTML writes it: unquoted, and never a data-src", () => {
    const rel = "/rails/active_storage/blobs/redirect/u--v/photo.png";
    const ca = {
      email: {
        html_content: {
          full: [
            `<img src=${rel}>`,
            `<img data-src="https://cdn.shop.example/p.png" src="${BLOB}">`,
            `<img alt="a > b src=${BLOB2}" src='${BLOB2}'>`,
            `<img data-src="${BLOB2}x" alt="only a placeholder">`,
          ].join(""),
        },
      },
    };
    expect(emailBodyImageUrlsFrom(ca)).toEqual([rel, BLOB, BLOB2]);
  });

  test("the host check never sends a body image down from https to http", () => {
    const path = "/rails/active_storage/blobs/redirect/s/a.png";
    expect(
      servedBy(`http://chat.example.com${path}`, "https://chat.example.com"),
    ).toBe(false);
    expect(
      servedBy(`https://chat.example.com${path}`, "https://chat.example.com"),
    ).toBe(true);
    // An instance reached over plain HTTP inside its network still reads what the dashboard serves.
    expect(
      servedBy(`https://chat.example.com${path}`, "http://chat.example.com"),
    ).toBe(true);
  });

  test("one blob named by different URLs is one image", () => {
    const rel = "/rails/active_storage/blobs/redirect/same--sig/a.png";
    const ca = {
      email: {
        html_content: {
          full: `<img src="${rel}"><img src="https://chat.example.com${rel}?v=2">`,
        },
        text_content: { full: `<img src="https://chat.example.com${rel}">` },
      },
    };
    expect(emailBodyImageUrlsFrom(ca)).toEqual([rel]);
  });

  test("the same blob in both bodies is one image", () => {
    const ca = {
      email: {
        html_content: { full: `<img src="${BLOB}">` },
        text_content: { full: `<img src="${BLOB}">` },
      },
    };
    expect(emailBodyImageUrlsFrom(ca)).toEqual([BLOB]);
  });

  test("HTML entities in the src are decoded before the URL is used", () => {
    const ca = {
      email: {
        html_content: {
          full: `<img src="${BLOB}?disposition=inline&amp;x=1">`,
        },
      },
    };
    expect(emailBodyImageUrlsFrom(ca)).toEqual([
      `${BLOB}?disposition=inline&x=1`,
    ]);
  });

  test("not an email, or a bag of another shape: nothing", () => {
    expect(emailBodyImageUrlsFrom(null)).toEqual([]);
    expect(emailBodyImageUrlsFrom({})).toEqual([]);
    expect(emailBodyImageUrlsFrom({ email: "x" })).toEqual([]);
    expect(
      emailBodyImageUrlsFrom({ email: { html_content: { full: 42 } } }),
    ).toEqual([]);
    expect(
      emailBodyImageUrlsFrom({
        email: { html_content: { full: `<a href="${BLOB}">link</a>` } },
      }),
    ).toEqual([]);
  });
});

describe("bodyImagesBesides", () => {
  test("a body image naming an attached blob is dropped, whatever host, name or query", () => {
    const attached =
      "https://chat.example.com/rails/active_storage/blobs/redirect/eyJfcmFpbHMiOnsiZGF0YSI6MTIzfX0=--abc/scan.jpeg";
    expect(
      bodyImagesBesides([`${BLOB}?disposition=inline`, BLOB2], [attached]),
    ).toEqual([BLOB2]);
    expect(bodyImagesBesides([BLOB, BLOB2], [])).toEqual([BLOB, BLOB2]);
  });
});

describe("the delivered event", () => {
  test("an email whose only content is a body image renders, so the direct path answers it", () => {
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: 1,
      content: "",
      message_type: "incoming",
      private: false,
      content_attributes: {
        email: { subject: "", html_content: { full: `<img src="${BLOB}">` } },
      },
      conversation: { id: 2, inbox_id: 3, status: "pending" },
    });
    if (!n) throw new Error("unreachable: valid event");
    expect(renderInboundMessage(incomingRenderable(n)).length).toBeGreaterThan(
      0,
    );
  });
});

// A PNG whose header declares w x h. The IHDR is all `isDecorativeImage` reads.
function png(w: number, h: number): ArrayBuffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

// A baseline JPEG: SOI, one APP0 segment to skip, then SOF0 with h x w.
function jpeg(w: number, h: number): ArrayBuffer {
  const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00];
  const sof = [
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    h >> 8,
    h & 0xff,
    w >> 8,
    w & 0xff,
    0x03,
  ];
  const b = Buffer.from([0xff, 0xd8, ...app0, ...sof, ...new Array(9).fill(0)]);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

describe("isDecorativeImage", () => {
  // The sizes are the ones measured on a production mailbox (issue #864): the logo quoted from the
  // store's own emails, the icon set, the banner, the warning glyph.
  test.each([
    [908, 140, "the logo of a quoted transactional email"],
    [144, 144, "a signature icon"],
    [720, 150, "an email banner"],
    [24, 24, "a warning glyph"],
    [542, 96, "a signature banner"],
    [16, 16, "a social icon"],
  ])("%dx%d is decorative (%s)", (w, h) => {
    expect(isDecorativeImage(png(w, h))).toBe(true);
  });

  test.each([
    [1320, 1692, "an iPhone photo"],
    [1179, 2556, "a phone screenshot"],
    [148, 320, "an iPhone photo sent at the small size"],
    [539, 162, "a cropped screenshot"],
    [161, 161, "just over the icon size"],
  ])("%dx%d is content (%s)", (w, h) => {
    expect(isDecorativeImage(png(w, h))).toBe(false);
  });

  test("JPEG dimensions come from the frame header", () => {
    expect(isDecorativeImage(jpeg(908, 140))).toBe(true);
    expect(isDecorativeImage(jpeg(1320, 1692))).toBe(false);
  });

  test("an image whose size cannot be read is kept, not dropped", () => {
    // HEIC, the iPhone camera default: no header this reader knows. Dropping it would drop photos.
    const heic = Buffer.from("\0\0\0\x18ftypheic\0\0\0\0mif1heic", "binary");
    expect(
      isDecorativeImage(
        heic.buffer.slice(heic.byteOffset, heic.byteOffset + heic.byteLength),
      ),
    ).toBe(false);
    expect(isDecorativeImage(new ArrayBuffer(3))).toBe(false);
  });
});
