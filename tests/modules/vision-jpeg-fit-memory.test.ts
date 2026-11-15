import { expect, test } from "bun:test";

const CONVERT = Bun.resolveSync(
  "@/modules/vision/convert/index",
  import.meta.dir,
);

// A baseline grayscale JPEG of any size in a few bytes per block: every block is "DC unchanged, end
// of block" ("00" then "0" with these tables), so the scan is all zero bits.
function blankPhoto(width: number, height: number): Uint8Array {
  const segment = (marker: number, body: number[]) => [
    0xff,
    marker,
    (body.length + 2) >> 8,
    (body.length + 2) & 0xff,
    ...body,
  ];
  const head = [
    0xff,
    0xd8,
    ...segment(0xdb, [0, ...new Array(64).fill(1)]),
    ...segment(0xc0, [
      8,
      height >> 8,
      height & 0xff,
      width >> 8,
      width & 0xff,
      1,
      1,
      0x11,
      0,
    ]),
    ...segment(
      0xc4,
      [
        0x00, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5,
        6, 7, 8, 9, 10, 11,
      ],
    ),
    ...segment(0xc4, [0x10, 1, ...new Array(15).fill(0), 0x00]),
    ...segment(0xda, [1, 1, 0, 0, 63, 0]),
  ];
  const bits = Math.ceil(width / 8) * Math.ceil(height / 8) * 3;
  const scan = Math.ceil(bits / 8);
  const out = new Uint8Array(head.length + scan + 2);
  out.set(head, 0);
  const pad = scan * 8 - bits;
  if (pad > 0) out[head.length + scan - 1] = (1 << pad) - 1;
  out.set([0xff, 0xd9], out.length - 2);
  return out;
}

// The point of the decoder, measured where it can be: in a child process of its own, so the peak is
// the conversion's and not the test runner's. Measured here: 74 MB, against 377 MB for jpeg-js
// decoding the same file whole (a phone photo in colour costs about twice that).
test("a 31 MP photo is fitted without ever being held whole", () => {
  const script = [
    `const { runMediaConverter } = await import(${JSON.stringify(CONVERT)});`,
    `const out = await runMediaConverter("jpeg-fit", await Bun.stdin.arrayBuffer());`,
    "console.log(JSON.stringify({ bytes: out.byteLength, peakKB: process.resourceUsage().maxRSS }));",
  ].join("\n");
  const child = Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    stdin: blankPhoto(4096, 7520),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(child.stderr.toString()).toBe("");
  const { bytes, peakKB } = JSON.parse(child.stdout.toString()) as {
    bytes: number;
    peakKB: number;
  };
  expect(bytes).toBeGreaterThan(0);
  expect(peakKB).toBeLessThan(200_000);
}, 60_000);
