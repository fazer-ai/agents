import { afterEach, expect, test } from "bun:test";
import { revokeGoogleToken } from "@/modules/vault/google-oauth";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

test("a revoke whose body never ends does not hold the disconnect", async () => {
  // Nothing reads Google's answer here, and the disconnect controller AWAITS this call before
  // removing the local tokens, so draining the body only adds latency: a provider that answers its
  // headers and then stalls would hold a user-facing disconnect for the whole 10s budget.
  const seen = { cancelled: false };
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        pull(c) {
          c.enqueue(new TextEncoder().encode("x".repeat(1024)));
        },
        cancel() {
          seen.cancelled = true;
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;

  const startedAt = Date.now();
  await revokeGoogleToken("refresh-token");
  // The bound is ten seconds; this comes back at once.
  expect(Date.now() - startedAt).toBeLessThan(1_000);
  expect(seen.cancelled).toBe(true);
}, 20_000);

test("a revoke that fails is still swallowed", async () => {
  // The fence on the other side: disconnect must proceed whatever Google says, and the no-body call
  // must not have turned a network failure into a throw.
  const asked: Array<[string, string]> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push([String(input), String(init?.body ?? "")]);
    throw new Error("connection refused");
  }) as unknown as typeof fetch;
  await expect(revokeGoogleToken("refresh-token")).resolves.toBeUndefined();
  // The revoke was attempted, for this token, before the failure was swallowed.
  expect(asked).toEqual([
    ["https://oauth2.googleapis.com/revoke", "token=refresh-token"],
  ]);
});
