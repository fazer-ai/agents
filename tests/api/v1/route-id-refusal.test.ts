import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { authPlugin } from "@/api/lib/auth";
import {
  mockFindUnique,
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

// What a route answers when the id in its PATH is not one.
//
// Driven over the real app, and swept over the real route table rather than over a hand-written list
// of paths: the defect was one rule spelled a hundred times, so a test that names the routes it
// checks would have gone stale the same way the rule did. `app.routes` carries the params schema
// Elysia resolved, which is what says whether a path segment is an id at all.
//
// Measured on this app before the sweep, over the 57 GET/DELETE routes carrying one: 46 answered
// 500, 12 answered 422, one answered 200, and five already answered 400. The 500 is the one the
// issue reports — `BigInt` is arbitrary precision, so an id past 2^63-1 parses in the handler and is
// refused by POSTGRES when the query binds it. Issue #371.
//
// The suite has no database in the general case and does not need one here: every assertion is about
// a refusal that happens BEFORE any query, and the run without a database is what makes "reached the
// database at all" visible as a 500.

const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

setupPrismaMock();
const app = (await import("@/app")).default;

const fleetUser = { ...mockUser, tenantId: null, role: "SUPER_ADMIN" as const };
mockFindUnique.mockImplementation(() => Promise.resolve(fleetUser));
const tokenApp = new Elysia()
  .use(authPlugin)
  .post("/mint", async ({ setAuthCookie }) => ({
    token: await setAuthCookie(fleetUser),
  }));
const { token } = (await (
  await tokenApp.handle(
    new Request("http://localhost/mint", { method: "POST" }),
  )
).json()) as { token: string };

// A path segment that addresses a row. Every OTHER `:param` in this app is opaque — a route token, a
// thread key shaped `tenant:playground:agent:uuid`, an OAuth client_id, a jti, an asset kind. Listed
// by what they ARE rather than derived from the name, because `clientId` and `agentId` are the same
// shape of name and only one of them is a row id.
const DB_ID_PARAMS = new Set(["id", "agentId", "mediaId"]);

// The label the refusal names, per route parameter. `requireDbId`'s default is the parameter's own
// name; two routes name the domain id instead, because the path spells it `:id` and the value is a
// delivery.
const LABEL: Record<string, string> = {
  "GET /api/v1/webhooks/deliveries/:id": "deliveryId",
};

// Cases where a DIFFERENT value is refused before the id is read, so they say nothing about it.
// Asserted as an exact set below: a route that stops refusing the id has to show up here rather than
// quietly leave the sweep.
const ANSWERED_BEFORE_THE_ID: Record<string, string> = {
  "DELETE /api/admin/users/:id [id]": "the body requires the caller's password",
  "DELETE /api/v1/tenants/:id [id]": "the body requires confirmName",
  "DELETE /api/v1/agents/:id [id]": "the body requires confirmName",
  "GET /api/v1/agents/:id/playground/media/:mediaId [id]":
    "this route ignores the agent id and scopes the lookup by tenant",
};

interface RouteEntry {
  method: string;
  path: string;
  hooks?: { params?: { properties?: Record<string, unknown> } };
}

interface Probe {
  key: string;
  method: string;
  path: string;
  param: string;
  label: string;
}

const probes: Probe[] = [];
for (const route of app.routes as unknown as RouteEntry[]) {
  if (route.method !== "GET" && route.method !== "DELETE") continue;
  const properties = route.hooks?.params?.properties ?? {};
  for (const param of Object.keys(properties)) {
    if (!DB_ID_PARAMS.has(param)) continue;
    const key = `${route.method} ${route.path} [${param}]`;
    if (key in ANSWERED_BEFORE_THE_ID) continue;
    probes.push({
      key,
      method: route.method,
      path: route.path,
      param,
      label: LABEL[`${route.method} ${route.path}`] ?? param,
    });
  }
}

// Every spelling `BigInt` accepts and a bigint column does not, plus the one it accepts and the
// column cannot hold. The last row is the issue: it is not a `SyntaxError`, so the branch in
// src/app.ts that answers the others never sees it.
const MALFORMED = [
  "abc",
  "0x7",
  "+7",
  " 7 ",
  "1e3",
  "7.0",
  "9223372036854775808",
];

// The spelling every route is swept with. The out-of-range one, because it is the row the issue
// reports and the only one no route refused: the others were already answered 400, badly.
const OUT_OF_RANGE = "9223372036854775808";

// One route per family, for the spelling table below. Sweeping every route with every spelling costs
// 350 requests against a limiter whose budget is ONE BUCKET for the whole process (600/min, shared
// with every other file in the same worker), and a 429 in the middle of a sweep is a green test that
// stopped testing. The spellings themselves are a decision table on `parseDbId`
// (tests/lib/db-id.test.ts); what these three add is that a ROUTE reaches it.
const BY_FAMILY = [
  // never carried a shape constraint: the 400 came from the BigInt branch in src/app.ts
  "GET /api/v1/agents/:id [id]",
  // carried `pattern: "^[0-9]+$"` in its params schema, and answered 422 before the auth guard
  "GET /api/v1/vault/:id/references [id]",
  // the parameter is not named `id`, so the refusal has to name the one it refused
  "GET /api/v1/chatwoot/labels/:agentId [agentId]",
];

const call = async (
  probe: Probe,
  raw: string,
): Promise<{ status: number; body: Record<string, unknown>; text: string }> => {
  const path = probe.path.replace(/:([A-Za-z]+)/g, (_m, name: string) => {
    if (name === probe.param) return encodeURIComponent(raw);
    return DB_ID_PARAMS.has(name) ? "1" : "zzz";
  });
  const query = path.includes("/media")
    ? "?url=https%3A%2F%2Fexample.com%2Fa.png"
    : "";
  const res = await app.handle(
    new BunRequest(`http://localhost${path}${query}`, {
      method: probe.method,
      headers: {
        cookie: `fazerai_auth_token=${token}`,
        "X-Tenant-Id": "1",
        "content-type": "application/json",
      },
      body: probe.method === "DELETE" ? "{}" : undefined,
    }),
  );
  // The limiter's budget is ONE bucket for the whole process and every request here resolves to the
  // same key, so a file that ran earlier in this worker has already spent some of it. A 429 in the
  // middle of a sweep is not a result about the route, and it must not read as one.
  if (res.status === 429) {
    throw new Error(
      `${probe.key}: the shared rate-limit budget ran out mid-sweep; this file is spending too many requests`,
    );
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.status, body, text };
};

describe("a path id that is not one", () => {
  // A filter that stops matching would empty the sweep and leave every assertion below vacuous, so
  // the count is the first thing asserted. The number is the floor the route table was at when this
  // was written, not a ceiling: adding routes must not need this file edited.
  test("the sweep still covers the route table", () => {
    expect(probes.length).toBeGreaterThanOrEqual(49);
  });

  test("an id past 2^63-1 is refused by every route, not by Postgres", async () => {
    const wrong: string[] = [];
    for (const probe of probes) {
      const { status, body } = await call(probe, OUT_OF_RANGE);
      if (status !== 400 || body.error !== `Not a valid ${probe.label}`) {
        wrong.push(`${probe.key} -> ${status} ${JSON.stringify(body)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("every malformed spelling is refused, in the app's own vocabulary", async () => {
    const wrong: string[] = [];
    for (const key of BY_FAMILY) {
      const probe = probes.find((p) => p.key === key);
      if (!probe) throw new Error(`${key} left the route table`);
      for (const raw of MALFORMED) {
        const { status, body } = await call(probe, raw);
        const expected = `Not a valid ${probe.label}`;
        if (status !== 400 || body.error !== expected) {
          wrong.push(
            `${probe.key} ${JSON.stringify(raw)} -> ${status} ${JSON.stringify(body)}`,
          );
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  // The half the 400 above cannot show. `Invalid ID format` was plain text, so `apiErrorMessage`
  // (src/client/lib/apiError.ts) read no `error` key and fell back to its generic transport sentence:
  // the console could not surface what the server had already named.
  test("the refusal is JSON, and localized", async () => {
    const probe = probes.find((p) => p.path === "/api/v1/agents/:id");
    if (!probe) throw new Error("the agents route left the table");
    const path = "/api/v1/agents/abc";
    const res = await app.handle(
      new BunRequest(`http://localhost${path}`, {
        headers: {
          cookie: `fazerai_auth_token=${token}`,
          "X-Tenant-Id": "1",
          "accept-language": "pt-BR",
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "Não é um id válido" });
  });

  // The refusal is a status, and a status a route can return is part of its published contract: the
  // Eden types the console is built against and the committed openapi.json both come from these
  // `response:` maps (issue #314 pays for the same rule on 422). This covers every method, including
  // the POSTs and PATCHes the request sweep above cannot reach.
  test("every route with an id in its path declares the 400 it can answer", () => {
    const undeclared: string[] = [];
    for (const route of app.routes as unknown as RouteEntry[]) {
      const properties = route.hooks?.params?.properties ?? {};
      if (!Object.keys(properties).some((name) => DB_ID_PARAMS.has(name)))
        continue;
      const declared = (
        route as unknown as { hooks?: { response?: Record<string, unknown> } }
      ).hooks?.response;
      if (!declared || !("400" in declared)) {
        undeclared.push(`${route.method} ${route.path}`);
      }
    }
    expect(undeclared).toEqual([]);
  });

  // The other half of "a path segment is not an id", on the one route that COMPARED one. The guard
  // that stops an admin from locking themselves out read `user.id.toString() === params.id`, and
  // `parseDbId` accepts leading zeros, so `001` addressed the caller's own row while failing that
  // string equality. Nothing covered this guard at all before, in either spelling.
  test("the self-demotion guard reads the id, not the segment", async () => {
    const demote = async (segment: string) =>
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

    // The control: the plain spelling of the caller's own id has always been caught.
    const plain = await demote(String(fleetUser.id));
    expect(plain.status).toBe(403);

    const padded = await demote(`00${fleetUser.id}`);
    expect(padded.status).toBe(403);
    expect(await padded.json()).toEqual({ error: "Cannot demote yourself" });
  });

  // The excluded set is data, and data rots. Each entry is checked to still be excluded FOR THE
  // REASON given: it answers something, and that something is not the id refusal.
  test("every excluded case is still answered by something else", async () => {
    const stale: string[] = [];
    for (const [key, reason] of Object.entries(ANSWERED_BEFORE_THE_ID)) {
      const [method, path, bracket] = key.split(" ");
      const param = (bracket ?? "").replace(/[[\]]/g, "");
      if (!method || !path || !param) throw new Error(`unreadable key: ${key}`);
      const { status, body } = await call(
        { key, method, path, param, label: param },
        "abc",
      );
      if (status === 400 && body.error === `Not a valid ${param}`) {
        stale.push(`${key} now refuses the id (${reason})`);
      }
    }
    expect(stale).toEqual([]);
  });
});
