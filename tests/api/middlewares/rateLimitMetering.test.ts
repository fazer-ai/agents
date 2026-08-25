import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { clientKeyFor, rateLimitMiddleware } from "@/api/middlewares/rateLimit";
import app from "@/app";
import { AppError, ForbiddenError, NotFoundError } from "@/lib/errors";

// What a REJECTED request costs. Separate from rateLimit.test.ts, which is about who a bucket
// belongs to: this file is about whether the bucket is charged at all.
//
// It goes through the REAL app rather than a rebuilt one, because the thing under test is the
// REGISTRATION ORDER in src/app.ts. `elysia-rate-limit` counts in `onBeforeHandle`, which a request
// rejected before the handler never reaches, so the plugin charges those from its own `onError`.
// Elysia stops at the first error handler that RETURNS a value, so an app-level `onError` registered
// before the limiters silences that branch. A test that built its own app would pin its own ordering
// and pass either way.
const nativeGlobals = globalThis as unknown as { BunResponse: typeof Response };
const BunResponse = nativeGlobals.BunResponse;
const happyResponse = globalThis.Response;

interface ListeningApp {
  server: { port: number; stop(force: boolean): void };
}

let base = "";
let server: ListeningApp["server"] | undefined;

beforeAll(() => {
  (globalThis as { Response: typeof Response }).Response = BunResponse;
  // NOTE: registered on the REAL app, so the hooks it exercises are the ones src/app.ts installed,
  // in the order it installed them. There is no unauthenticated route in the app that throws a
  // 404 to borrow for this, and rebuilding an equivalent app would pin the test's own ordering
  // instead of the app's. It mutates the exported singleton, which several files now do; the
  // `listen` below rebuilds the route table, which is what keeps a route registered after another
  // file has already served a request from being silently dropped (see refusal-wire.test.ts).
  app.get("/__metering/thrown-404", () => {
    throw new NotFoundError("gone");
  });
  const listening = app.listen(0) as unknown as ListeningApp;
  if (!listening.server?.port) throw new Error("Failed to start the app");
  server = listening.server;
  base = `http://localhost:${listening.server.port}`;
});

afterAll(() => {
  server?.stop(true);
  (globalThis as { Response: typeof Response }).Response = happyResponse;
});

// The global limiter is one instance for the whole process and every request here resolves to the
// same key, so absolute numbers drift as the file runs. Each case measures the DELTA it caused,
// reading the budget from a request whose cost is known to be 1.
const remaining = async (): Promise<number> => {
  const res = await Bun.fetch(`${base}/api/health`);
  const header = res.headers.get("ratelimit-remaining");
  if (header === null)
    throw new Error("the health check carried no budget header");
  return Number(header);
};

// `cost` = what the request under test spent, with the two probe requests' own cost removed.
const costOf = async (send: () => Promise<Response>): Promise<number> => {
  const before = await remaining();
  await send();
  const after = await remaining();
  return before - after - 1;
};

const send = (method: string, path: string, init: RequestInit = {}) =>
  Bun.fetch(`${base}${path}`, { method, ...init });

const json = (body: string): RequestInit => ({
  headers: { "content-type": "application/json" },
  body,
});

describe("rate-limit metering (what a rejected request costs)", () => {
  // The regression this pins. Before the reorder these came back 404 with no `RateLimit-*` header
  // and no budget spent, so anyone could hold a connection open against missing paths for free.
  test("a route that does not exist is charged", async () => {
    expect(await costOf(() => send("POST", "/api/nope"))).toBe(1);
    expect(await costOf(() => send("POST", "/nope/at/all"))).toBe(1);
  });

  // This one was already metered before the change, and only by accident: the `.get("/api/*")` guard
  // in src/app.ts turns an unknown GET into a MATCHED route, which the normal counting hook sees.
  // Asserted so the gap cannot silently come back if that guard is ever removed.
  test("an unknown GET under /api is charged too", async () => {
    expect(await costOf(() => send("GET", "/api/nope"))).toBe(1);
  });

  // A body that is not JSON (PARSE) and a body that fails the route schema (VALIDATION) are both
  // rejected before the handler. On 4.6.2 the plugin REFUNDED these: measured against this app,
  // three requests took the budget from 599 to 597, five malformed POSTs carried no header, and the
  // next legitimate request reported 601, above where it started. Sending garbage refilled the
  // bucket, so the ceiling was not a ceiling for anyone willing to interleave it.
  test("a malformed body is charged, and never refunds", async () => {
    expect(
      await costOf(() =>
        send("POST", "/api/auth/login", json("{ not json at all")),
      ),
    ).toBe(1);
    expect(
      await costOf(() =>
        send("POST", "/api/auth/login", json(JSON.stringify({ nope: 1 }))),
      ),
    ).toBe(1);
  });

  // The complement, and the reason `countFailedRequest: true` is not optional once `onError` moved
  // behind the limiters: from that position the plugin sees every thrown error first, and its
  // default is to REFUND anything outside the codes it charges. A rejected login would have cost
  // nothing at all.
  test("an unauthenticated request is charged", async () => {
    expect(await costOf(() => send("GET", "/api/v1/agents"))).toBe(1);
  });

  // The regression test for the SPLIT in src/app.ts, run against src/app.ts. A matched route that
  // throws a 404 is charged on the way in by the counting hook; if the AppError handler were
  // registered behind the limiters instead of ahead of them, the plugin would see the error first,
  // read `statusCode: 404`, take it for a route that never existed, and charge a second time. This
  // reads 2 the moment that ordering is undone. What a second charge DOES at the ceiling is pinned
  // separately below, on a probe small enough to reach the ceiling.
  test("a matched route that throws a 404 is charged once, not twice", async () => {
    // NOTE: the status is asserted before the cost, because the cost alone cannot tell this case
    // from the case where the probe route is not there at all. It is registered on the shared app
    // singleton in beforeAll, and credentialRateLimit.test.ts runs earlier in the SAME process and
    // has already called `listen()` on it, so the route is added to a compiled app. Elysia routes it
    // anyway, measured alone and under the full suite, but if that ever changed the request would
    // fall through to the SPA catch-all, spend exactly the same 1, and leave this test green while
    // it stopped testing a matched route entirely.
    const answered = await send("GET", "/__metering/thrown-404");
    expect(answered.status).toBe(404);
    expect(await answered.json()).toEqual({ error: "gone" });
    expect(await costOf(() => send("GET", "/__metering/thrown-404"))).toBe(1);
  });
});

