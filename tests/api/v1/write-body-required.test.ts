import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { authPlugin } from "@/api/lib/auth";
import { businessHoursCreateSchema } from "@/modules/business-hours/service";
import { codeToolCreateSchema } from "@/modules/code-tools/service";
import { mcpConnectionCreateSchema } from "@/modules/mcp-connections/service";
import { toolDefinitionCreateSchema } from "@/modules/tool-definitions/service";
import {
  mockFindUnique,
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

// A create route declares its own body schema with its required fields, not the all-optional one
// its PATCH sibling uses: otherwise a request missing a required field passes the transport and is
// refused one layer later by the service's zod schema, under a contract that calls it optional.
//
// A value the service refuses but the transport accepts (`POST /v1/tools` with a name carrying a
// space, `POST /v1/business-hours` with `name: ""`) answers the same 422, never the generic 500 that
// tells the caller the server broke and logs the zod issue array, submitted values included.
const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

setupPrismaMock();
const app = (await import("@/app")).default;

const admin = { ...mockUser, tenantId: 1n, role: "TENANT_ADMIN" as const };
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

async function post(path: string, payload: unknown): Promise<Response> {
  return app.handle(
    new BunRequest(`http://localhost/api${path}`, {
      method: "POST",
      headers: {
        cookie: `fazerai_auth_token=${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    }),
  );
}

// The schema the ROUTE declares, read off the built app rather than off the exported const: a route
// can point at the wrong one of two schemas, and an assertion about the const cannot see which.
function routeBody(
  method: string,
  path: string,
): { required?: string[]; properties: Record<string, unknown> } | undefined {
  const routes = (
    app as unknown as {
      routes: Array<{
        method: string;
        path: string;
        hooks?: { body?: unknown };
      }>;
    }
  ).routes;
  const found = routes.find((r) => r.method === method && r.path === path);
  return found?.hooks?.body as
    | { required?: string[]; properties: Record<string, unknown> }
    | undefined;
}

function requiredInZod(schema: {
  shape: Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
}): string[] {
  return Object.entries(schema.shape)
    .filter(([, field]) => !field.safeParse(undefined).success)
    .map(([key]) => key)
    .sort();
}

const CONTROLLERS: Array<{
  name: string;
  path: string;
  routePath: string;
  patchPath: string;
  schema: unknown;
}> = [
  {
    name: "tools",
    path: "/v1/tools",
    routePath: "/api/v1/tools/",
    patchPath: "/api/v1/tools/:id",
    schema: toolDefinitionCreateSchema,
  },
  {
    name: "code-tools",
    path: "/v1/code-tools",
    routePath: "/api/v1/code-tools/",
    patchPath: "/api/v1/code-tools/:id",
    schema: codeToolCreateSchema,
  },
  {
    name: "business-hours",
    path: "/v1/business-hours",
    routePath: "/api/v1/business-hours/",
    patchPath: "/api/v1/business-hours/:id",
    schema: businessHoursCreateSchema,
  },
  {
    name: "mcp-connections",
    path: "/v1/mcp-connections",
    routePath: "/api/v1/mcp-connections/",
    patchPath: "/api/v1/mcp-connections/:id",
    schema: mcpConnectionCreateSchema,
  },
];

describe("a create route whose body is missing a required field", () => {
  for (const { name, path } of CONTROLLERS) {
    test(`${name} refuses it, naming the field`, async () => {
      const res = await post(path, {});
      const body = (await res.json()) as { error?: string; field?: string };
      expect({ name, status: res.status }).toEqual({ name, status: 422 });
      expect(typeof body.field).toBe("string");
    });
  }
});

// The same user error, one layer later: a value the transport accepts and the service's zod schema
// refuses answers the same status as the row above, whichever layer notices it.
describe("a create route carrying a value the service refuses", () => {
  const rows: Array<[string, unknown, string]> = [
    [
      "/v1/tools",
      {
        name: "has space",
        label: "L",
        urlTemplate: "https://x.test/a",
        allowedHosts: ["x.test"],
      },
      "name",
    ],
    // A nested path survives the crossing, which is what lets a console point at the input rather
    // than at the form: `allowedHosts` is `t.Array(t.String())` at the transport and
    // `z.string().min(1)` in the service, so an empty host reaches zod and comes back named.
    [
      "/v1/tools",
      {
        name: "probe_tool",
        label: "L",
        urlTemplate: "https://x.test/a",
        allowedHosts: [""],
      },
      "allowedHosts.0",
    ],
    ["/v1/business-hours", { name: "" }, "name"],
  ];

  for (const [path, payload, field] of rows) {
    test(`${path} (${field})`, async () => {
      const res = await post(path, payload);
      const body = (await res.json()) as { error?: string; field?: string };
      expect({ status: res.status, field: body.field }).toEqual({
        status: 422,
        field,
      });
    });
  }
});

// Each create route declares its own body even though the `ZodError` branch answers 422 for both
// rows above: the PUBLISHED contract would otherwise say every field of a create body is optional,
// which is not true of any of the three, and a generated client reading it has no way to know.
describe("the create route declares exactly what the service requires", () => {
  for (const { name, routePath, patchPath, schema } of CONTROLLERS) {
    test(name, () => {
      const create = routeBody("POST", routePath);
      const patch = routeBody("PATCH", patchPath);
      expect([name, create?.required?.slice().sort()]).toEqual([
        name,
        requiredInZod(schema as never),
      ]);
      // NOTE: …and the PATCH keeps the all-optional schema, correct for a partial update.
      expect([name, patch?.required]).toEqual([name, undefined]);
      // Composing the create body cannot lose a field: Elysia's `normalize` silently strips what the
      // schema does not declare, which is the regression the drift guard in tools-controller.test.ts
      // exists for.
      expect([name, Object.keys(create?.properties ?? {}).sort()]).toEqual([
        name,
        Object.keys(patch?.properties ?? {}).sort(),
      ]);
    });
  }

  test("the comparison can see a required set that drifted", () => {
    expect(["name"]).not.toEqual(
      requiredInZod(toolDefinitionCreateSchema as never),
    );
  });
});

// The field a sub-value refusal names: zod's path is relative to what was handed to the parse, so a
// service that parses one member of the request passes a prefix, or a bad variant reports
// `0.weight` and a lone token no field at all, names no input on the caller's side answers to.

describe("a refusal about a value inside the request names the whole path", () => {
  test("the prefix and the issue path are joined", async () => {
    const { parseInput } = await import("@/lib/parse-input");
    const { z } = await import("zod");
    const variants = z.array(z.object({ weight: z.number().nonnegative() }));
    const err = (() => {
      try {
        parseInput(variants, [{ weight: -1 }], "variants");
      } catch (e) {
        return e as { field?: string; statusCode?: number };
      }
    })();
    expect([err?.statusCode, err?.field]).toEqual([422, "variants.0.weight"]);
  });

  test("a scalar parsed on its own is named by the prefix alone", async () => {
    const { parseInput } = await import("@/lib/parse-input");
    const { z } = await import("zod");
    const err = (() => {
      try {
        parseInput(z.string().min(1), "", "adminToken");
      } catch (e) {
        return e as { field?: string };
      }
    })();
    // Without the prefix zod reports an empty path here, so the wire would carry no field at all.
    expect(err?.field).toBe("adminToken");
  });
});
