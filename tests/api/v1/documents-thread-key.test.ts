import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { threadIdSchema } from "@/api/v1/documents.controller";

// `issued_documents.thread_id` is indexed together with the tenant, so Postgres refuses a value past
// the index row size with a 500 — for a field a REST caller typed, on a route that advertises
// validation. The key is three numeric ids, so the shape bounds the length instead of a second
// number guessing at it.
const ok = (v: string) => Value.Check(threadIdSchema, v);

describe("the issued-document thread key", () => {
  test("accepts what the runtime actually writes", () => {
    expect(ok("1:1:42")).toBe(true);
    expect(ok("9007199254740993:12:987654321")).toBe(true);
  });

  test("refuses anything that could not name a conversation", () => {
    expect(ok("")).toBe(false);
    expect(ok("1:1")).toBe(false);
    expect(ok("1:1:1:1")).toBe(false);
    expect(ok("a:b:c")).toBe(false);
    expect(ok("1:1:1 ")).toBe(false);
  });

  // The one the index actually breaks on.
  test("refuses a value long enough to break the index", () => {
    expect(ok(`1:1:${"9".repeat(5000)}`)).toBe(false);
  });
});
