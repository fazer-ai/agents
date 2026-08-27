import { describe, expect, test } from "bun:test";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

// Issue #314. The schema boundary (#255, src/api/lib/schema-refusal.ts) answers a TypeBox refusal
// with 422, a localized sentence and the `field` the value failed on. It runs BEFORE the role guard,
// so the status is reachable on any route with a request schema, authenticated or not — and one
// route of the whole API declared it. `openapi.json` is a committed artifact and the Eden types the
// console is built against come from the same `response:` maps, so a status a route returns was a
// status no generated client knew how to handle.
//
// This fence MEASURES rather than infers, which is the lesson #297 paid for: "declares a body
// schema" is a candidate list, not a result. A path parameter is always a string and always present,
// so a bare `t.String()` param refuses nothing a caller can send; declaring 422 there would publish
// a status the route never returns, which is the same wrong contract in the other direction.
//
// Measured on `main` before the change, over real HTTP against the built app, unauthenticated:
//
//   routes declaring a request schema  177
//   answered 422                       104   (1 declared it)
//   answered something else             73   (0 declared it)
//
// No probe reaches a handler: every one lands on the boundary (422) or on the role guard (401), so
// nothing here touches the database or any external system.
const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

setupPrismaMock();
const app = (await import("@/app")).default;

type Schema = Record<string, unknown> | null | undefined;
type Route = {
  method: string;
  path: string;
  hooks?: {
    body?: Schema;
    query?: Schema;
    params?: Schema;
    response?: Record<string, unknown>;
  };
};

function props(s: Schema): Record<string, Schema> {
  return (s?.properties ?? {}) as Record<string, Schema>;
}

// A value the schema ACCEPTS, so a probe can violate one dimension while the rest stays valid.
export function validFor(s: Schema): unknown {
  if (!s || typeof s !== "object") return "x";
  const anyOf = s.anyOf as Schema[] | undefined;
  if (anyOf) return validFor(anyOf[0]);
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.enum)) return (s.enum as unknown[])[0];
  if (s.default !== undefined) return s.default;
  switch (s.type) {
    case "string": {
      if (s.pattern) return "1";
      if (s.format === "email") return "a@b.co";
      const min = Math.max(1, (s.minLength as number) ?? 1);
      return "a".repeat(Math.min(min, (s.maxLength as number) ?? min));
    }
    case "integer":
    case "number":
      return (s.minimum as number) ?? 1;
    case "boolean":
      return true;
    case "array":
      return [];
    case "object": {
      const out: Record<string, unknown> = {};
      for (const key of (s.required ?? []) as string[]) {
        out[key] = validFor(props(s)[key]);
      }
      return out;
    }
    default:
      return "x";
  }
}

// A value the schema REFUSES, and where it sits. `null` when the schema refuses nothing that this
// side of the request can carry.
//
// `inPath` is what separates a path parameter from a body value, and it is not a detail: a path
// segment always exists (the route would not match otherwise) and is always a string, so `required`
// and `minLength: 1` are satisfied by the routing itself. Measured — `/mcp/oauth/consent/` answers
// 404 (no route), `/mcp/oauth/consent/%20` answers 401 (past the boundary), and neither is a 422.
export function violation(
  s: Schema,
  path: string[] = [],
  inPath = false,
): { path: string[]; bad: unknown } | null {
  if (!s || typeof s !== "object") return null;
  const anyOf = s.anyOf as Schema[] | undefined;
  if (anyOf) {
    // A union refuses junk unless SOME member takes any string at all.
    const permissive = anyOf.some(
      (m) =>
        m &&
        typeof m === "object" &&
        m.const === undefined &&
        !Array.isArray(m.enum) &&
        (m.type === undefined ||
          (m.type === "string" &&
            !m.pattern &&
            !m.format &&
            !m.minLength &&
            !m.maxLength)),
    );
    return permissive ? null : { path, bad: "zzz-not-a-member" };
  }
  if (s.const !== undefined) return { path, bad: "zzz-not-the-const" };
  if (Array.isArray(s.enum)) return { path, bad: "zzz-not-in-enum" };
  switch (s.type) {
    case "string": {
      if (s.pattern) return { path, bad: "zzz not matching" };
      const min = (s.minLength as number) ?? 0;
      if (min > (inPath ? 1 : 0)) return { path, bad: inPath ? "z" : "" };
      if (s.maxLength) {
        return { path, bad: "z".repeat((s.maxLength as number) + 1) };
      }
      if (s.format) return { path, bad: "zzz" };
      return null;
    }
    case "integer":
    case "number":
    case "boolean":
      // Outside a JSON body every value arrives as a string, so a non-string type is refusable by
      // construction: anything that does not coerce is refused.
      return { path, bad: "zzz-not-coercible" };
    case "object": {
      for (const [key, sub] of Object.entries(props(s))) {
        const hit = violation(sub, [...path, key], inPath);
        if (hit) return hit;
      }
      return null;
    }
    case "array":
      return violation(s.items as Schema, [...path, "0"], inPath);
    default:
      return null;
  }
}

