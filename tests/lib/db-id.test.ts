import { describe, expect, test } from "bun:test";
import { MAX_DB_ID, parseDbId } from "@/lib/db-id";

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
