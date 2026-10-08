import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  clientKeyFor,
  isWebhookReceiver,
  rateLimitMiddleware,
  webhookAuthFailureLimitMiddleware,
} from "@/api/middlewares/rateLimit";

// Same harness as rateLimit.test.ts: the limiters key on the peer, which only a LISTENING server
// gives them, and Bun.serve needs Bun's own Response back for the duration of the file.
const nativeGlobals = globalThis as unknown as { BunResponse: typeof Response };
const BunResponse = nativeGlobals.BunResponse;
const happyResponse = globalThis.Response;

interface ListeningApp {
  server: { port: number; stop(force: boolean): void };
}
const servers: ListeningApp["server"][] = [];

beforeAll(() => {
  (globalThis as { Response: typeof Response }).Response = BunResponse;
});
afterAll(() => {
  for (const server of servers) server.stop(true);
  (globalThis as { Response: typeof Response }).Response = happyResponse;
});

// A gate a test opens to finish the requests it holds in flight (tokens starting with "held").
let held = Promise.withResolvers<void>();
let heldOnce = false;
const heldGood = new Set<string>();

// Both receivers answer the way the real ones do: 200 for a token they know, 401 for any other
// (the real ones throw UnauthorizedError, whose handler writes the same status).
const serve = (opts: {
  globalMax: number;
  failureMax: number;
  now?: () => number;
  waitMs?: number;
  maxWaiting?: number;
}) => {
  const key = clientKeyFor(false, 1);
  const receiver = async ({
    params,
    set,
  }: {
    params: { token: string };
    set: { status?: number | string };
  }) => {
    // The first attempt on each "good-slow" token waits for the gate; its repeats do not.
    if (params.token.startsWith("good-slow") && !heldGood.has(params.token)) {
      heldGood.add(params.token);
      await held.promise;
    }
    if (params.token.startsWith("good")) return { ack: true };
    // Only the first attempt on a held token waits; the repeats fail at once.
    if (params.token.startsWith("held") && !heldOnce) {
      heldOnce = true;
      await held.promise;
    }
    // Authenticated, and the body was malformed: the caller's bug, not a guess.
    if (params.token.startsWith("malformed")) {
      set.status = 400;
      return { error: "invalid JSON body" };
    }
    set.status = 401;
    return { error: "unauthorized" };
  };
  const app = new Elysia()
    .use(rateLimitMiddleware(opts.globalMax, key))
    .use(
      webhookAuthFailureLimitMiddleware(
        opts.failureMax,
        key,
        opts.now,
        opts.waitMs,
        opts.maxWaiting,
      ),
    )
    .get("/api/x", () => "x")
    .post("/api/v1/chatwoot/webhook/:token", receiver)
    .post("/api/v1/integrations/inbound/:token", receiver);
  const listening = app.listen(0) as unknown as ListeningApp;
  if (!listening.server?.port) throw new Error("Failed to start test server");
  servers.push(listening.server);
  const base = `http://localhost:${listening.server.port}`;
  return {
    post: async (path: string) =>
      (await Bun.fetch(`${base}${path}`, { method: "POST", body: "{}" }))
        .status,
    get: async (path: string) => (await Bun.fetch(`${base}${path}`)).status,
  };
};

const req = (method: string, path: string) =>
  new Request(`http://localhost${path}`, { method });

describe("which requests are webhook deliveries", () => {
  test("a POST with one token segment under either receiver, slashed or not", () => {
    expect(isWebhookReceiver(req("POST", "/api/v1/chatwoot/webhook/abc"))).toBe(
      true,
    );
    expect(
      isWebhookReceiver(req("POST", "/api/v1/chatwoot/webhook/abc/")),
    ).toBe(true);
    expect(
      isWebhookReceiver(req("POST", "/api/v1/integrations/inbound/abc")),
    ).toBe(true);
  });

  test("anything that routes nowhere stays on the global budget", () => {
    expect(isWebhookReceiver(req("GET", "/api/v1/chatwoot/webhook/abc"))).toBe(
      false,
    );
    expect(isWebhookReceiver(req("POST", "/api/v1/chatwoot/webhook"))).toBe(
      false,
    );
    expect(isWebhookReceiver(req("POST", "/api/v1/chatwoot/webhook/"))).toBe(
      false,
    );
    expect(isWebhookReceiver(req("POST", "/api/v1/chatwoot/webhook/a/b"))).toBe(
      false,
    );
    expect(
      isWebhookReceiver(req("POST", "/api/v1/chatwoot/webhookx/abc")),
    ).toBe(false);
    expect(isWebhookReceiver(req("POST", "/api/v1/integrations/abc"))).toBe(
      false,
    );
    // The router refuses these before any hook of the receivers' own limiter runs.
    expect(isWebhookReceiver(req("POST", "/api/v1/chatwoot/webhook/%"))).toBe(
      false,
    );
    expect(
      isWebhookReceiver(req("POST", "/api/v1/integrations/inbound/%zz")),
    ).toBe(false);
  });
});

