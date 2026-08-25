import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { authPlugin } from "@/api/lib/auth";
import { businessHoursCreateSchema } from "@/modules/business-hours/service";
import { mcpConnectionCreateSchema } from "@/modules/mcp-connections/service";
import { toolDefinitionCreateSchema } from "@/modules/tool-definitions/service";
import {
  mockFindUnique,
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

// Issue #301. Three create routes declared the body schema their PATCH sibling uses, where every
// field being optional is correct. A request missing a required field therefore passed the transport
// and was refused by the service's zod schema instead, and src/app.ts had no branch for a `ZodError`:
// it fell to the generic 500, so the caller was told the server broke about a field they own, and
// the zod issue array — submitted values included — went to the error log.
//
// Measured on main before this change, body `{}`: 500 `Something went wrong` on all three, while the
// ten other v1 write routes (which declare their required fields at the transport) answered 422. The
// same 500 answered a value the service refuses but the transport accepts: `POST /v1/tools` with a
// name carrying a space, `POST /v1/business-hours` with `name: ""`.
const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

setupPrismaMock();
const app = (await import("@/app")).default;

const admin = { ...mockUser, tenantId: 1n, role: "TENANT_ADMIN" as const };
mockFindUnique.mockImplementation(() => Promise.resolve(admin));
const tokenApp = new Elysia()
  .use(authPlugin)
  .post("/mint", async ({ setAuthCookie }) => ({
    token: await setAuthCookie(admin),
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

// The schema the ROUTE declares, read off the built app rather than off the exported const: what the
// defect was is that a route pointed at the wrong one of two schemas, and an assertion about the
// const cannot see which one a route uses.
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
// refuses. It has to answer the same status as the row above — one mistake answering 422 or 500
// depending on which layer noticed it is the thing being removed.
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

// Why the routes were split rather than left to the `ZodError` branch alone, which already answers
// 422 for both rows above: the PUBLISHED contract said every field of a create body was optional,
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
      // …and the PATCH keeps the all-optional schema, which is what made sharing one object with the
      // POST look right in the first place.
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

// The field a sub-value refusal names, which review on PR #309 caught the first spelling getting
// wrong: zod's path is relative to what was handed to the parse, so a service that parses one member
// of the request reported `0.weight` for a bad variant, and a lone token reported no field at all.
// Both name something no input on the caller's side answers to.

// The argument text of a call, read by matching parentheses so a nested call cannot end it early.
function balancedArgs(source: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < source.length; i++) {
    const c = source[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return source.slice(openParen + 1, i);
    }
  }
  return "";
}

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

  // The call sites, read from the source with the whitespace taken out so the assertion is about the
  // arguments and not about how the formatter broke the line.
  test("the two call sites that parse a sub-value pass one", async () => {
    // EVERY call that parses that sub-value, not "the file mentions one somewhere": experiments
    // parses `params.variants` at two call sites, and a per-file assertion is satisfied by whichever
    // one still carries the prefix — the same shape of hole #258 measured.
    for (const [file, value] of [
      ["src/modules/experiments/service.ts", "params.variants"],
      ["src/modules/chatwoot/management.ts", "adminToken"],
    ] as const) {
      const dense = (await Bun.file(file).text()).replace(/\s+/g, "");
      const calls = [...dense.matchAll(/parseInput\(/g)].map((m) =>
        balancedArgs(dense, (m.index ?? 0) + "parseInput(".length - 1),
      );
      const subValue = calls.filter((c) => c.includes(`,${value}`));
      expect([file, subValue.length > 0]).toEqual([file, true]);
      for (const c of subValue) {
        expect([file, c, /,"[^"]+",?$/.test(c)]).toEqual([file, c, true]);
      }
    }
  });
});

// The issue path goes on the wire, and a path segment is a name the SERVER chose only, and a path segment is a name the SERVER chose only
// while no zod record constrains its value type: a `z.record(z.string(), z.unknown())` cannot fail
// below itself, so no issue can carry a key the caller wrote. That holds for every record in src/
// today, and it is the same hazard the transport's own refusal walks the schema to avoid
// (api/lib/schema-refusal.ts), so it is pinned rather than left as a reading.
export function recordConstrainsItsValues(source: string): boolean {
  // Written as "read the value expression and compare it" rather than as a negative lookahead: with
  // `\s*` before the lookahead the regex backtracks over the whitespace and matches anyway, which is
  // what the control below caught the first time this was written.
  for (const m of source.matchAll(
    /z\.record\(\s*z\.string\(\)\s*,([\s\S]{0,24})/g,
  )) {
    if (!(m[1] ?? "").trimStart().startsWith("z.unknown()")) return true;
  }
  return false;
}

describe("no zod record can put a caller's key in a refusal", () => {
  test("the predicate separates a constrained record from a free-form one", () => {
    expect(recordConstrainsItsValues("z.record(z.string(), z.string())")).toBe(
      true,
    );
    expect(recordConstrainsItsValues("z.record(z.string(), z.unknown())")).toBe(
      false,
    );
    expect(
      recordConstrainsItsValues(
        "z.record(\n    z.string(),\n    z.number(),\n  )",
      ),
    ).toBe(true);
  });

  test("no file under src declares one", async () => {
    const { Glob } = await import("bun");
    const offenders: string[] = [];
    for await (const rel of new Glob("**/*.ts").scan("src")) {
      if (recordConstrainsItsValues(await Bun.file(`src/${rel}`).text())) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// Where the refusal is RAISED, which is the half review found on PR #309: a global "a ZodError means
// the caller sent something wrong" branch also caught a ZodError the MCP SDK rejects with when a
// remote server answers a malformed result (tests/api/v1/upstream-zod-error.test.ts pins that one).
// So the 422 is raised where the input is known to be the caller's — `parseInput` — and every other
// zod parse in service code has to say, at the call site, why it is not that.
//
// Keyed on the CALL SITE and not on the file: an exemption attached to a file adopts the next parse
// written into it, which is the exact failure #258 measured.
export function unmarkedServiceParse(source: string): string[] {
  const lines = source.split("\n");
  const offenders: string[] = [];
  for (const [i, line] of lines.entries()) {
    // Keyed on `.parse(` itself and not on what precedes it: a chained schema
    // (`z.string().min(1).parse(x)`) and a multiline chain whose line begins with `.parse(` both put
    // a `)` or a line start there, and the first spelling of this predicate matched neither — so the
    // sweep reported a clean tree while the exact shape this PR converted could be written back in.
    // Found by review on PR #309.
    if (!line.includes(".parse(")) continue;
    if (
      /JSON\.parse|Number\.parse|Date\.parse|\.parseAsync|safeParse/.test(line)
    ) {
      continue;
    }
    const marked =
      /not-caller-input:/.test(line) ||
      /not-caller-input:/.test(lines[i - 1] ?? "");
    if (!marked) offenders.push(line.trim());
  }
  return offenders;
}

describe("a zod parse of caller input goes through parseInput", () => {
  test("the predicate sees an unmarked parse and not a marked one", () => {
    expect(
      unmarkedServiceParse("  const d = someSchema.parse(input);"),
    ).toEqual(["const d = someSchema.parse(input);"]);
    expect(
      unmarkedServiceParse(
        "  // not-caller-input: a stored row\n  const d = someSchema.parse(row);",
      ),
    ).toEqual([]);
    // The two shapes the first spelling of this predicate missed, and the reason they are controls
    // rather than a sentence: in both the character before `.parse` is a `)` or a line start, so a
    // predicate anchored on the identifier before it reported a clean tree while the exact call this
    // PR converted (`z.string().min(1).max(2000).parse(adminToken)`) could be written straight back.
    expect(
      unmarkedServiceParse("  const t = z.string().min(1).parse(token);"),
    ).toEqual(["const t = z.string().min(1).parse(token);"]);
    expect(
      unmarkedServiceParse(
        "  const v = z\n    .array(itemSchema)\n    .parse(value);",
      ),
    ).toEqual([".parse(value);"]);
    // The shapes that are not a zod parse at all, and the helper itself.
    expect(unmarkedServiceParse("  const x = JSON.parse(raw);")).toEqual([]);
    expect(
      unmarkedServiceParse("  const d = parseInput(someSchema, input);"),
    ).toEqual([]);
    expect(
      unmarkedServiceParse("  const d = someSchema.safeParse(input);"),
    ).toEqual([]);
  });

  test("no service file parses caller input outside it", async () => {
    const { Glob } = await import("bun");
    const offenders: string[] = [];
    let scanned = 0;
    for (const dir of ["src/modules", "src/api"]) {
      for await (const rel of new Glob("**/*.ts").scan(dir)) {
        const file = `${dir}/${rel}`;
        if (file === "src/lib/parse-input.ts") continue;
        scanned++;
        for (const line of unmarkedServiceParse(await Bun.file(file).text())) {
          offenders.push(`${file}: ${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // …and the sweep is looking at something.
    expect(scanned).toBeGreaterThanOrEqual(50);
  });
});