// A JSON body carries any type, so a declared property's TYPE is violable even when its value has no
// constraint; and an object schema refuses the absence of a body outright.
export function bodyViolation(s: Schema): { path: string[]; bad: unknown } {
  const byConstraint = violation(s, [], false);
  if (byConstraint) return byConstraint;
  for (const [key, sub] of Object.entries(props(s))) {
    const type = sub?.type;
    if (type === "string") return { path: [key], bad: 42 };
    if (type !== undefined) return { path: [key], bad: "zzz" };
    // NOTE: a UNION is permissive for the junk `violation` looks for, which is a STRING outside the
    // members, and still refuses a type no member declares. `POST /v1/vault/:id/test` is the case
    // that pays for this line: its only body property is `string | null`, so it takes any string and
    // answers 422 for a number. That 422 was measurable before only through the route's PATH
    // pattern, and went dark when the pattern moved into the handler (issue #371).
    const members = (sub?.anyOf ?? []) as Schema[];
    const takesANumber = members.some(
      (m) =>
        m?.type === undefined || m.type === "number" || m.type === "integer",
    );
    if (members.length > 0 && !takesANumber) return { path: [key], bad: 42 };
  }
  return { path: [], bad: undefined };
}

function setAt(root: unknown, path: string[], value: unknown): unknown {
  if (path.length === 0) return value;
  let node = root as Record<string, unknown>;
  for (const segment of path.slice(0, -1)) {
    if (node[segment] === undefined) {
      node[segment] = /^\d+$/.test(segment) ? [] : {};
    }
    node = node[segment] as Record<string, unknown>;
  }
  const last = path[path.length - 1];
  if (last === undefined) return root;
  if (value === undefined) delete node[last];
  else node[last] = value;
  return root;
}

function fillPath(
  routePath: string,
  params: Schema,
  violate?: { name: string; bad: string },
): string {
  return routePath.replace(/:(\w+)/g, (_, name: string) =>
    encodeURIComponent(
      violate?.name === name
        ? violate.bad
        : String(validFor(props(params)[name])),
    ),
  );
}

function requiredQuery(query: Schema): Record<string, string> {
  return Object.fromEntries(
    ((query?.required ?? []) as string[]).map((key) => [
      key,
      String(validFor(props(query)[key])),
    ]),
  );
}

type Probe = { kind: string; request: () => Request };

// Every probe the shape of the declared schemas justifies, one per dimension. A route is refusable
// when this list is non-empty, and that is the predicate the measurement is checked against.
function probesFor(route: Route): Probe[] {
  const { body, query, params } = route.hooks ?? {};
  const out: Probe[] = [];
  const url = (path: string, search: Record<string, string>) =>
    `http://localhost${path}${
      Object.keys(search).length ? `?${new URLSearchParams(search)}` : ""
    }`;
  const withBody = body
    ? {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validFor(body)),
      }
    : {};

  if (params) {
    for (const [name, sub] of Object.entries(props(params))) {
      const bad = violation(sub, [], true);
      if (!bad) continue;
      out.push({
        kind: `params.${name}`,
        request: () =>
          new BunRequest(
            url(
              fillPath(route.path, params, { name, bad: String(bad.bad) }),
              requiredQuery(query),
            ),
            { method: route.method, ...withBody },
          ),
      });
      break;
    }
  }

  if (query) {
    const required = (query.required ?? []) as string[];
    const search = requiredQuery(query);
    let kind: string | null = null;
    const first = required[0];
    if (first !== undefined) {
      delete search[first];
      kind = `query.${first} absent`;
    } else {
      const bad = violation(query, [], true);
      if (bad) {
        search[bad.path.join(".")] = String(bad.bad);
        kind = `query.${bad.path.join(".")}`;
      }
    }
    if (kind) {
      out.push({
        kind,
        request: () =>
          new BunRequest(url(fillPath(route.path, params), search), {
            method: route.method,
            ...withBody,
          }),
      });
    }
  }

  if (body) {
    out.push({
      kind: "body absent",
      request: () =>
        new BunRequest(
          url(fillPath(route.path, params), requiredQuery(query)),
          {
            method: route.method,
          },
        ),
    });
    const bad = bodyViolation(body);
    out.push({
      kind: `body.${bad.path.join(".") || "(root)"}`,
      request: () =>
        new BunRequest(
          url(fillPath(route.path, params), requiredQuery(query)),
          {
            method: route.method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(setAt(validFor(body), bad.path, bad.bad)),
          },
        ),
    });
  }

  return out;
}

