// The process one media conversion runs in, spawned per conversion by `runMediaConverter` (./index).
// It reads the bytes from stdin, converts them, and answers once on stdout: the marker, a JSON header
// line, then the JPEG when it succeeded. Every decoder release happens in here, on the same paths as on the
// calling thread, before the answer is written.
import type { MediaConverterId } from "../media-conversion";
import {
  type ConversionHeader,
  type ConversionLimits,
  convertInline,
  describeConversionFailure,
  REPLY_MARKER,
} from "./index";

const id = process.argv[2] as MediaConverterId;
const limits = JSON.parse(process.argv[3] ?? "{}") as ConversionLimits;
const bytes = await Bun.stdin.arrayBuffer();

let header: ConversionHeader;
let body = new Uint8Array(0);
try {
  const out = await convertInline(id, bytes, limits);
  header = { ok: true, length: out.byteLength };
  body = new Uint8Array(out);
} catch (err) {
  header = { ok: false, ...describeConversionFailure(err) };
}
const head = new TextEncoder().encode(
  `${REPLY_MARKER}${JSON.stringify(header)}\n`,
);
const reply = new Uint8Array(head.byteLength + body.byteLength);
reply.set(head, 0);
reply.set(body, head.byteLength);
await Bun.write(Bun.stdout, reply);
process.exit(0);
