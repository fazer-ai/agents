// A conversion process that answers with the names of the variables it can see, as a refusal.
import { REPLY_MARKER } from "@/modules/vision/convert";

await Bun.stdin.arrayBuffer();
const message = JSON.stringify(Object.keys(process.env).sort());
await Bun.write(
  Bun.stdout,
  `${REPLY_MARKER}${JSON.stringify({ ok: false, kind: "conversion", message })}\n`,
);
process.exit(0);