describe("a sender's volume is never refused", () => {
  test("deliveries past the global budget all land, and do not spend it", async () => {
    const app = serve({ globalMax: 2, failureMax: 2 });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push(await app.post("/api/v1/chatwoot/webhook/good-bot"));
      statuses.push(await app.post("/api/v1/integrations/inbound/good-int"));
    }
    expect(statuses).toEqual(Array(12).fill(200));
    // The same address still has its whole budget for everything else, and it still bites.
    expect([
      await app.get("/api/x"),
      await app.get("/api/x"),
      await app.get("/api/x"),
    ]).toEqual([200, 200, 429]);
  });
});

describe("guessing tokens is", () => {
  test("refused past the ceiling of 401s, for routes this address was never accepted on", async () => {
    const app = serve({ globalMax: 1000, failureMax: 2 });
    expect(await app.post("/api/v1/chatwoot/webhook/good-bot")).toBe(200);
    expect([
      await app.post("/api/v1/chatwoot/webhook/guess-1"),
      await app.post("/api/v1/chatwoot/webhook/guess-2"),
      await app.post("/api/v1/chatwoot/webhook/guess-3"),
      await app.post("/api/v1/integrations/inbound/guess-4"),
    ]).toEqual([401, 401, 429, 429]);
    // A token this address never got through on is refused too: it is indistinguishable from a guess.
    expect(await app.post("/api/v1/chatwoot/webhook/good-new")).toBe(429);
    // The bot it was already delivering to keeps landing, at any volume.
    const kept: number[] = [];
    for (let i = 0; i < 5; i++) {
      kept.push(await app.post("/api/v1/chatwoot/webhook/good-bot"));
    }
    expect(kept).toEqual(Array(5).fill(200));
  });

  test("bounded for a burst sent all at once, before any of it has failed", async () => {
    const app = serve({ globalMax: 1000, failureMax: 5 });
    const statuses = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        app.post(`/api/v1/chatwoot/webhook/guess-${i}`),
      ),
    );
    expect(statuses.filter((s) => s === 401).length).toBe(5);
    expect(statuses.filter((s) => s === 429).length).toBe(25);
  });

  test("tried one at a time when the same unknown token is repeated all at once", async () => {
    const app = serve({ globalMax: 1000, failureMax: 2 });
    const statuses = await Promise.all(
      Array.from({ length: 30 }, () =>
        app.post("/api/v1/integrations/inbound/guess-same"),
      ),
    );
    expect(statuses.filter((s) => s === 401).length).toBe(2);
    expect(statuses.filter((s) => s === 429).length).toBe(28);
  });

  test("not escaped by keeping one attempt on a route in flight", async () => {
    held = Promise.withResolvers<void>();
    heldOnce = false;
    const app = serve({ globalMax: 1000, failureMax: 2, waitMs: 100 });
    const slow = app.post("/api/v1/chatwoot/webhook/held-token");
    await Bun.sleep(20);
    // Its repeats wait for the held attempt's answer, and give up with 429 when it does not come.
    expect([
      await app.post("/api/v1/chatwoot/webhook/held-token"),
      await app.post("/api/v1/chatwoot/webhook/guess-1"),
    ]).toEqual([429, 401]);
    held.resolve();
    expect(await slow).toBe(401);
    // Two confirmed failures now: the held route is closed like any other.
    expect(await app.post("/api/v1/chatwoot/webhook/held-token")).toBe(429);
  });

  test("not refusing a real sender's burst whose first delivery is slow", async () => {
    held = Promise.withResolvers<void>();
    const app = serve({ globalMax: 1000, failureMax: 2, waitMs: 400 });
    const first = app.post("/api/v1/chatwoot/webhook/good-slow");
    await Bun.sleep(20);
    const repeats = Array.from({ length: 2 }, () =>
      app.post("/api/v1/chatwoot/webhook/good-slow"),
    );
    await Bun.sleep(150);
    held.resolve();
    expect([await first, ...(await Promise.all(repeats))]).toEqual([
      200, 200, 200,
    ]);
  });

  test("bounding how many repeats wait on an attempt in flight", async () => {
    const app = serve({
      globalMax: 1000,
      failureMax: 3,
      waitMs: 2_000,
      maxWaiting: 3,
    });
    const batch = async (token: string) => {
      held = Promise.withResolvers<void>();
      const first = app.post(`/api/v1/chatwoot/webhook/${token}`);
      await Bun.sleep(20);
      const repeats = Array.from({ length: 10 }, () =>
        app.post(`/api/v1/chatwoot/webhook/${token}`),
      );
      await Bun.sleep(100);
      held.resolve();
      return [await first, ...(await Promise.all(repeats))];
    };
    // Three wait and land once the first is accepted; the other seven are refused without waiting.
    const one = await batch("good-slow-a");
    expect(one.filter((s) => s === 200).length).toBe(4);
    expect(one.filter((s) => s === 429).length).toBe(7);
    // The waiting room empties when they leave, so the next token gets the same three.
    const two = await batch("good-slow-b");
    expect(two.filter((s) => s === 200).length).toBe(4);
  });

  test("not confused with a real sender's burst, even before any of it is accepted", async () => {
    // A fresh process has accepted nothing yet; a sender's burst repeats its few tokens, here as many
    // as the ceiling, so every slot is taken while the repeats keep arriving.
    const app = serve({ globalMax: 1000, failureMax: 3 });
    const statuses = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        app.post(`/api/v1/chatwoot/webhook/good-bot-${i % 3}`),
      ),
    );
    expect(statuses).toEqual(Array(30).fill(200));
  });

  test("refunded for a first delivery that turns out to be accepted", async () => {
    const app = serve({ globalMax: 1000, failureMax: 1 });
    expect(await app.post("/api/v1/chatwoot/webhook/good-first")).toBe(200);
    expect(await app.post("/api/v1/chatwoot/webhook/good-second")).toBe(200);
    expect(await app.post("/api/v1/chatwoot/webhook/guess-1")).toBe(401);
    expect(await app.post("/api/v1/chatwoot/webhook/guess-2")).toBe(429);
  });

  test("forgiven when the window turns", async () => {
    let clock = 1_000_000;
    const app = serve({ globalMax: 1000, failureMax: 1, now: () => clock });
    expect(await app.post("/api/v1/chatwoot/webhook/guess-1")).toBe(401);
    expect(await app.post("/api/v1/chatwoot/webhook/guess-2")).toBe(429);
    clock += 60_001;
    expect(await app.post("/api/v1/chatwoot/webhook/guess-3")).toBe(401);
  });

  test("not charged for a delivery refused for any reason but authentication", async () => {
    const app = serve({ globalMax: 1000, failureMax: 1 });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push(await app.post("/api/v1/chatwoot/webhook/malformed-body"));
    }
    expect(statuses).toEqual([400, 400, 400]);
    expect(await app.post("/api/v1/chatwoot/webhook/guess-1")).toBe(401);
  });

  test("not charged for a delivery that was accepted", async () => {
    const app = serve({ globalMax: 1000, failureMax: 1 });
    for (let i = 0; i < 5; i++) {
      expect(await app.post("/api/v1/chatwoot/webhook/good-bot")).toBe(200);
    }
    expect(await app.post("/api/v1/chatwoot/webhook/guess-1")).toBe(401);
  });
});

