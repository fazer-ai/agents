import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isCredentialRequest } from "@/api/middlewares/rateLimit";
import { buildApp } from "@/app";
import {
  assertCredentialBudgetIsTighter,
  assertLimiterBudgetsAreDistinct,
  parseIntSetting,
} from "@/config";

// The credential bucket is the only throttle on a password guess: the auth path has no lockout,
// failed-attempt counter or backoff. The plugin seeds itself with `max:duration:scoping` and Elysia
// deduplicates matching plugins, so a credential limiter with the DCR limiter's (budget, window)
// would silently vanish; the tests check that BOTH buckets exist, not just that one answers.
const nativeGlobals = globalThis as unknown as { BunResponse: typeof Response };
const BunResponse = nativeGlobals.BunResponse;
const happyResponse = globalThis.Response;

interface ListeningApp {
  server: { port: number; stop(force: boolean): void };
}

let base = "";
let server: ListeningApp["server"] | undefined;

// Its own app, not the process's: `listen()` on the shared default export compiles the instance every
// other file reaches through `app.handle(...)`, `stop()` does not undo it, and later files in the
// shard then get a 500 from it (tests/api/v1/mcp-dcr.test.ts is one).
beforeAll(async () => {
  (globalThis as { Response: typeof Response }).Response = BunResponse;
  const listening = (await buildApp()).listen(0) as unknown as ListeningApp;
  if (!listening.server?.port) throw new Error("Failed to start the app");
  server = listening.server;
  base = `http://localhost:${listening.server.port}`;
});

afterAll(() => {
  server?.stop(true);
  (globalThis as { Response: typeof Response }).Response = happyResponse;
});

const post = (path: string) =>
  Bun.fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "nobody@example.com", password: "12345678" }),
  });

// Which bucket answered, read off the ceiling it advertises. The expectations are the shipped
// defaults, which tests/setup.ts pins at preload so a local `.env` cannot fake a collision. Reading
// them from `config` would lose the signal: the boot check keeps (budget, window) PAIRS distinct, so
// `RATE_LIMIT_CREDENTIAL_MAX=600` boots fine and makes both buckets advertise the same ceiling.
const ceilingOf = async (response: Response) =>
  response.headers.get("ratelimit-limit");

describe("which requests the credential bucket covers", () => {
  test("the routes where guessing is the attack", () => {
    for (const [method, path] of [
      ["POST", "/api/auth/login"],
      ["POST", "/api/auth/signup"],
      ["POST", "/api/auth/setup"],
      ["POST", "/api/auth/accept-invite"],
      // Declared `security: []`, looks the token up, and answers 200 with the invited email and
      // role when it exists. A pure oracle, and cheaper to probe than the POST that consumes it.
      ["GET", "/api/auth/invite"],
      // NOTE: Elysia dispatches HEAD to the GET handler, so this is the SAME oracle: the lookup
      // runs and the 200/404 is the answer. Listing GET alone would leave it on the global budget.
      ["HEAD", "/api/auth/invite"],
    ] as const) {
      const request = new Request(`http://localhost${path}`, { method });
      expect(isCredentialRequest(request)).toBe(true);
    }
  });

  // The same one-character bypass the DCR limiter had: Elysia routes both spellings to one handler.
  test("a trailing slash is the same request", () => {
    const slashed = new Request("http://localhost/api/auth/login/", {
      method: "POST",
    });
    expect(isCredentialRequest(slashed)).toBe(true);
  });

  // `/auth/me` is polled by the frontend on every page load, so it would lock the app out of itself.
  // `/auth/password` sits behind a session, where including it would let whoever stole that session
  // lock the owner out of changing their password. `/auth/google` needs a token Google signed.
  test("the rest of /auth stays on the global budget", () => {
    for (const [method, path] of [
      ["GET", "/api/auth/me"],
      ["PATCH", "/api/auth/password"],
      ["POST", "/api/auth/google"],
      ["POST", "/api/auth/logout"],
    ] as const) {
      const request = new Request(`http://localhost${path}`, { method });
      expect(isCredentialRequest(request)).toBe(false);
    }
  });

  // Matched as METHOD + path, so a method a route does not serve is NOT covered. A 404 spends
  // whatever budget covers it, and covering `GET /auth/login` would let a crawler or a broken link
  // burn the login budget for every client sharing that address.
  test("a method the route does not serve is left to the global budget", () => {
    for (const method of ["GET", "PUT", "DELETE", "HEAD"]) {
      const request = new Request("http://localhost/api/auth/login", {
        method,
      });
      expect(isCredentialRequest(request)).toBe(false);
    }
    // And the mirror image on the one GET route that IS covered.
    for (const method of ["POST", "PUT", "DELETE"]) {
      const request = new Request("http://localhost/api/auth/invite", {
        method,
      });
      expect(isCredentialRequest(request)).toBe(false);
    }
    // Folding HEAD into GET must not widen the POST routes: `HEAD /auth/login` resolves to
    // `GET /auth/login`, which is not covered, so a crawler still cannot burn the login budget.
    const headLogin = new Request("http://localhost/api/auth/login", {
      method: "HEAD",
    });
    expect(isCredentialRequest(headLogin)).toBe(false);
  });
});

