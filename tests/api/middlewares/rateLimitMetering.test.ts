import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { clientKeyFor, rateLimitMiddleware } from "@/api/middlewares/rateLimit";
import { buildApp } from "@/app";
import { AppError, ForbiddenError, NotFoundError } from "@/lib/errors";

// What a REJECTED request costs (rateLimit.test.ts covers who a bucket belongs to). It runs the
// real app because the subject is the hook REGISTRATION ORDER in src/app.ts: the plugin charges
// pre-handler rejections from its own `onError`, and Elysia stops at the first error handler that
// returns a value. A hand-built app would pin its own ordering and pass either way.
const nativeGlobals = globalThis as unknown as { BunResponse: typeof Response };
const BunResponse = nativeGlobals.BunResponse;
const happyResponse = globalThis.Response;

interface ListeningApp {
  server: { port: number; stop(force: boolean): void };
}

let base = "";
let server: ListeningApp["server"] | undefined;

beforeAll(async () => {
  (globalThis as { Response: typeof Response }).Response = BunResponse;
  // NOTE: `buildApp()` installs the same hooks in the same order as src/app.ts's default export.
  // A fresh instance, not the singleton: a route plus a `listen` on the shared export leaks into
  // every later file, whose `handle()` calls then answer 500.
  const app = await buildApp();
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
  // An unmetered 404 would let anyone hold a connection open against missing paths for free.
  test("a route that does not exist is charged", async () => {
    expect(await costOf(() => send("POST", "/api/nope"))).toBe(1);
    expect(await costOf(() => send("POST", "/nope/at/all"))).toBe(1);
  });

  // The `.get("/api/*")` guard in src/app.ts turns an unknown GET into a MATCHED route, so the
  // normal counting hook sees it. Asserted so metering survives that guard's removal.
  test("an unknown GET under /api is charged too", async () => {
    expect(await costOf(() => send("GET", "/api/nope"))).toBe(1);
  });

  // PARSE and VALIDATION failures are rejected before the handler. The plugin's default is to
  // REFUND them, which lets interleaved garbage refill the bucket past its ceiling.
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

  // Why `countFailedRequest: true` is required with `onError` behind the limiters: the plugin sees
  // every thrown error first and by default REFUNDS anything outside the codes it charges, so a
  // rejected login would cost nothing.
  test("an unauthenticated request is charged", async () => {
    expect(await costOf(() => send("GET", "/api/v1/agents"))).toBe(1);
  });

  // Pins the handler SPLIT in src/app.ts: with the AppError handler behind the limiters, the plugin
  // reads `statusCode: 404` as a route that never existed and charges a second time, so this reads 2.
  // The effect at the ceiling is pinned below.
  test("a matched route that throws a 404 is charged once, not twice", async () => {
    // NOTE: status first, because a fall-through to the SPA catch-all also costs 1 and would keep
    // this green without a matched route. The probe is registered on this file's own app before any
    // request compiles it.
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

  // With one request of budget left, a double charge crosses the ceiling and answers 429 on a
  // request the limiter just admitted.
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
