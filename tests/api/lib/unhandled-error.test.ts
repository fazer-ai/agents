import { describe, expect, test } from "bun:test";
import {
  ElysiaCustomStatusResponse,
  InvalidCookieSignature,
  InvalidFileType,
  ParseError,
  t,
  ValidationError,
} from "elysia";
import { errorDetail, isFrameworkRefusal } from "@/api/lib/unhandled-error";

// The policy behind src/app.ts's 500, as a table. The wiring — that the handler actually consults
// it, and what the client receives — is asserted over the real app in tests/api/refusal-wire.test.ts;
// a table alone would prove the function and say nothing about the route.

describe("isFrameworkRefusal", () => {
  // Kept: each IS a refusal Elysia raised, and already answers with its own status and a body that
  // is correct for the caller. Redacting them would replace a usable refusal with a blank 500.
  test("a ParseError keeps its own answer", () => {
    expect(isFrameworkRefusal(new ParseError())).toBe(true);
  });

  test("a ValidationError keeps its own answer", () => {
    expect(
      isFrameworkRefusal(
        new ValidationError("body", t.Object({ a: t.String() }), {}),
      ),
    ).toBe(true);
  });

  test("a status the handler chose keeps its own answer", () => {
    expect(
      isFrameworkRefusal(new ElysiaCustomStatusResponse(418, "teapot")),
    ).toBe(true);
  });

  // NOTE: these two complete Elysia's set of refusal types, and NEITHER is reachable from a route
  // in this app today — nothing configures `cookie: { secrets }` (without a secret Elysia never
  // verifies a signature, so it never raises the first) and no `t.File` constrains `type` (the one
  // place that cared says so in a comment, because the check sniffs magic bytes). They are asserted
  // here rather than over the wire for exactly that reason: the wire cannot produce them yet.
  //
  // Kept in the predicate anyway, and the reason is this PR's whole lesson. What kept leaking was a
  // list of thrown things that was short by construction; a list trimmed to "the refusals this app
  // happens to trigger today" is the same mistake pointed the other way, and it goes stale the day
  // someone signs a cookie. Elysia's exported refusal types are a fixed, enumerable API, so the
  // predicate enumerates all of them. Dropping either fails CLOSED (a legitimate 401 or 422 would
  // become a generic 500), so this is about answering correctly, not about a leak.
  test("an invalid cookie signature keeps its own answer", () => {
    expect(isFrameworkRefusal(new InvalidCookieSignature("session"))).toBe(
      true,
    );
  });

  test("a rejected file type keeps its own answer", () => {
    expect(isFrameworkRefusal(new InvalidFileType("file", "image/png"))).toBe(
      true,
    );
  });

  // Redacted: an unhandled failure, whatever it calls itself.
  test("a plain Error is an unhandled failure", () => {
    expect(isFrameworkRefusal(new Error("boom"))).toBe(false);
  });

  // The whole point of keying on identity. Every one of these carries a `code` that a rule written
  // over `code` read as something it is not — the string half (Prisma, Node) and the numeric half
  // (DOMException, and anything that assigns a number).
  test.each([
    [
      "a Prisma-style code",
      Object.assign(new Error("boom"), { code: "P2025" }),
    ],
    ["a Node errno code", Object.assign(new Error("boom"), { code: "EACCES" })],
    ["a numeric code", Object.assign(new Error("boom"), { code: 23 })],
    ["a DOMException", new DOMException("boom", "DataCloneError")],
    [
      "an error calling itself PARSE",
      Object.assign(new Error("boom"), { code: "PARSE" }),
    ],
    [
      "an error calling itself VALIDATION",
      Object.assign(new Error("boom"), { code: "VALIDATION" }),
    ],
  ])("%s is still an unhandled failure", (_name, error) => {
    expect(isFrameworkRefusal(error)).toBe(false);
  });

  // A thrown primitive is not a refusal either.
  test.each([["boom"], [42], [null], [undefined]])(
    "a thrown %p is an unhandled failure",
    (thrown) => {
      expect(isFrameworkRefusal(thrown)).toBe(false);
    },
  );
});

describe("errorDetail", () => {
  test("an Error gives its stack", () => {
    const e = new Error("boom");
    expect(errorDetail(e)).toBe(e.stack ?? "boom");
  });

  test("an Error with no stack falls back to the message", () => {
    const e = new Error("boom");
    e.stack = undefined;
    expect(errorDetail(e)).toBe("boom");
  });

  // The regression: `throw "boom"` reaches the handler as the string, and reading .stack ?? .message
  // off it made the development response the literal "undefined".
  test.each([
    ["boom", "boom"],
    [42, "42"],
    [null, "null"],
    [undefined, "undefined"],
  ])("a thrown %p renders as %p", (thrown, expected) => {
    expect(errorDetail(thrown)).toBe(expected as string);
  });
});
