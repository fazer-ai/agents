import { describe, expect, test } from "bun:test";
import { MAX_DB_ID } from "@/lib/db-id";
import { parseThreadOrigin } from "@/modules/rag/service";

// Which row a stored thread key names, and when it names none.
//
// The key is written from a request body (`threadId` on the playground routes, carried into the
// approval row by `createSuggestion`), so it is a caller's id: a `try`/`catch` around `BigInt` is
// not enough, since `BigInt("99999999999999999999")` converts and one accepted suggestion would make
// every later read of the pending list answer 500. The two shapes are told apart by ARITY and by one
// segment, and a key that matches neither falls through rather than being guessed at.
describe("parseThreadOrigin", () => {
  test("a playground key carries the agent id", () => {
    expect(parseThreadOrigin("1:playground:7:abc-uuid")).toEqual({
      kind: "playground",
      agentId: 7n,
    });
  });

  test("a conversation key carries the instance id and the display id", () => {
    expect(parseThreadOrigin("1:42:9")).toEqual({
      kind: "conversation",
      instanceId: 42n,
      displayId: 9,
    });
  });

  test("no key, and a key of the wrong shape, have no origin", () => {
    for (const raw of [null, "", "1", "1:2", "1:2:3:4:5", "1:playground:7"]) {
      expect(parseThreadOrigin(raw)).toBeNull();
    }
  });

  // The row this file exists for. Each of these converts under `BigInt`, so the `catch` never ran:
  // the first two reached Postgres as a bind error, and the rest named a DIFFERENT row than the
  // segment spells.
  test("a segment BigInt would convert but a column would not has no origin", () => {
    const past = (MAX_DB_ID + 1n).toString();
    expect(parseThreadOrigin(`1:playground:${past}:u`)).toBeNull();
    expect(parseThreadOrigin(`1:${past}:9`)).toBeNull();
    for (const raw of ["0x11", "+7", " 7 ", "1e3"]) {
      expect(parseThreadOrigin(`1:playground:${raw}:u`)).toBeNull();
      expect(parseThreadOrigin(`1:${raw}:9`)).toBeNull();
    }
  });

  // The control: the largest id a column holds is still an id, so the bound above is a bound and
  // not an off-by-one that rejects the last real row.
  test("the largest id the column holds is still an origin", () => {
    expect(parseThreadOrigin(`1:playground:${MAX_DB_ID}:u`)).toEqual({
      kind: "playground",
      agentId: MAX_DB_ID,
    });
  });
});
