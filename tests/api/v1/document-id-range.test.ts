import { describe, expect, test } from "bun:test";
import { documentTemplatesController } from "@/api/v1/document-templates.controller";
import { documentsController } from "@/api/v1/documents.controller";
import { MAX_DB_ID, parseDbId, requireDbId } from "@/lib/db-id";
import { AppError } from "@/lib/errors";
import { parseMcpId } from "@/modules/mcp/write";

// `BigInt` is arbitrary precision and a database id is not. A value past 2^63-1 passes a digits-only
// check, converts happily, and is then refused by POSTGRES when the query binds it, so a plainly
// malformed field answers 500 on a path whose whole job was to say 400 or 404.

describe("requireDbId", () => {
  test("takes the largest id a column can hold, and refuses the next one", () => {
    expect(requireDbId(MAX_DB_ID.toString())).toBe(MAX_DB_ID);
    expect(() => requireDbId((MAX_DB_ID + 1n).toString())).toThrow(AppError);
  });

  test("refuses the spellings BigInt would accept", () => {
    for (const raw of ["", " 7 ", "+7", "0x7", "1e3", "abc"]) {
      expect(() => requireDbId(raw)).toThrow(AppError);
    }
  });

  test("answers 400, not 500", () => {
    try {
      requireDbId("9223372036854775808");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as AppError).statusCode).toBe(400);
    }
  });
});

// The MCP tools take ids as strings too, and they reach the same columns.
describe("parseMcpId", () => {
  test("refuses an id no column can hold", () => {
    expect(parseMcpId(MAX_DB_ID.toString(), "template id")).toBe(MAX_DB_ID);
    const past = parseMcpId((MAX_DB_ID + 1n).toString(), "template id");
    expect(typeof past === "bigint").toBe(false);
  });
});

// Every caller-supplied id in the document surfaces goes through the bounded parse. That lint
// rule is biome-plugins/no-bigint-cast.grit, over ALL of `src`: a list of files appended to per
// feature is a guard that misses the next entry.

// The other half of the same defect: a route can use the bounded parse and still LIE about it.
// `requireDbId` answers 400, and a `response` declaration that omits 400 publishes an OpenAPI
// contract the route does not keep, so a generated client meets an unhandled status. Read from the
// route table the controllers register, which is what openapi.json and the Eden types are built from.
describe("a route that takes a row id says 400 in its contract", () => {
  // The fields in these two controllers that carry a row id, wherever the caller puts them.
  const ID_FIELDS = new Set(["id", "templateId", "conversationId"]);

  interface RouteEntry {
    method: string;
    path: string;
    hooks?: Partial<
      Record<
        "params" | "query" | "body" | "response",
        { properties?: Record<string, unknown> } & Record<string, unknown>
      >
    >;
  }

  const routes = [
    ...documentsController.routes,
    ...documentTemplatesController.routes,
  ] as unknown as RouteEntry[];

  const idFieldsOf = (route: RouteEntry): string[] =>
    (["params", "query", "body"] as const).flatMap((where) =>
      Object.keys(route.hooks?.[where]?.properties ?? {})
        .filter((key) => ID_FIELDS.has(key))
        .map((key) => `${where}.${key}`),
    );

  test("every route with an id in its params, query or body declares 400", () => {
    const offenders = routes
      .filter((route) => idFieldsOf(route).length > 0)
      .filter((route) => !("400" in (route.hooks?.response ?? {})))
      .map((route) => `${route.method} ${route.path}`);
    expect(offenders).toEqual([]);
  });

  // The ids outside the path are the ones tests/api/v1/route-id-refusal.test.ts does not see, so
  // they are named here: a schema rename that hid them would leave the test above measuring nothing.
  test("it sees the ids that travel in a query or a body", () => {
    const outsideThePath = routes
      .flatMap((route) =>
        idFieldsOf(route)
          .filter((field) => !field.startsWith("params."))
          .map((field) => `${route.method} ${route.path} ${field}`),
      )
      .sort();
    expect(outsideThePath).toEqual([
      "GET /v1/documents/ query.templateId",
      "POST /v1/document-templates/preview body.id",
      "POST /v1/documents/ body.conversationId",
      "POST /v1/documents/ body.templateId",
    ]);
  });
});

// The routes share the repo's one bounded parse, not a copy of it.
test("requireDbId and parseDbId answer the same question", () => {
  expect(parseDbId("17")).toBe(17n);
  expect(requireDbId("17")).toBe(17n);
});