describe("both buckets exist on the real app", () => {
  // If the credential limiter shared the DCR limiter's budget, Elysia would drop it and this would
  // read the global 600 instead.
  test("a credential request answers from the credential bucket", async () => {
    expect(await ceilingOf(await post("/api/auth/login"))).toBe("20");
  });

  test("the slashed spelling lands in the same bucket", async () => {
    expect(await ceilingOf(await post("/api/auth/login/"))).toBe("20");
  });

  test("the four paths share one bucket", async () => {
    const before = Number(await ceilingOf(await post("/api/auth/login")));
    expect(before).toBe(20);
    for (const path of [
      "/api/auth/signup",
      "/api/auth/setup",
      "/api/auth/accept-invite",
    ]) {
      expect(await ceilingOf(await post(path))).toBe("20");
    }
  });

  // A collision would deduplicate one of the two away; both answer, each from its own ceiling.
  test("the DCR limiter still has its own bucket", async () => {
    expect(await ceilingOf(await post("/api/v1/mcp/oauth/register"))).toBe(
      "10",
    );
  });

  test("everything else stays on the global bucket", async () => {
    const response = await Bun.fetch(`${base}/api/auth/me`);
    expect(response.headers.get("ratelimit-limit")).toBe("1000000");
  });
});

describe("boot refuses a configuration that would delete a bucket", () => {
  // What the check is FOR. Two limiters with the same budget and window are one limiter, and the one
  // that loses is the only thing counting its traffic, so a collision never tightens anything.
  test("two limiters with the same budget and window are refused", () => {
    expect(() =>
      assertLimiterBudgetsAreDistinct([
        ["the DCR registration budget", 10, 60_000],
        ["the credential budget", 10, 60_000],
      ]),
    ).toThrow(/deduplicated by Elysia/);
  });

  test("the same budget over a different window is fine", () => {
    expect(() =>
      assertLimiterBudgetsAreDistinct([
        ["the DCR registration budget", 10, 60_000],
        ["the credential budget", 10, 300_000],
      ]),
    ).not.toThrow();
  });

  test("the shipped set passes", () => {
    expect(() =>
      assertLimiterBudgetsAreDistinct([
        ["the global budget", 600, 60_000],
        ["the MCP transport budget", 1200, 60_000],
        ["the static asset budget", 1000, 60_000],
        ["the DCR registration budget", 10, 60_000],
        ["the credential budget", 20, 300_000],
      ]),
    ).not.toThrow();
  });

  // Compared as rates, because the windows differ: 20 per 5 minutes is 4/min against the global
  // 600/min, so the credential bucket is the one that trips.
  test("a credential budget looser than the global one is refused", () => {
    // The shipped values: 20 per 5 minutes is 4/min against 600/min.
    expect(() => assertCredentialBudgetIsTighter(20, 5, 600)).not.toThrow();
    // 6000 per 5 minutes is 1200/min, twice the global budget.
    expect(() => assertCredentialBudgetIsTighter(6000, 5, 600)).toThrow(
      /must be below RATE_LIMIT_USER_PER_MIN/,
    );
    // NOTE: equal rates are refused too: 3000 per 5 minutes is exactly 600/min, and the global
    // limiter fronts the same requests, so a matching credential budget never trips first.
    expect(() => assertCredentialBudgetIsTighter(3000, 5, 600)).toThrow(
      /must be below RATE_LIMIT_USER_PER_MIN/,
    );
  });
});

describe("boot refuses a budget the limiter cannot honour", () => {
  const parse = (raw: string | undefined) =>
    parseIntSetting(
      raw,
      "RATE_LIMIT_CREDENTIAL_WINDOW_MINUTES",
      5,
      "because.",
      1440,
    );

  test("unset or blank takes the default", () => {
    expect(parse(undefined)).toBe(5);
    expect(parse("   ")).toBe(5);
  });

  test("a positive whole number is taken as written", () => {
    expect(parse("15")).toBe(15);
  });

  // `Number("Infinity") > 0` is true and `1e309` parses to Infinity, so a `RAW && Number(RAW) > 0`
  // check accepts both. With an infinite window the limiter advertises `RateLimit-Reset: NaN` and
  // the bucket never resets: a config typo would lock login with 429 until an edit and a restart.
  test("an infinite window is refused, however it is spelled", () => {
    expect(() => parse("Infinity")).toThrow(/between 1 and/);
    expect(() => parse("1e309")).toThrow(/between 1 and/);
  });

  // Why the bound exists rather than a finiteness check: `Number.isInteger(1e12)` is true, but 1e12
  // minutes in milliseconds is past Date's ±8.64e15 range, so the reset lands on an invalid date
  // exactly like Infinity does. A day is well past any real throttle.
  test("a window too large for a reset date is refused", () => {
    expect(() => parse("1000000000000")).toThrow(/between 1 and 1440/);
    expect(parse("1440")).toBe(1440);
    expect(() => parse("1441")).toThrow(/between 1 and 1440/);
  });

  // Falling back would be worse than throwing: a typo becomes a budget nobody chose, silently.
  test("garbage throws instead of quietly becoming the default", () => {
    for (const raw of ["abc", "0", "-5", "2.5", "NaN", "5 minutes"]) {
      expect(() => parse(raw)).toThrow(/between 1 and/);
    }
  });

  test("the error names the variable, so the operator knows which one", () => {
    expect(() => parse("nope")).toThrow(/RATE_LIMIT_CREDENTIAL_WINDOW_MINUTES/);
  });
});
