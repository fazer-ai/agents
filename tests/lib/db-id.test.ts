import { describe, expect, test } from "bun:test";
import { MAX_DB_ID, optionalDbId, parseDbId } from "@/lib/db-id";
import { AppError } from "@/lib/errors";

// Decision table for "is this caller-supplied string a database id?". The row that matters is the
// last group: those parse as BigInt and are refused by Postgres at BIND time instead, which turns a
// malformed field into a 500 on a path that meant to answer "no such row".
describe("parseDbId", () => {
  test("accepts a plain decimal id", () => {
    expect(parseDbId("1")).toBe(1n);
    expect(parseDbId("42")).toBe(42n);
    expect(parseDbId("0")).toBe(0n);
  });

  test("accepts the largest value the column holds, and nothing above it", () => {
    expect(parseDbId(MAX_DB_ID.toString())).toBe(MAX_DB_ID);
    expect(parseDbId((MAX_DB_ID + 1n).toString())).toBeNull();
    expect(parseDbId("99999999999999999999")).toBeNull();
  });

  test("refuses the spellings BigInt accepts and a column does not", () => {
    // Every one of these is a valid BigInt() argument.
    for (const raw of ["0x7", "+7", " 7 ", "7n", "1e3", "0b11", "0o7"]) {
      expect(parseDbId(raw)).toBeNull();
    }
  });

  test("refuses what is plainly not an id", () => {
    for (const raw of ["", "abc", "-1", "1.0", "../etc", null, undefined]) {
      expect(parseDbId(raw)).toBeNull();
    }
  });
});

// Decision table for the same string when it arrives in a BODY, where "no id" has two spellings and
// they instruct different things: an absent key leaves the column alone, an explicit `null` detaches
// it. Four controllers wrote that three-way by hand and no two wrote it the same, which is how an
// empty string became `BigInt("")` — `0n`, a row nobody named. Issue #407.
describe("optionalDbId", () => {
  test("absent and null are kept apart, and neither is a refusal", () => {
    expect(optionalDbId(undefined, "agentId")).toBeUndefined();
    expect(optionalDbId(null, "agentId")).toBeNull();
  });

  test("a well-formed id parses", () => {
    expect(optionalDbId("7", "agentId")).toBe(7n);
    expect(optionalDbId(MAX_DB_ID.toString(), "agentId")).toBe(MAX_DB_ID);
  });

  test("an empty string is neither spelling of absent, and is refused", () => {
    expect(() => optionalDbId("", "agentId")).toThrow(AppError);
  });

  test("everything parseDbId refuses is refused here, naming the body field", () => {
    for (const raw of [
      "abc",
      "0x11",
      "+7",
      " 7 ",
      "1e3",
      "-7",
      (MAX_DB_ID + 1n).toString(),
    ]) {
      try {
        optionalDbId(raw, "businessHoursId");
        throw new Error(`accepted ${JSON.stringify(raw)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).statusCode).toBe(400);
        expect((e as AppError).translationParams).toEqual({
          label: "businessHoursId",
        });
      }
    }
  });
});
