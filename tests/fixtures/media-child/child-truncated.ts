// A conversion process that announces a JPEG and dies partway through writing it.
import { REPLY_MARKER } from "@/modules/vision/convert";

await Bun.stdin.arrayBuffer();
await Bun.write(
  Bun.stdout,
  `${REPLY_MARKER}${JSON.stringify({ ok: true, length: 100 })}\n0123456789`,
);
process.exit(0);
