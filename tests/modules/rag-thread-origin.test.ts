import { describe, expect, test } from "bun:test";
import { MAX_DB_ID } from "@/lib/db-id";
import { parseThreadOrigin } from "@/modules/rag/service";

// Which row a stored thread key names, and when it names none.
//
// The key is written from a request body (`threadId` on the playground routes, carried into the
// approval row by `createSuggestion`) and read back here when the pending list is rendered. That
// round trip is what makes this a caller's id rather than an internal one: the `try`/`catch` this
// replaced caught `BigInt("abc")` and did not catch `BigInt("99999999999999999999")`, which
// converts — so one accepted suggestion could make every later read of the list answer 500. The
// list is a decision table because the two shapes are told apart by ARITY and by one segment, and
// a key that matches neither has to fall through rather than be guessed at. Issue #407.
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
