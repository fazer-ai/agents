import { describe, expect, test } from "bun:test";
import {
  fetchBounded,
  MAX_OUTBOUND_BODY_CHARS,
  OutboundTimeoutError,
  readCappedBody,
  readCappedBytes,
} from "@/lib/outbound";

const enc = new TextEncoder();

function streamed(
  chunks: Uint8Array[],
  opts: { status?: number; stall?: boolean } = {},
): Response {
  return new Response(
    new ReadableStream({
      start(c) {
        for (const chunk of chunks) c.enqueue(chunk);
        if (!opts.stall) c.close();
      },
    }),
    { status: opts.status ?? 200 },
  );
}

describe("readCappedBody", () => {
  test("keeps the prefix and counts the whole response", async () => {
    const chunk = enc.encode("y".repeat(1000));
    const got = await readCappedBody(streamed(Array(10).fill(chunk)), 2_500);
    expect(got.text.length).toBe(2_500);
    // The count is the WHOLE body, not what was kept: "your provider answered with ten thousand
    // characters" is a sentence only the count can say.
    expect(got.chars).toBe(10_000);
  });

  test("a response under the cap comes back whole", async () => {
    const body = JSON.stringify({ a: "x".repeat(100) });
    const got = await readCappedBody(streamed([enc.encode(body)]), 1_000);
    expect(got.text).toBe(body);
    expect(got.chars).toBe(body.length);
  });

  test("a multi-byte character split across two chunks is not corrupted", async () => {
    // "é" is two bytes; a chunk boundary between them would land a replacement character in the
    // middle of the body a response template is read against.
    const bytes = enc.encode('{"nome":"José"}');
    const at = bytes.indexOf(0xc3) + 1;
    const got = await readCappedBody(
      streamed([bytes.slice(0, at), bytes.slice(at)]),
      1_000,
    );
    expect(got.text).toBe('{"nome":"José"}');
  });

  test("a cap landing between the halves of an astral character drops the orphan", async () => {
    // A JS string is UTF-16 code units. Cutting at 10 units of `aaaaaaaaa😀` lands between the two
    // halves of the emoji, and the lone surrogate that leaves is refused outright by Postgres and
    // renders as a replacement character everywhere else.
    const body = `${"a".repeat(9)}\u{1F600}`;
    const got = await readCappedBody(streamed([enc.encode(body)]), 10);
    expect(got.text).toBe("a".repeat(9));
    expect(got.chars).toBe(11);
  });

  test("a stream that ends mid-character does not drop the partial byte", async () => {
    // The provider closed in the middle of a two-byte character. The streaming decoder holds that
    // byte back waiting for its partner; the final flush is what turns it into a replacement
    // character instead of letting it vanish, which is the difference between a body that LOOKS
    // complete and one that says it was cut.
    const bytes = enc.encode('{"nome":"José"}');
    const at = bytes.indexOf(0xc3) + 1;
    const got = await readCappedBody(streamed([bytes.slice(0, at)]), 1_000);
    expect(got.text).toBe('{"nome":"Jos\uFFFD');
    expect(got.chars).toBe(got.text.length);
  });

  test("a response with no body at all is empty rather than a throw", async () => {
    const got = await readCappedBody(new Response(null, { status: 204 }), 100);
    expect(got).toEqual({ text: "", chars: 0 });
  });

  test("the default cap is the module's constant", async () => {
    // A caller that names no cap must not get an unbounded read, which is the defect this module
    // exists to close.
    const chunk = enc.encode("z".repeat(1000));
    const got = await readCappedBody(streamed(Array(3).fill(chunk)));
    expect(got.text.length).toBe(3_000);
    expect(MAX_OUTBOUND_BODY_CHARS).toBeGreaterThan(3_000);
  });
});

