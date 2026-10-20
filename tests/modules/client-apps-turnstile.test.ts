import { describe, expect, test } from "bun:test";
import {
  TURNSTILE_VERIFY_URL,
  verifyTurnstile,
} from "@/modules/client-apps/turnstile";

// Redeeming a Turnstile token against Cloudflare, with the network replaced. The check fails CLOSED:
// only Cloudflare's explicit `success: true` lets a new anonymous session through, and an error,
// an outage or an answer that does not parse refuses it.

function answering(res: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; form: URLSearchParams }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      form: new URLSearchParams(init.body as URLSearchParams),
    });
    return res();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("verifyTurnstile", () => {
  test("sends the secret, the token and the address, and passes on success", async () => {
    const { calls, fetchImpl } = answering(() =>
      Response.json({ success: true }),
    );
    expect(await verifyTurnstile("seg", "tok", "203.0.113.9", fetchImpl)).toBe(
      true,
    );
    expect(calls.map((c) => [c.url, Object.fromEntries(c.form)])).toEqual([
      [
        TURNSTILE_VERIFY_URL,
        { secret: "seg", response: "tok", remoteip: "203.0.113.9" },
      ],
    ]);
  });

  test("no address, no remoteip", async () => {
    const { calls, fetchImpl } = answering(() =>
      Response.json({ success: true }),
    );
    await verifyTurnstile("seg", "tok", null, fetchImpl);
    expect(calls[0]?.form.has("remoteip")).toBe(false);
  });

  test("refuses whatever is not an explicit success", async () => {
    const cases: Array<() => Response | Promise<Response>> = [
      () =>
        Response.json({
          success: false,
          "error-codes": ["invalid-input-response"],
        }),
      () => Response.json({ success: "true" }),
      () => Response.json({ success: true }, { status: 500 }),
      () => new Response("<html>", { status: 200 }),
      () => Promise.reject(new TypeError("fetch failed")),
    ];
    const results = [];
    for (const c of cases)
      results.push(
        await verifyTurnstile("seg", "tok", null, answering(c).fetchImpl),
      );
    expect(results).toEqual([false, false, false, false, false]);
  });
});
