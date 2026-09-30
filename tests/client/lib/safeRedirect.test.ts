import { describe, expect, test } from "bun:test";
import { resolveSafeRedirect } from "@/client/lib/safeRedirect";

const ORIGIN = "http://localhost:3210";

describe("resolveSafeRedirect", () => {
  test.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
  ])("returns null for %s", (_label, value) => {
    expect(resolveSafeRedirect(value, ORIGIN)).toBeNull();
  });

  test("accepts a plain internal path", () => {
    expect(resolveSafeRedirect("/t/42", ORIGIN)).toBe("/t/42");
  });

  test("preserves the query string and hash", () => {
    expect(resolveSafeRedirect("/t/42?tab=notes#comment-1", ORIGIN)).toBe(
      "/t/42?tab=notes#comment-1",
    );
  });

  test("rejects a value that does not start with /", () => {
    expect(resolveSafeRedirect("t/42", ORIGIN)).toBeNull();
  });

  // A naive `startsWith("/") && !startsWith("//")` check would let all of the
  // following through: the URL parser strips ASCII tab/newline from the whole
  // input and treats `\` as `/` for a special scheme, so each of these reads
  // as a single-leading-slash path but resolves to a different origin. Only
  // resolving with `new URL` and checking the resulting origin catches them.
  test.each([
    ["absolute URL", "https://evil.example"],
    ["protocol-relative", "//evil.example"],
    ["backslash treated as slash", "/\\evil.example"],
    ["tab then backslash", "/\t\\evil.example"],
    ["tab then double slash", "/\t/evil.example"],
    ["newline then backslash", "/\n\\evil.example"],
    ["leading backslash, no leading slash", "\\/evil.example"],
    ["backslash into a bracketed host", "/\\[::1]"],
  ])("rejects %s (%s)", (_label, value) => {
    expect(resolveSafeRedirect(value, ORIGIN)).toBeNull();
  });

  // Same-origin by the URL parser's own rules (the `..` segments resolve
  // against ORIGIN, never leaving it), but the surviving pathname itself
  // starts with `//` and reads as protocol-relative to whatever consumes it.
  test.each([
    ["one .. segment", "/a/..//evil.example"],
    ["two .. segments", "/a/../..//evil.example"],
    ["dot then .. segment", "/./..//evil.example"],
    ["percent-encoded .. segment", "/%2e%2e//evil.example"],
    ["normalizes to just //", "/a/..//"],
  ])(
    "rejects a same-origin value that normalizes to // (%s)",
    (_label, value) => {
      expect(resolveSafeRedirect(value, ORIGIN)).toBeNull();
    },
  );

  test("rejects a value whose origin differs by port", () => {
    expect(
      resolveSafeRedirect("http://localhost:9999/t/42", ORIGIN),
    ).toBeNull();
  });
});
