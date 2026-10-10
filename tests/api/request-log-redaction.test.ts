import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { format } from "node:util";
import { Prisma } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { buildApp } from "@/app";
import config from "@/config";
import { until } from "@/tests/utils/poll";
import { prismaMock, setupPrismaMock } from "@/tests/utils/prisma-mock";

// The public Chatwoot webhook's route token is its credential next to the HMAC, so no log line about
// a request (the access line, the error arms of src/app.ts) may print it, and a failed lookup's
// detail reaches the log and never the body, in development too.
setupPrismaMock();
const app = await buildApp();

// The names whose value a log line may print, mirrored from src/api/lib/request-target.ts so the sweep
// above does not trust the module it tests to say which routes are credentials.
const PRINTED_PARAMS = new Set([
  "id",
  "agentId",
  "clientId",
  "jti",
  "kind",
  "mediaId",
  "threadId",
  "variant",
]);

const SENTINEL =
  "SENTINELA_1219 Can't reach database server at db-interno.sentinela:5432";

// The client the receiver resolves the token with, made to fail the way Prisma fails: the mock has no
// Chatwoot bot model, so this is the injection point and not a function the fix introduced.
const lookupFails = () => {
  (prismaMock as unknown as Record<string, unknown>).chatwootAgentBot = {
    findUnique: () =>
      Promise.reject(
        new Prisma.PrismaClientKnownRequestError(SENTINEL, {
          code: "P1001",
          clientVersion: "test",
        }),
      ),
  };
};

// A token this process never saw, so no cache entry answers in place of the lookup.
const freshToken = () => randomBytes(32).toString("base64url");

type Captured = { level: string; line: string };
let captured: Captured[] = [];
let spies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  captured = [];
  spies = (["info", "warn", "error"] as const).map((level) =>
    spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      captured.push({ level, line: format(...args) });
    }) as never),
  );
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

// The access line is written after the response, so it is awaited, never assumed.
const accessLineFor = (method: string, pathPrefix: string) =>
  until(`the access line of ${method} ${pathPrefix}`, () =>
    captured.find(
      (c) =>
        c.level === "info" &&
        c.line.startsWith(`${method} `) &&
        c.line.includes(pathPrefix),
    ),
  );

const inEnv = async <T>(
  env: "development" | "test",
  fn: () => Promise<T>,
): Promise<T> => {
  const cfg = config as { env: string };
  const was = cfg.env;
  cfg.env = env;
  try {
    return await fn();
  } finally {
    cfg.env = was;
  }
};

const postWebhook = (token: string, query = "") =>
  app.handle(
    new Request(`http://localhost/api/v1/chatwoot/webhook/${token}${query}`, {
      method: "POST",
      body: "{}",
    }),
  );

describe.each(["development", "test"] as const)(
  "a failed route-token lookup, in %s",
  (env) => {
    test("answers a generic 500 and keeps the detail in the log", async () => {
      lookupFails();
      const token = freshToken();
      const res = await inEnv(env, () => postWebhook(token));
      const body = await res.text();
      await accessLineFor("POST", "/api/v1/chatwoot/webhook/");

      expect(res.status).toBe(500);
      expect(body).toBe("Something went wrong");
      expect(body).not.toContain("SENTINELA_1219");
      expect(body).not.toContain(token);
      expect(captured.some((c) => c.line.includes("SENTINELA_1219"))).toBe(
        true,
      );
    });

    test("prints the token in no log line", async () => {
      lookupFails();
      const token = freshToken();
      await (await inEnv(env, () => postWebhook(token))).text();
      await accessLineFor("POST", "/api/v1/chatwoot/webhook/");

      expect(captured.length).toBeGreaterThan(1);
      for (const { line } of captured) expect(line).not.toContain(token);
    });
  },
);

test("a token the lookup does not know is refused 401 and printed in no log line", async () => {
  (prismaMock as unknown as Record<string, unknown>).chatwootAgentBot = {
    findUnique: () => Promise.resolve(null),
  };
  const token = freshToken();
  const res = await postWebhook(token);
  await res.text();
  await accessLineFor("POST", "/api/v1/chatwoot/webhook/");

  expect(res.status).toBe(401);
  expect(captured.some((c) => c.level === "warn")).toBe(true);
  for (const { line } of captured) expect(line).not.toContain(token);
});

describe("the access line", () => {
  test("keeps method, route and status, with the token masked, query string included", async () => {
    lookupFails();
    const token = freshToken();
    const secretQuery = freshToken();
    await (await postWebhook(token, `?x=${secretQuery}`)).text();
    const { line } = await accessLineFor("POST", "/api/v1/chatwoot/webhook/");

    expect(line).toContain("/api/v1/chatwoot/webhook/[redacted]");
    expect(line).toContain("?x=[redacted]");
    expect(line).toEndWith("[500]");
    expect(line).not.toContain(token);
    expect(line).not.toContain(secretQuery);
  });

  test("of a route with no credential keeps its path whole", async () => {
    await (await app.handle(new Request("http://localhost/api/health"))).text();
    const { line } = await accessLineFor("GET", "/api/health");

    expect(line).toContain("http://localhost/api/health [");
    expect(line).not.toContain("[redacted]");
  });

  test("keeps an id the route names", async () => {
    await (
      await app.handle(new Request("http://localhost/api/v1/agents/4242"))
    ).text();
    const { line } = await accessLineFor("GET", "/api/v1/agents/");

    expect(line).toContain("/api/v1/agents/4242 [");
  });
});

// THE FENCE. Every registered route whose parameter is not on the printable list carries a credential
// in its URL, and a new one is swept here without anyone listing it: the request goes out with a
// sentinel in each such parameter and in the query string, and no log line the request produced may
// hold it. A route that cannot be reached without a body still logs its URL, which is what is asserted.
describe("every route that carries a credential in its URL", () => {
  const credentialRoutes = app.routes.filter((r) =>
    [...r.path.matchAll(/:([A-Za-z0-9_]+)/g)].some(
      (m) => !PRINTED_PARAMS.has(m[1] ?? ""),
    ),
  );

  test("the sweep found the routes it exists for", () => {
    const paths = credentialRoutes.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain("POST /api/v1/chatwoot/webhook/:routeToken");
    expect(paths).toContain("POST /api/v1/integrations/inbound/:routeToken");
  });

  test.each(credentialRoutes.map((r) => [`${r.method} ${r.path}`, r] as const))(
    "%s prints none of it",
    async (_name, route) => {
      lookupFails();
      const secret = freshToken();
      const path = route.path.replace(/:([A-Za-z0-9_]+)/g, (_m, name) =>
        PRINTED_PARAMS.has(name) ? "1" : secret,
      );
      const res = await app.handle(
        new Request(`http://localhost${path}?token=${secret}`, {
          method: route.method,
          ...(route.method === "GET" || route.method === "HEAD"
            ? {}
            : { body: "{}", headers: { "content-type": "application/json" } }),
        }),
      );
      await res.text();
      await accessLineFor(route.method, path.split(secret)[0] ?? path);

      for (const { line } of captured) expect(line).not.toContain(secret);
    },
  );
});
