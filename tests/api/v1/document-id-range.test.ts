import { describe, expect, test } from "bun:test";
import { MAX_DB_ID, parseDbId, requireDbId } from "@/lib/db-id";
import { AppError } from "@/lib/errors";
import { parseMcpId } from "@/modules/mcp/write";

// `BigInt` is arbitrary precision and a database id is not. A value past 2^63-1 passes a digits-only
// check, converts happily, and is then refused by POSTGRES when the query binds it — so a plainly
// malformed field answers 500 on a path whose whole job was to say 400 or 404.
//
// A SWEEP rather than one example per route, because the defect is in the spelling people reach for
// (`BigInt(params.id)`) and the next route added will reach for it too. The per-route behaviour is
// pinned below it, so the sweep cannot pass by measuring nothing.

// The HTTP routes, which have a response contract to keep, and the writes that reach the same
// columns without one. Split because only the first half can be asked about its declared statuses,
// and kept in one place because both sweeps below have to grow together.
const API_FILES = [
  "src/api/v1/documents.controller.ts",
  "src/api/v1/document-templates.controller.ts",
];
const NON_ROUTE_FILES = [
  "src/modules/mcp/write.ts",
  "src/modules/mcp/write-documents.ts",
  "src/modules/agents/service.ts",
];

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

// Every caller-supplied id in the document surfaces goes through the bounded parse. Written as a
// read of the source because that is where the mistake is visible: a `BigInt(...)` wrapped around a
// request field is the defect, whatever the route around it does.
describe("no document surface converts a caller's id with bare BigInt", () => {
  // Every FILE that turns a caller-supplied id into a bigint on the way to a document. The list grew
  // by one entry per review round — the routes, then the MCP write parser, then the grant parser —
  // because each round fixed the site it was shown and left the next one. It is the list, not the
  // sites, that is the guard: an entry here is what makes the NEXT surface fail loudly instead of
  // being found by a reviewer.
  const FILES = [...API_FILES, ...NON_ROUTE_FILES];

  test("params, body, query and args ids use the bounded parse", async () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const src = await Bun.file(file).text();
      for (const m of src.matchAll(
        /BigInt\(\s*(?:params|body|query|args|patch|input|g)\.[A-Za-z0-9_.]+/g,
      )) {
        offenders.push(`${file}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // …and the sweep is looking at something: every prefix it hunts is one it can find.
  test("the sweep would catch the spellings it exists for", () => {
    const samples = [
      "const id = BigInt(params.id);",
      "BigInt( args.tenant_id )",
      "BigInt(patch.name)",
      "const x = BigInt(g.documentTemplateId);",
    ];
    for (const sample of samples) {
      expect(
        [
          ...sample.matchAll(
            /BigInt\(\s*(?:params|body|query|args|patch|input|g)\.[A-Za-z0-9_.]+/g,
          ),
        ].length,
      ).toBe(1);
    }
  });
});

// The other half of the same defect, and it took a review round to see: a route can use the bounded
// parse and still LIE about it. `requireDbId` answers 400, and a `response` declaration that omits
// 400 leaves the generated OpenAPI contract advertising a set of statuses the route does not keep —
// so a generated client meets an unhandled one on a plainly malformed id.
//
// Swept across both controllers rather than fixed on the route that was found, because the omission
// is invisible at the call site: the parse is in the handler and the declaration is in the options
// object below it, and nothing ties them together.
describe("a route that can answer 400 says so in its contract", () => {
  const ROUTE = /\n {2}\.(get|post|patch|put|delete)\(/g;

  async function routesOf(file: string) {
    const src = await Bun.file(file).text();
    const cuts = [...src.matchAll(ROUTE)].map((m) => m.index as number);
    return cuts.map((start, i) => {
      const body = src.slice(start, cuts[i + 1] ?? src.length);
      return { path: body.match(/"([^"]*)"/)?.[1] ?? "?", body };
    });
  }

  test("every route reaching the bounded parse declares 400", async () => {
    const offenders: string[] = [];
    for (const file of API_FILES) {
      for (const route of await routesOf(file)) {
        if (!/requireDbId|parseDbId/.test(route.body)) continue;
        const declared = route.body.match(/response:\s*errors\(([^)]*)\)/);
        if (!declared?.[1]?.includes("400")) {
          offenders.push(`${file} ${route.path}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // …and the sweep is looking at something. Without this it passes just as well when the split finds
  // no routes at all, which is exactly how a source-reading check goes quietly blind.
  test("it finds the routes it is meant to read", async () => {
    const routes = await routesOf("src/api/v1/documents.controller.ts");
    expect(routes.length).toBeGreaterThan(3);
    expect(
      routes.filter((r) => /requireDbId/.test(r.body)).length,
    ).toBeGreaterThan(2);
  });
});

// The parse the routes now share is the one the rest of the repo already had.
test("requireDbId and parseDbId answer the same question", () => {
  expect(parseDbId("17")).toBe(17n);
  expect(requireDbId("17")).toBe(17n);
});