// The app is a singleton several test files import, and two of them REGISTER fixture routes on it
// (`/__schema/...`, `/__refusal/...`) to exercise the boundary directly. Those are not API surface
// and are not in the published spec, so sweeping them would make this fence's result depend on which
// file loaded first in the worker. The API is everything the controllers mount, and they all mount
// under `/api`; that the filter drops nothing real is asserted below against the spec itself.
const apiRoutes = (app as unknown as { routes: Route[] }).routes.filter((r) =>
  r.path.startsWith("/api/"),
);
const routes = apiRoutes.filter(
  (r) => r.hooks?.body || r.hooks?.query || r.hooks?.params,
);

// The spec spells a parameter `{id}`, carries the `/api` prefix in its server base URL rather than
// in the path, and drops the trailing slash of a prefix root.
function specPathOf(path: string): string {
  return path
    .replace(/^\/api/, "")
    .replace(/:(\w+)/g, "{$1}")
    .replace(/(.)\/$/, "$1");
}

const spec = (await Bun.file("openapi.json").json()) as {
  paths: Record<
    string,
    Record<string, { responses?: Record<string, unknown> }>
  >;
};

// The app is a singleton, and so is the 600/min bucket its global rate limiter keys on. With
// `trustProxy` off (the shipped default the suite runs under) the key is the SOCKET PEER, and
// `app.handle(request)` has no server, so every request in the worker resolves to the same
// `"unknown"` client: this file's ~180 probes would share one budget with every other file's
// requests. A 429 answers BEFORE the schema boundary, so a rate-limited probe measures nothing and
// is not evidence that a route cannot refuse. Measured inside the full suite, without this: 71
// probes came back 429 and the sweep called those routes silent.
//
// So the probes bring their own peer. The limiter's generator reads `server.requestIP(request)`,
// which is null under `handle`; a stand-in that answers a distinct address per probe puts each one
// in its own bucket, which is what a real deployment would do anyway with 180 different clients.
// It is installed for the sweep and taken back off, because the singleton outlives this file.
type ServerStandIn = { requestIP: (request: Request) => { address: string } };
const withServer = app as unknown as { server: ServerStandIn | null };
const realServer = withServer.server;
let probeNumber = 0;
withServer.server = {
  requestIP: () => ({ address: `probe-${probeNumber++}` }),
};

const measured: Array<{
  id: string;
  refusableByShape: boolean;
  answers422: boolean;
  declares422: boolean;
  statuses: Array<{ kind: string; status: number }>;
}> = [];

try {
  for (const route of routes) {
    const probes = probesFor(route);
    const statuses: Array<{ kind: string; status: number }> = [];
    for (const probe of probes) {
      const response = await app.handle(probe.request());
      statuses.push({ kind: probe.kind, status: response.status });
    }
    measured.push({
      id: `${route.method} ${route.path}`,
      refusableByShape: probes.length > 0,
      answers422: statuses.some((s) => s.status === 422),
      declares422: Object.hasOwn(route.hooks?.response ?? {}, "422"),
      statuses,
    });
  }
} finally {
  withServer.server = realServer;
}

