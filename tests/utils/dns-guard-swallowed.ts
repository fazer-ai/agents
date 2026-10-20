import { test } from "bun:test";
import { assertSafeOutboundUrl } from "@/lib/ssrf";

// The target of the subprocess run in tests/lib/dns-guard.test.ts: a test that reaches the real
// resolver and swallows the error, the way a turn or a delivery does. It passes on its own; only the
// guard's afterEach can fail it.
test("a lookup whose error the code swallows", async () => {
  await assertSafeOutboundUrl("https://chat.example.com/x", {
    allowPrivate: false,
  }).catch(() => {});
});