describe("readCappedBytes", () => {
  test("a download under the limit comes back byte for byte", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const got = await readCappedBytes(streamed([bytes]), 10);
    expect(got.tooLarge).toBe(false);
    expect(Array.from(got.bytes)).toEqual([1, 2, 3, 4, 5]);
  });

  test("a download exactly at the limit is not too large", async () => {
    // The off-by-one that decides whether a file at the cap is deliverable.
    const got = await readCappedBytes(streamed([new Uint8Array(64)]), 64);
    expect(got.tooLarge).toBe(false);
    expect(got.bytes.byteLength).toBe(64);
  });

  test("a download one byte over the limit is refused, and stops being read", async () => {
    // Both halves matter: refusing is the contract, and stopping is why this exists — the shape it
    // replaces buffered the whole file before deciding it was too big.
    let produced = 0;
    let cancelled = false;
    const res = new Response(
      new ReadableStream({
        pull(c) {
          produced += 1;
          c.enqueue(new Uint8Array(32));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200 },
    );
    const got = await readCappedBytes(res, 64);
    expect(got.tooLarge).toBe(true);
    expect(got.bytes.byteLength).toBe(0);
    expect(cancelled).toBe(true);
    // Three 32-byte chunks is what it takes to pass 64; an unbounded read would still be pulling.
    expect(produced).toBeLessThanOrEqual(4);
  });

  test("a response with no body at all is empty rather than a throw", async () => {
    const got = await readCappedBytes(new Response(null, { status: 204 }), 10);
    expect(got.tooLarge).toBe(false);
    expect(got.bytes.byteLength).toBe(0);
  });
});

describe("fetchBounded", () => {
  test("the bound covers the BODY, not only the headers", async () => {
    // The measured defect (#464): headers at once, body never finishes, and the call was still
    // pending at 3,002ms under a 300ms bound.
    const startedAt = Date.now();
    const err = (await fetchBounded(
      "https://8.8.8.8/x",
      {},
      {
        timeoutMs: 120,
        fetchImpl: (async (_u: string, init: RequestInit) =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(enc.encode('{"a":'));
                init.signal?.addEventListener("abort", () =>
                  c.error(new Error("aborted")),
                );
              },
            }),
            { status: 200 },
          )) as unknown as typeof fetch,
      },
    ).catch((e: unknown) => e)) as OutboundTimeoutError;
    expect(err).toBeInstanceOf(OutboundTimeoutError);
    expect(err.timeoutMs).toBe(120);
    expect(err.message).toBe("the provider did not answer within 0.12s");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  }, 10_000);

  test("and it still covers the headers", async () => {
    const err = (await fetchBounded(
      "https://8.8.8.8/x",
      {},
      {
        timeoutMs: 80,
        fetchImpl: (async (_u: string, init: RequestInit) =>
          new Promise((_r, rej) => {
            init.signal?.addEventListener("abort", () =>
              rej(new Error("aborted")),
            );
          })) as unknown as typeof fetch,
      },
    ).catch((e: unknown) => e)) as unknown;
    expect(err).toBeInstanceOf(OutboundTimeoutError);
  }, 10_000);

  test("a body that finishes inside the bound comes back whole", async () => {
    const { res, body } = await fetchBounded(
      "https://8.8.8.8/x",
      {},
      {
        timeoutMs: 2_000,
        fetchImpl: (async () =>
          new Response('{"a":1}', {
            status: 201,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch,
      },
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(body.text).toBe('{"a":1}');
  });

  test("a failure that is not ours is not relabelled as a timeout", async () => {
    // A refused connection, a TLS failure, a DNS miss: the message is the only thing that says what
    // to do next, and wrapping every one of them in our sentence would take that away.
    const err = (await fetchBounded(
      "https://8.8.8.8/x",
      {},
      {
        timeoutMs: 5_000,
        fetchImpl: (async () => {
          throw new Error("connection refused");
        }) as unknown as typeof fetch,
      },
    ).catch((e: unknown) => e)) as Error;
    expect(err).not.toBeInstanceOf(OutboundTimeoutError);
    expect(err.message).toBe("connection refused");
  });

  test("a signal that was already aborted cancels before anything is sent", async () => {
    // `abort` fires once. A signal that fired before the listener was attached never reaches it, so
    // without an explicit check the caller's cancellation is simply ignored and the request goes
    // out — the one case where relaying by listener alone is not enough.
    const seen: { aborted?: boolean } = {};
    await fetchBounded(
      "https://8.8.8.8/x",
      { signal: AbortSignal.abort() },
      {
        timeoutMs: 30_000,
        fetchImpl: (async (_u: string, init: RequestInit) => {
          seen.aborted = (init.signal as AbortSignal).aborted;
          throw new Error("the caller had already cancelled");
        }) as unknown as typeof fetch,
      },
    ).catch(() => undefined);
    expect(seen.aborted).toBe(true);
  });

  test("a caller's own abort still cancels, and is not reported as our bound", async () => {
    const outer = new AbortController();
    let sawAbort = false;
    const p = fetchBounded(
      "https://8.8.8.8/x",
      { signal: outer.signal },
      {
        timeoutMs: 30_000,
        fetchImpl: (async (_u: string, init: RequestInit) =>
          new Promise((_r, rej) => {
            init.signal?.addEventListener("abort", () => {
              sawAbort = true;
              rej(new Error("aborted by caller"));
            });
          })) as unknown as typeof fetch,
      },
    ).catch((e: unknown) => e);
    outer.abort();
    const err = (await p) as Error;
    expect(sawAbort).toBe(true);
    expect(err).not.toBeInstanceOf(OutboundTimeoutError);
  }, 10_000);
});
