import { describe, expect, test } from "bun:test";
import {
  isExpectedResult,
  normalizeExpectedStatuses,
} from "@/graph/tools/http-status";

// Decision table for issue #59. Since #40 every non-2xx is an integration failure, which is right
// for a broken credential and wrong for a lookup whose 404 means "no record" — that tool emits a
// warn on every healthy turn and drowns the operator's alert channel.

describe("normalizeExpectedStatuses", () => {
  test("an absent or non-array config is empty, which is today's behavior", () => {
    for (const raw of [undefined, null, {}, "404", 404]) {
      expect(normalizeExpectedStatuses(raw)).toEqual([]);
    }
  });

  test("a plain list is kept, sorted and deduped", () => {
    expect(normalizeExpectedStatuses([409, 404, 404])).toEqual([404, 409]);
  });

  // Three transports write this config and a JSON body routinely carries numbers as strings.
  test("numeric strings are accepted", () => {
    expect(normalizeExpectedStatuses(["404", " 409 "])).toEqual([404, 409]);
  });

  test("anything that is not a whole HTTP status is dropped", () => {
    expect(
      normalizeExpectedStatuses([99, 600, 404.5, "abc", "", null, true, {}]),
    ).toEqual([]);
  });

  // Listing one is harmless and means nothing: 2xx is already a result. Dropping keeps the stored
  // config canonical instead of rejecting a save over a no-op.
  test("2xx entries are dropped rather than rejected", () => {
    expect(normalizeExpectedStatuses([200, 204, 404])).toEqual([404]);
  });

  // Almost always the wrong choice, and still the operator's to make: refusing it would buy a
  // special case in the validator, and some APIs really do answer 503 for "temporarily no data".
  // Review finding, round 3, same class as the one below: `fetch` consumes informational responses
  // and exposes only the final one, so a declared 1xx could never be matched against anything.
  test("informational statuses are refused, not stored", () => {
    expect(normalizeExpectedStatuses([100, 102, 199, 404])).toEqual([404]);
  });

  // Review finding, round 2: the tool fetches with `redirect: "error"`, so a redirect status
  // arriving with a Location rejects before any status is looked at. Accepting the declaration would
  // store a promise the runtime cannot keep, and one that would seem to work on the responses that
  // happened to carry no Location.
  test("the statuses fetch treats as redirects are refused, not stored", () => {
    expect(normalizeExpectedStatuses([301, 302, 303, 307, 308, 404])).toEqual([
      404,
    ]);
  });

  // Only the five the standard calls redirect statuses. The rest of 3xx is delivered like any other
  // response, and 304 for "nothing changed" is a genuine "no result".
  test("the 3xx codes that are not redirects stay declarable", () => {
    expect(normalizeExpectedStatuses([300, 304])).toEqual([300, 304]);
  });

  test("5xx is allowed", () => {
    expect(normalizeExpectedStatuses([503])).toEqual([503]);
  });
});

describe("isExpectedResult", () => {
  test("2xx is a result even with an empty list", () => {
    expect(isExpectedResult(200, [])).toBe(true);
    expect(isExpectedResult(204, [])).toBe(true);
  });

  test("an empty list makes every non-2xx a failure (issue #40 preserved)", () => {
    for (const s of [400, 401, 404, 409, 500]) {
      expect(isExpectedResult(s, [])).toBe(false);
    }
  });

  test("a declared status becomes a result", () => {
    expect(isExpectedResult(404, [404])).toBe(true);
    expect(isExpectedResult(409, [404, 409])).toBe(true);
  });

  // The point of a list over a range: declaring 404 must not quietly cover the auth failures next
  // to it, which are the ones the operator most needs to hear about.
  test("declaring one status does not cover its neighbours", () => {
    for (const s of [400, 401, 403, 500]) {
      expect(isExpectedResult(s, [404])).toBe(false);
    }
  });
});
