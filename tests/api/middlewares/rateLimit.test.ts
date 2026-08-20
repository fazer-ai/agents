import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  clientKeyFor,
  isRegisterRequest,
  rateLimitMiddleware,
  registerRateLimitMiddleware,
} from "@/api/middlewares/rateLimit";

// NOTE: tests/setup.ts captures Bun's native Response before happy-dom replaces it globally, and
// Bun.serve does not recognize the spec one. Restored for the duration of this file only, the same
// way tests/api/features/realtime does it. Requests go through `Bun.fetch` for the mirror-image
// reason: the global `fetch` is happy-dom's, which enforces the Same Origin Policy against the
// window's origin and refuses a request to a localhost port before it reaches the server.
const nativeGlobals = globalThis as unknown as { BunResponse: typeof Response };
const BunResponse = nativeGlobals.BunResponse;
const happyResponse = globalThis.Response;

// The bug this pins is only observable against a LISTENING server: `app.handle()` gives the plugin
// no `server`, so its generator sees no peer and every request in the process collapses into one key
// regardless of which generator is installed. A test built on `handle()` would pass either way.
// Each case therefore serves the REAL middleware on a real port and reads the status the client got.
interface ListeningApp {
  server: { port: number; stop(force: boolean): void };
}

const servers: ListeningApp["server"][] = [];

// `trusted` is what a deployment that declared a proxy (the bundled-Caddy and Coolify compose files)
// keys on; `false` is the shipped default, where nothing is declared and the peer wins.
// NOTE: both branches pass the key explicitly rather than letting the untrusted one fall through to
// the module default. That default reads `config.trustProxy`, so a developer with TRUST_PROXY=true
// in their own .env would have flipped the untrusted case into the trusted one and read green.
const serve = (max: number, trusted = false) => {
  const app = new Elysia()
    .use(rateLimitMiddleware(max, clientKeyFor(trusted, 1)))
    .get("/api/x", () => "x");
  const listening = app.listen(0) as unknown as ListeningApp;
  if (!listening.server?.port) throw new Error("Failed to start test server");
  servers.push(listening.server);
  return { url: `http://localhost:${listening.server.port}/api/x` };
};

beforeAll(() => {
  (globalThis as { Response: typeof Response }).Response = BunResponse;
});

afterAll(() => {
  for (const server of servers) server.stop(true);
  (globalThis as { Response: typeof Response }).Response = happyResponse;
});

describe("rate-limit keying (client address, not the socket peer)", () => {
  // The regression. Before the generator was installed the key was `server.requestIP()`, which for
  // every request behind a proxy is the proxy: three distinct clients would exhaust a max=2 bucket
  // between them and the third — never seen before — would be rejected.
  test("distinct forwarded clients do not share a bucket", async () => {
    const { url } = serve(2, true);
    const statuses: number[] = [];
    for (const client of ["203.0.113.10", "203.0.113.11", "203.0.113.12"]) {
      const res = await Bun.fetch(url, {
        headers: { "x-forwarded-for": `1.2.3.4, ${client}` },
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 200]);
  });

  // The other half: the limit still has to BITE. Same client, same bucket, budget spent.
  test("one forwarded client still exhausts its own budget", async () => {
    const { url } = serve(2, true);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await Bun.fetch(url, {
        headers: { "x-forwarded-for": "1.2.3.4, 203.0.113.20" },
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 429]);
  });

  // A client can prepend to X-Forwarded-For but never append, so rotating the leftmost entry must
  // not mint a new bucket. Reading the left — which the previous, unused helper in api/lib/clientIp
  // did — would have made every limiter opt-out by header.
  test("rotating what the client prepended does not mint a new bucket", async () => {
    const { url } = serve(2, true);
    const statuses: number[] = [];
    for (const spoofed of ["9.9.9.1", "9.9.9.2", "9.9.9.3"]) {
      const res = await Bun.fetch(url, {
        headers: { "x-forwarded-for": `${spoofed}, 203.0.113.30` },
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 429]);
  });

  // The shipped default. Nothing declared a proxy, so the forwarded chain is ignored entirely and
  // three distinct clients share the peer's bucket — a worse limit, and the deliberate trade: being
  // wrong this way over-groups, while believing an undeclared header would remove the limit for
  // whoever is trying to get around it.
  test("with no proxy declared, the chain is ignored and the peer is the key", async () => {
    const { url } = serve(2);
    const statuses: number[] = [];
    for (const client of ["203.0.113.40", "203.0.113.41", "203.0.113.42"]) {
      const res = await Bun.fetch(url, {
        headers: { "x-forwarded-for": `1.2.3.4, ${client}` },
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 429]);
  });
});

// Which requests the DCR limiter covers. The budget is 10/min because an open DCR endpoint lets
// anyone mint OAuth client rows, so a spelling that routes but escapes the limiter is the whole
// limiter: measured before the fix, 14 registrations through `/register/` under that ceiling, every
// one a 200 and none carrying a `RateLimit-*` header.
describe("the DCR limiter covers every spelling that routes", () => {
  const post = (path: string) =>
    new Request(`http://localhost${path}`, { method: "POST" });

  test("the trailing slash is the same request", () => {
    expect(isRegisterRequest(post("/api/v1/mcp/oauth/register"))).toBe(true);
    expect(isRegisterRequest(post("/api/v1/mcp/oauth/register/"))).toBe(true);
  });

  // The rest of the alias space, measured server-side with `curl --path-as-is`: every one of these
  // 404s, so covering them would only spend the registration budget on requests that never register.
  // `./` is absent on purpose: the URL parser collapses it before this sees it, so it arrives as the
  // canonical spelling and is already covered by the case above.
  test("spellings that do not route are left to the global limit", () => {
    for (const alias of [
      "//api/v1/mcp/oauth/register",
      "/api//v1/mcp/oauth/register",
      "/api/v1/mcp/oauth/register//",
      "/api/v1/mcp/oauth/regist%65r",
      "/API/v1/mcp/oauth/register",
    ]) {
      expect(isRegisterRequest(post(alias))).toBe(false);
    }
  });

  // A 404 spends whatever budget covers it, so a crawler doing GET on this path would otherwise burn
  // the registration budget for every client sharing that address. The path only exists as POST.
  test("only POST is covered, since only POST registers", () => {
    for (const method of ["GET", "PUT", "DELETE", "HEAD"]) {
      const request = new Request(
        "http://localhost/api/v1/mcp/oauth/register",
        { method },
      );
      expect(isRegisterRequest(request)).toBe(false);
    }
  });

  // End to end, through the real middleware: the two spellings share ONE bucket. Reading this as two
  // buckets, or as one that the slashed spelling never touches, is the bug.
  test("exhausting through the slashed spelling rejects the canonical one", async () => {
    const app = new Elysia()
      .use(registerRateLimitMiddleware())
      .post("/api/v1/mcp/oauth/register", () => ({ ok: true }));
    const listening = app.listen(0) as unknown as ListeningApp;
    if (!listening.server?.port) throw new Error("Failed to start test server");
    servers.push(listening.server);
    const send = (path: string) =>
      Bun.fetch(`http://localhost:${listening.server.port}${path}`, {
        method: "POST",
      });

    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      statuses.push((await send("/api/v1/mcp/oauth/register/")).status);
    }
    expect(statuses.every((status) => status === 200)).toBe(true);
    expect((await send("/api/v1/mcp/oauth/register")).status).toBe(429);
  });
});