describe("a route that can answer 422 declares it", () => {
  test("the probe generator is exercised in both directions", () => {
    const constrained = {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", minLength: 1 } },
    };
    const bare = {
      type: "object",
      properties: { q: { type: "string" } },
    };
    expect(violation(constrained, [], false)).toEqual({
      path: ["name"],
      bad: "",
    });
    // The same schema as a PATH parameter refuses nothing: an empty segment does not route.
    expect(violation(constrained, [], true)).toBeNull();
    expect(violation(bare, [], true)).toBeNull();
    // A body violates on TYPE where the value carries no constraint of its own.
    expect(bodyViolation(bare)).toEqual({ path: ["q"], bad: 42 });
    // A union of literals refuses anything outside it; one carrying a free string does not.
    expect(
      violation({ anyOf: [{ const: "a" }, { const: "b" }] }, [], true),
    ).not.toBeNull();
    expect(
      violation({ anyOf: [{ type: "string" }, { type: "integer" }] }, [], true),
    ).toBeNull();
  });

  test("the sweep sees the whole API and reaches the boundary", () => {
    expect(routes.length).toBeGreaterThanOrEqual(150);
    expect(measured.filter((r) => r.answers422).length).toBeGreaterThanOrEqual(
      90,
    );
    // No probe reaches a handler: the boundary refuses (422) or the role guard does (401), and a
    // path made unroutable by the violation answers 404. Anything else means a probe RAN something.
    const unexpected = measured.flatMap((r) =>
      r.statuses
        .filter((s) => ![422, 401, 404].includes(s.status))
        .map((s) => `${r.id} ${s.kind} -> ${s.status}`),
    );
    expect(unexpected).toEqual([]);
  });

  test("the shape predicate agrees with what the routes answered", () => {
    // A route whose declared schemas refuse nothing a caller can send must not answer 422, and one
    // that can be violated must. Divergence either way means the generator stopped finding a
    // violation it used to find, which is how a sweep goes quietly blind.
    const shapeSaysYes = measured.filter((r) => r.refusableByShape);
    const silent = shapeSaysYes.filter((r) => !r.answers422).map((r) => r.id);
    const surprising = measured
      .filter((r) => !r.refusableByShape && r.answers422)
      .map((r) => r.id);
    expect(surprising).toEqual([]);
    expect(silent).toEqual([]);
  });

  // The rule the agreement above rests on, named at the two routes that pay for it: a `minLength: 1`
  // on a PATH parameter is the one constraint the shape reads as a refusal and the router never
  // lets happen. Only an empty segment breaks it, and an empty segment is a different URL —
  // measured, `/api/v1/mcp/oauth/consent/` answers 404 (no route at all) while
  // `/api/v1/mcp/oauth/consent/%20` answers 401, past the boundary. Asserted as ROUTES rather than
  // only as a predicate case so that renaming or dropping one of them shows up here.
  test("a minLength on a path segment is not a refusal the caller can trigger", () => {
    const byPath = new Map(measured.map((r) => [r.id, r]));
    for (const id of [
      "GET /api/v1/mcp/oauth/consent/:req",
      "DELETE /api/v1/mcp/me/connections/:clientId",
    ]) {
      const route = byPath.get(id);
      expect(route).toBeDefined();
      expect(route?.refusableByShape).toBe(false);
      expect(route?.answers422).toBe(false);
      expect(route?.declares422).toBe(false);
    }
    const asBody = {
      type: "object",
      properties: { x: { type: "string", minLength: 1 } },
    };
    expect(violation(asBody, [], false)).not.toBeNull();
    expect(violation(asBody, [], true)).toBeNull();
    // A longer minimum IS reachable in a path: a one-character segment routes and then fails.
    expect(
      violation(
        { type: "object", properties: { x: { type: "string", minLength: 4 } } },
        [],
        true,
      ),
    ).toEqual({ path: ["x"], bad: "z" });
  });

  test("every route that answered 422 declares it", () => {
    const undeclared = measured
      .filter((r) => r.answers422 && !r.declares422)
      .map((r) => r.id);
    expect(undeclared).toEqual([]);
  });

  test("no route declares a 422 it cannot answer", () => {
    const overdeclared = measured
      .filter((r) => !r.answers422 && r.declares422)
      .map((r) => r.id);
    expect(overdeclared).toEqual([]);
  });

  // The positive control for the `/api/` filter above: every operation the spec publishes must be a
  // route this sweep can see. A filter that started dropping real routes would make the fence pass
  // by looking at less, which is the failure mode a sweep cannot report on itself.
  test("the filtered surface still covers every published operation", () => {
    const swept = new Set(
      apiRoutes.map((r) => `${r.method.toLowerCase()} ${specPathOf(r.path)}`),
    );
    const unseen: string[] = [];
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const method of Object.keys(operations)) {
        if (!swept.has(`${method} ${path}`)) unseen.push(`${method} ${path}`);
      }
    }
    expect(unseen).toEqual([]);
  });

  test("the published spec carries the same 422s", () => {
    const missing: string[] = [];
    for (const route of measured.filter((r) => r.answers422)) {
      const [method, path] = route.id.split(" ");
      if (method === undefined || path === undefined) {
        throw new Error(`unreadable route id: ${route.id}`);
      }
      const operation = spec.paths[specPathOf(path)]?.[method.toLowerCase()];
      if (!operation) {
        missing.push(`${route.id} (absent from the spec)`);
        continue;
      }
      if (!Object.hasOwn(operation.responses ?? {}, "422"))
        missing.push(route.id);
    }
    expect(missing).toEqual([]);
  });
});