// The exemption through the REAL app, whose limiters are registered in src/app.ts's own order. The
// receivers answer 500 here (the suite gives the default client no database), which changes nothing
// about what they cost: the global limiter decides before the handler runs.
describe("through the real app", () => {
  let base = "";
  beforeAll(async () => {
    const { buildApp } = await import("@/app");
    const app = await buildApp();
    const listening = app.listen(0) as unknown as ListeningApp;
    if (!listening.server?.port) throw new Error("Failed to start the app");
    servers.push(listening.server);
    base = `http://localhost:${listening.server.port}`;
  });

  const remaining = async (): Promise<number> => {
    const res = await Bun.fetch(`${base}/api/health`);
    return Number(res.headers.get("ratelimit-remaining"));
  };

  test("a webhook delivery costs the address none of its global budget", async () => {
    const before = await remaining();
    for (const path of [
      "/api/v1/chatwoot/webhook/tok-a",
      "/api/v1/integrations/inbound/tok-b",
    ]) {
      const res = await Bun.fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).not.toBe(429);
    }
    // One for the probe itself.
    expect(before - (await remaining())).toBe(1);
  });

  test("a token the router cannot decode is charged to the global budget", async () => {
    const before = await remaining();
    const res = await Bun.fetch(`${base}/api/v1/chatwoot/webhook/%zz`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).not.toBe(200);
    // The refusal plus the probe.
    expect(before - (await remaining())).toBe(2);
  });
});
