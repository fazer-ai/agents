import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { authPlugin } from "@/api/lib/auth";
import {
  type MockUserEntity,
  mockFindUnique,
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

// A request without a session is told to sign in before anything about its input. Elysia validates
// the query and the body before `beforeHandle`, where the gates answer, so without the refusal in
// `src/app.ts` a malformed input would get a 422 that tells the caller what the route accepts.
// Swept over every route behind a session gate, through the real app.

setupPrismaMock();

const app = (await import("@/app")).default;

const admin: MockUserEntity = { ...mockUser, role: "TENANT_ADMIN" };
mockFindUnique.mockImplementation(() => Promise.resolve(admin));
const tokenApp = new Elysia()
  .use(authPlugin)
  .post("/mint", async ({ setAuthCookie }) => ({
    token: await setAuthCookie(admin, admin.passwordHash),
  }));
const { token } = (await (
  await tokenApp.handle(
    new Request("http://localhost/mint", { method: "POST" }),
  )
).json()) as { token: string };

const BunReq = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

type Schema = { properties?: Record<string, unknown> } | undefined;
type Route = {
  method: string;
  path: string;
  hooks: { beforeHandle?: unknown[]; query?: Schema; body?: Schema };
};

// A route is gated when one of the session gates (`requireAuth`, `requireRole`, `requireAdmin`)
// sits in its `beforeHandle`; all three answer `errors.unauthorized`. Read off the route rather
// than off what it answers, so a gate that stops answering 401 is still swept, and fails.
const sourceOf = (hook: unknown) =>
  String((hook as { fn?: unknown } | null)?.fn ?? hook);
const gated = (app as unknown as { routes: Route[] }).routes.filter(
  (r) =>
    r.path.startsWith("/api/") &&
    r.method !== "WS" &&
    (r.hooks.beforeHandle ?? []).some((h) =>
      sourceOf(h).includes("errors.unauthorized"),
    ),
);

const UNAUTHORIZED = '{"error":"Unauthorized"}';

function urlOf(path: string, query?: Record<string, string>): string {
  const url = new URL(`http://localhost${path.replace(/:\w+/g, "1")}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

function bare({ method, path }: Route): Request {
  return new Request(urlOf(path), { method });
}

function malformed({ method, path, hooks }: Route): Request {
  const query = Object.fromEntries(
    Object.keys(hooks.query?.properties ?? {}).map((k) => [k, "%%not-valid%%"]),
  );
  const body = hooks.body ? JSON.stringify({ notAField: 42 }) : null;
  return new Request(urlOf(path, query), {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body,
  });
}

describe("a request without a session", () => {
  test("the sweep covers each gate, on routes that validate their input", () => {
    expect(gated.length).toBeGreaterThan(200);
    for (const [method, path] of [
      ["GET", "/api/v1/documents/"],
      ["PUT", "/api/v1/tenant-settings/spend-ceiling"],
      ["PATCH", "/api/admin/users/:id/role"],
      ["PATCH", "/api/auth/me"],
    ]) {
      expect(gated.some((r) => r.method === method && r.path === path)).toBe(
        true,
      );
    }
  });

  test("answers 401 on every gated route, with no input and with a malformed one", async () => {
    const wrong: string[] = [];
    for (const route of gated) {
      for (const [kind, request] of [
        ["bare", bare(route)],
        ["malformed", malformed(route)],
      ] as const) {
        const res = await app.handle(request);
        const body = await res.text();
        if (res.status !== 401 || body !== UNAUTHORIZED) {
          wrong.push(
            `${kind} ${route.method} ${route.path}: ${res.status} ${body}`,
          );
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("a request with a session", () => {
  // The tenancy boundary and the gate both need the user, and they share one lookup.
  test("is looked up once for the tenancy boundary and the gate together", async () => {
    mockFindUnique.mockClear();
    await app.handle(
      new BunReq(
        "http://localhost/api/v1/tenant-settings/spend-ceiling/usage",
        { headers: { cookie: `fazerai_auth_token=${token}` } },
      ),
    );
    expect(mockFindUnique).toHaveBeenCalledTimes(1);
  });

  test("still has its malformed input refused", async () => {
    const res = await app.handle(
      new BunReq("http://localhost/api/v1/documents?before=abc", {
        headers: { cookie: `fazerai_auth_token=${token}` },
      }),
    );
    expect(res.status).toBe(422);
  });
});
