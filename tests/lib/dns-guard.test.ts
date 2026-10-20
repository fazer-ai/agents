import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { failOnRefusedLookups } from "@/../tests/dns-guard";
import { assertSafeOutboundUrl } from "@/lib/ssrf";

// The preload that keeps the suite off the real resolver. `allowPrivate: false` puts the outbound
// guard on its resolving path whatever the checkout's NODE_ENV, the way CI runs it.
const resolving = { allowPrivate: false };

describe("the suite's DNS guard", () => {
  test("a reserved name answers not-found at once, as the resolver would, and fails no test", async () => {
    await expect(
      assertSafeOutboundUrl("https://chat.gone.example/x", resolving),
    ).rejects.toThrow(/did not resolve \(ENOTFOUND\)/);
    expect(() => failOnRefusedLookups()).not.toThrow();
  });

  test("the product's fixed Google origin resolves to a public address", async () => {
    const url = await assertSafeOutboundUrl(
      "https://www.googleapis.com/calendar/v3/x",
      resolving,
    );
    expect(url.hostname).toBe("www.googleapis.com");
    expect(() => failOnRefusedLookups()).not.toThrow();
  });

  test("localhost still resolves for real, and the guard refuses it as loopback", async () => {
    await expect(
      assertSafeOutboundUrl("https://localhost/x", resolving),
    ).rejects.toThrow(/blocked/);
    expect(() => failOnRefusedLookups()).not.toThrow();
  });

  test("any other name is refused, and the test that asked fails even when the error was swallowed", async () => {
    await assertSafeOutboundUrl("https://chat.example.com/x", resolving).catch(
      () => {},
    );
    expect(() => failOnRefusedLookups()).toThrow(
      /asked the real resolver for chat\.example\.com/,
    );
    // Reported once: the next test starts clean.
    expect(() => failOnRefusedLookups()).not.toThrow();
  });

  // The check above, as the runner applies it: only a real `bun test` sees whether the preload
  // registered it, and a test that swallowed the refusal would otherwise pass.
  test("a run whose test swallowed the refusal fails, naming the host", async () => {
    const file = fileURLToPath(
      new URL("../utils/dns-guard-swallowed.ts", import.meta.url),
    );
    const proc = Bun.spawn(["bun", "test", file], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { ...process.env, ALLOW_NO_DB: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(code).not.toBe(0);
    expect(`${out}\n${err}`).toContain(
      "asked the real resolver for chat.example.com",
    );
  }, 60_000);
});
