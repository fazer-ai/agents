import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { authPlugin } from "@/api/lib/auth";
import {
  mockFindUnique,
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

// What a route does with an id in its path that is not one. Coverage is over the REAL route table,
// not a hand-written list: `app.routes` carries the params schema Elysia resolved and the handler it
// registered. `BigInt` is arbitrary precision, so an id past 2^63-1 parses in the handler and only
// POSTGRES refuses it (a 500) unless the boundary does.
//
// The structural tests send no requests on purpose: the limiter is ONE bucket per process (600/min,
// shared by every file in the worker), so a per-route request sweep passes locally and 429s on CI
// while starving unrelated files. Requests are spent only on the wire contract.

const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

setupPrismaMock();
const app = (await import("@/app")).default;

const fleetUser = { ...mockUser, tenantId: null, role: "SUPER_ADMIN" as const };
mockFindUnique.mockImplementation(() => Promise.resolve(fleetUser));
const tokenApp = new Elysia()
  .use(authPlugin)
  .post("/mint", async ({ setAuthCookie }) => ({
    token: await setAuthCookie(fleetUser, fleetUser.passwordHash),
  }));
const { token } = (await (
  await tokenApp.handle(
    new Request("http://localhost/mint", { method: "POST" }),
  )
).json()) as { token: string };

// A path segment that addresses a row. Every OTHER `:param` in this app is opaque: a route token, a
// thread key shaped `tenant:playground:agent:uuid`, an OAuth client_id, a jti, an asset kind. Listed
// by what they ARE rather than derived from the name, because `clientId` and `agentId` are the same
// shape of name and only one of them is a row id.
const DB_ID_PARAMS = new Set(["id", "agentId", "mediaId"]);

// A route parameter no handler reads. Held as an exact set so that a handler which STOPS parsing one
// has to be written down here rather than quietly leaving the coverage.
const NOT_READ_BY_ITS_HANDLER: Record<string, string> = {
  "GET /api/v1/agents/:id/playground/media/:mediaId [id]":
    "the blob is looked up by media id and scoped by tenant; the agent id in the path is decoration",
};

interface RouteEntry {
  method: string;
  path: string;
  handler?: unknown;
  hooks?: {
    params?: { properties?: Record<string, unknown> };
    response?: Record<string, unknown>;
  };
}

interface IdParam {
  key: string;
  route: RouteEntry;
  param: string;
}

const idParams: IdParam[] = [];
for (const route of app.routes as unknown as RouteEntry[]) {
  for (const param of Object.keys(route.hooks?.params?.properties ?? {})) {
    if (!DB_ID_PARAMS.has(param)) continue;
    idParams.push({
      key: `${route.method} ${route.path} [${param}]`,
      route,
      param,
    });
  }
}

const handlerSource = (route: RouteEntry): string =>
  typeof route.handler === "function" ? String(route.handler) : "";

describe("every route that takes an id in its path parses it", () => {
  // A filter that stops matching would empty both structural tests and leave them vacuously green,
  // so the count is asserted first. A floor, not a ceiling: adding routes must not need this edited.
  test("the route table still carries the id parameters", () => {
    expect(idParams.length).toBeGreaterThanOrEqual(100);
    expect(idParams.map((p) => p.key)).toContain("GET /api/v1/agents/:id [id]");
  });

  test("each one is parsed by the handler that receives it", () => {
    const unparsed = idParams
      .filter(({ key }) => !(key in NOT_READ_BY_ITS_HANDLER))
      .filter(
        ({ route, param }) =>
          !handlerSource(route).includes(`requireDbId(params.${param}`),
      )
      .map(({ key }) => key);
    expect(unparsed).toEqual([]);
  });

  // The control for the test above: it reads TRANSPILED source, so a build that renamed the import
  // would make it match nothing and pass. This fails in that case instead.
  test("the handler source is readable, and the match is not vacuous", () => {
    const agents = idParams.find(
      (p) => p.key === "GET /api/v1/agents/:id [id]",
    );
    if (!agents) throw new Error("the agents route left the table");
    const source = handlerSource(agents.route);
    expect(source).toContain("requireDbId(params.id");
    expect(source).not.toContain("BigInt(params.id");
    const parsed = idParams.filter(({ route, param }) =>
      handlerSource(route).includes(`requireDbId(params.${param}`),
    );
    expect(parsed.length).toBeGreaterThanOrEqual(100);
  });

  // The exclusions are data, and data rots.
  test("a parameter listed as unread is still unread", () => {
    const stale = Object.keys(NOT_READ_BY_ITS_HANDLER).filter((key) => {
      const entry = idParams.find((p) => p.key === key);
      if (!entry) return true;
      return handlerSource(entry.route).includes(
        `requireDbId(params.${entry.param}`,
      );
    });
    expect(stale).toEqual([]);
  });

  // NOTE: A status a route can return is part of its published contract: the Eden types the console
  // is built against and the committed openapi.json both come from these `response:` maps.
  test("every one of those routes declares the 400 it can answer", () => {
    const undeclared = idParams
      .filter(({ route }) => !("400" in (route.hooks?.response ?? {})))
      .map(({ key }) => key);
    expect(undeclared).toEqual([]);
  });
});

// Every spelling `BigInt` accepts and a bigint column does not, plus the one it accepts and the
// column cannot hold. The last row is not a `SyntaxError`, so the branch in src/app.ts that answers
// the others never sees it.
const MALFORMED = [
  "abc",
  "0x7",
  "+7",
  " 7 ",
  "1e3",
  "7.0",
  "9223372036854775808",
];

const get = (path: string, lang = "en"): Promise<Response> =>
  app.handle(
    new BunRequest(`http://localhost${path}`, {
      headers: {
        cookie: `fazerai_auth_token=${token}`,
        "X-Tenant-Id": "1",
        "accept-language": lang,
      },
    }),
  );

describe("the refusal a malformed path id produces", () => {
  test("every spelling is answered 400, naming the parameter", async () => {
    const wrong: string[] = [];
    for (const raw of MALFORMED) {
      const res = await get(`/api/v1/agents/${encodeURIComponent(raw)}`);
      const body = (await res.json()) as Record<string, unknown>;
      if (res.status !== 400 || body.error !== "Not a valid id") {
        wrong.push(
          `${JSON.stringify(raw)} -> ${res.status} ${JSON.stringify(body)}`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });

  // The refusal names the parameter it refused, which on this route is not `id`.
  test("a parameter that is not called id is named by its own name", async () => {
    const res = await get("/api/v1/chatwoot/labels/abc");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Not a valid agentId" });
  });

  // NOTE: The half the status cannot show: the refusal is JSON with an `error` key, which is what
  // `apiErrorMessage` (src/client/lib/apiError.ts) surfaces instead of its generic transport sentence.
  test("it is JSON, and localized", async () => {
    const res = await get("/api/v1/agents/abc", "pt-BR");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "Não é um id válido" });
  });

  // NOTE: The tenant selector is an id in a HEADER, and a null target reads as "no target" on these
  // routes, so a malformed one is refused at the boundary rather than folded into that.
  test("a malformed tenant selector is refused, not treated as no selector", async () => {
    const paths = [
      "/api/v1/agents",
      "/api/v1/metrics/costs",
      "/api/v1/vault/1/oauth/google/status",
    ];
    const answers: string[] = [];
    for (const path of paths) {
      const res = await app.handle(
        new BunRequest(`http://localhost${path}`, {
          headers: {
            cookie: `fazerai_auth_token=${token}`,
            "X-Tenant-Id": "0x7",
          },
        }),
      );
      answers.push(`${res.status} ${JSON.stringify(await res.json())}`);
    }
    expect(answers).toEqual([
      '400 {"error":"Not a valid X-Tenant-Id"}',
      '400 {"error":"Not a valid X-Tenant-Id"}',
      '400 {"error":"Not a valid X-Tenant-Id"}',
    ]);
  });

  // The control: omitting the selector is not malformed, and the route answers it its own way, as a
  // fleet caller with no target, not as a bad header. This is what stops the refusal above from being
  // read as "the header became required".
  test("omitting the selector is answered as no target, not as a malformed one", async () => {
    const res = await app.handle(
      new BunRequest("http://localhost/api/v1/metrics/costs", {
        headers: { cookie: `fazerai_auth_token=${token}` },
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "A target tenant is required" });
  });

  // NOTE: The other half of "a path segment is not an id", on the one route that COMPARES one: the
  // guard that stops an admin locking themselves out must compare the parsed id, because
  // `parseDbId` accepts leading zeros and `001` addresses the caller's row while failing a string
  // equality.
  test("the self-demotion guard reads the id, not the segment", async () => {
    const demote = (segment: string) =>
      app.handle(
        new BunRequest(`http://localhost/api/admin/users/${segment}/role`, {
          method: "PATCH",
          headers: {
            cookie: `fazerai_auth_token=${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ role: "AGENT" }),
        }),
      );

    // NOTE: The control: the plain spelling of the caller's own id is caught too.
    expect((await demote(String(fleetUser.id))).status).toBe(403);

    const padded = await demote(`00${fleetUser.id}`);
    expect(padded.status).toBe(403);
    expect(await padded.json()).toEqual({ error: "Cannot demote yourself" });
  });
});
