import { describe, expect, test } from "bun:test";
import { AppError } from "@/lib/errors";
import { assertUsableCount, badQueryParam } from "@/lib/query-param";

// The RANGE half of issue #372, kept beside the services rather than in the query parser: MCP and
// the console's own service calls reach these functions without a query string, so a check that
// lived only in the parser would hold REST to a rule nothing else obeys.

describe("assertUsableCount", () => {
  const REFUSED = [0, -1, -5, 1.5, 3.5, Number.NaN, Number.POSITIVE_INFINITY];
  for (const value of REFUSED) {
    test(`${value} is refused, naming the parameter`, () => {
      let err: unknown = null;
      try {
        assertUsableCount(value, "limit");
      } catch (e) {
        err = e;
      }
      expect(`${value}: ${err === null ? "accepted" : "refused"}`).toBe(
        `${value}: refused`,
      );
      expect((err as AppError).statusCode).toBe(400);
      expect((err as AppError).field).toBe("limit");
    });
  }

  test("zero is refused rather than clamped to the default", () => {
    // The clamps this replaces answered `limit=0` with the default page — a different question
    // than the one asked, and indistinguishable by the client from having asked for it.
    expect(() => assertUsableCount(0, "limit")).toThrow(AppError);
  });

  test("absent is not a value, and a positive integer survives", () => {
    expect(() => assertUsableCount(undefined, "limit")).not.toThrow();
    expect(() => assertUsableCount(1, "limit")).not.toThrow();
    expect(() => assertUsableCount(200, "limit")).not.toThrow();
  });
});

describe("assertUsableCount still owns the range a parser cannot see", () => {
  test("a value that never passed through a query string is still bounded", () => {
    // MCP hands the service a plain number. `parseQueryCount`'s regex never runs on this path, so
    // the two halves are not redundant: delete either and one transport stops being held.
    expect(() => assertUsableCount(0, "limit")).toThrow(AppError);
    expect(() => assertUsableCount(-1, "limit")).toThrow(AppError);
    expect(() => assertUsableCount(3.5, "limit")).toThrow(AppError);
    expect(() => assertUsableCount(1, "limit")).not.toThrow();
  });
});

describe("badQueryParam", () => {
  test("carries the 400, the field, and the translation key the API localizes", () => {
    let err: unknown = null;
    try {
      badQueryParam("cursor");
    } catch (e) {
      err = e;
    }
    const e = err as AppError;
    expect(e.statusCode).toBe(400);
    expect(e.field).toBe("cursor");
    expect(e.translationKey).toBe("errors.invalidQueryParam");
    expect(e.translationParams).toEqual({ param: "cursor" });
  });
});