// A matched route that THROWS a 404 is the case the split in src/app.ts exists for. The counting
// hook charges it on the way in, and the plugin's `onError` cannot tell "never counted" from
// "counted, then threw": it reads `error.status ?? error.statusCode`, so our NotFoundError looks
// exactly like a route that never existed. Charging it twice is not just an overcharge: at the
// ceiling the second charge is REJECTED, and the limiter answers 429 from its own hook without ever
// reaching the app's error handler, so a request that was inside its budget gets a rate-limit error
// where the API contract says 404. Both halves are pinned here, the cost and the status.
describe("a thrown 404 on a matched route", () => {
  // Mirrors src/app.ts: the AppError handler BEFORE the limiter, everything else after.
  const serveWithAppOrdering = (max: number) => {
    const probe = new Elysia()
      .onError(({ error, set }) => {
        if (!(error instanceof AppError)) return;
        set.status = error.statusCode;
        return Response.json(
          { error: error.message },
          { status: error.statusCode },
        );
      })
      .use(rateLimitMiddleware(max, clientKeyFor(false, 1)))
      .onError(({ code }) => {
        if (code === "NOT_FOUND") return new Response("nope", { status: 404 });
      })
      .get("/ok", () => "ok")
      .get("/missing", () => {
        throw new NotFoundError("gone");
      })
      .get("/forbidden", () => {
        throw new ForbiddenError("no");
      });
    const listening = probe.listen(0) as unknown as ListeningApp;
    if (!listening.server?.port) throw new Error("Failed to start the probe");
    return listening.server;
  };

  test("costs exactly one, like any other matched route", async () => {
    const probe = serveWithAppOrdering(20);
    const rem = async (path: string) => {
      const res = await Bun.fetch(`http://localhost:${probe.port}${path}`);
      return Number(res.headers.get("ratelimit-remaining"));
    };
    try {
      const start = await rem("/ok");
      const afterMissing = await rem("/missing");
      const afterForbidden = await rem("/forbidden");
      expect(start - afterMissing).toBe(1);
      expect(afterMissing - afterForbidden).toBe(1);
    } finally {
      probe.stop(true);
    }
  });

  // The half that made this worth fixing rather than documenting. With one request of budget left
  // the double charge crossed the ceiling: measured at 429, carrying the rate-limit body, on a
  // request the limiter had just admitted.
  test("still answers 404 on the last request of the budget", async () => {
    const probe = serveWithAppOrdering(4);
    const get = (path: string) =>
      Bun.fetch(`http://localhost:${probe.port}${path}`);
    try {
      for (let i = 0; i < 3; i++) expect((await get("/ok")).status).toBe(200);
      const last = await get("/missing");
      expect(last.status).toBe(404);
      expect(await last.json()).toEqual({ error: "gone" });
    } finally {
      probe.stop(true);
    }
  });

  // And the ceiling still bites on the request after it: charged once is charged, not waived.
  test("the budget is still spent, so the next request is rejected", async () => {
    const probe = serveWithAppOrdering(4);
    const get = (path: string) =>
      Bun.fetch(`http://localhost:${probe.port}${path}`);
    try {
      for (let i = 0; i < 3; i++) await get("/ok");
      await get("/missing");
      expect((await get("/ok")).status).toBe(429);
    } finally {
      probe.stop(true);
    }
  });
});
