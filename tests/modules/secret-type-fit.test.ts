import { describe, expect, test } from "bun:test";
import {
  type CredentialUse,
  SECRET_TYPES,
  secretTypeFits,
  secretValueFitsKind,
  valueRuleApplies,
} from "@/modules/vault/secret-types";

// The decision table for "can an entry of this KIND supply what a field of this USE reads?", which is
// the one question the write boundary, config-health and the runtime all ask (issue #471). A pure
// function with a table, rather than a rule re-derived at each of the three: the whole defect was
// three surfaces answering it differently, and DB-backed tests prove the wiring, never the rule.
//
// Every catalog id appears below, enforced by the fence at the bottom, so adding a secret type fails
// this file until somebody decides what it can serve.

// [kind, apiKey?, injectable?]
const TABLE: [string, boolean, boolean][] = [
  // Plain-string kinds: the value IS the secret, and it is meant to travel.
  ["generic", true, true],
  ["bearer_token", true, true],
  ["header", true, true],
  ["basic_auth", true, true],
  ["query", true, true],
  ["openai", true, true],
  ["anthropic", true, true],
  ["gemini", true, true],
  ["deepseek", true, true],
  ["openrouter", true, true],
  ["openai_compatible", true, true],
  ["elevenlabs", true, true],
  ["asaas", true, true],
  ["chatwoot_api_token", true, true],
  // Multi-field: the value is `{ clientId, clientSecret }` and the tokens the consent flow merges in.
  // Injectable because `resolveInjectableCredentialEntry` refreshes an access token from it; never an
  // API key, because the field would hand the OBJECT to a provider SDK.
  ["google_oauth", false, true],
  // Server-managed blob, same reasoning.
  ["mcp_oauth", false, true],
  // Multi-field AND never-outbound: observability reads the pair in-process.
  ["langfuse", false, false],
  // A plain string that must never leave: the stdio loader spawns the process with it. This is the
  // one row where "holds a string" and "can serve an API-key field" come apart, and it is why the
  // predicate asks the catalog instead of asking `typeof`.
  ["mcp_env", false, false],
];

describe("secretTypeFits", () => {
  for (const [kind, apiKey, injectable] of TABLE) {
    test(`${kind}: apiKey=${apiKey} injectable=${injectable}`, () => {
      expect(secretTypeFits(kind, "apiKey")).toBe(apiKey);
      expect(secretTypeFits(kind, "injectable")).toBe(injectable);
      // The embedding key differs from `apiKey` only on the VALUE rule, never on the kind, so it
      // shares this column rather than getting one of its own — and this assertion is what keeps the
      // two from drifting apart the day somebody special-cases one of them.
      expect(secretTypeFits(kind, "embeddingKey")).toBe(apiKey);
    });
  }

  // A kind this build does not know, and the null kind every entry created before the catalog has.
  // Both are the legacy `generic` escape hatch: a plain string with no injection rule. Refusing them
  // would invalidate working installs over a catalog entry we removed.
  for (const use of [
    "apiKey",
    "injectable",
    "embeddingKey",
  ] as CredentialUse[]) {
    test(`an unknown or absent kind is permissive (${use})`, () => {
      expect(secretTypeFits(null, use)).toBe(true);
      expect(secretTypeFits(undefined, use)).toBe(true);
      expect(secretTypeFits("", use)).toBe(true);
      expect(secretTypeFits("a_type_this_build_removed", use)).toBe(true);
    });
  }

  // The table is the catalog, not a sample of it: a new secret type has to be placed here before it
  // can be wired anywhere, because a kind nobody judged defaults to "fits" via the unknown-kind rule
  // above — which is right for a legacy entry and wrong for a type this build ships.
  test("every catalog kind is in the table", () => {
    expect(new Set(TABLE.map(([k]) => k))).toEqual(
      new Set(SECRET_TYPES.map((s) => s.id)),
    );
  });
});

// The second half of the question, and the half only the ROW can answer. The catalog says what a kind
// is supposed to hold; this says whether it does. Asymmetric on purpose, and the asymmetry is the
// content: string-valued kinds are checked strictly because that is what a reader breaks on, while a
// multi-field or blob kind is only checked for being an object — the OAuth consent flows merge tokens
// into those values outside `validateVaultValue`, so demanding the declared field list would report
// every CONNECTED Google account as malformed.
describe("secretValueFitsKind", () => {
  const CASES: [string, string | null, unknown, boolean][] = [
    ["a plain key on a string kind", "openai", "sk-live", true],
    ["an empty string on a string kind", "openai", "", false],
    ["an object on a string kind", "generic", { apiKey: "sk-x" }, false],
    ["an object on a null kind", null, { a: 1 }, false],
    ["a string on a null kind", null, "sk-live", true],
    [
      "the declared pair on a fields kind",
      "google_oauth",
      { clientId: "a", clientSecret: "b" },
      true,
    ],
    // The connected case: the consent flow has merged tokens in, so the object carries far more than
    // the two declared fields. It is the NORMAL state of a working credential, not a malformed one.
    [
      "a connected OAuth blob, well past its declared fields",
      "google_oauth",
      {
        clientId: "a",
        clientSecret: "b",
        accessToken: "t",
        refreshToken: "r",
        expiresAt: 1,
        scopes: [],
        email: "x@y",
      },
      true,
    ],
    [
      "an empty managed blob, before the connect flow runs",
      "mcp_oauth",
      {},
      true,
    ],
    ["a string on a fields kind", "langfuse", "sk-live", false],
    ["an array on a blob kind", "mcp_oauth", ["a"], false],
    ["null on a blob kind", "mcp_oauth", null, false],
  ];
  for (const [label, kind, value, fits] of CASES) {
    test(`${label} -> ${fits}`, () => {
      expect(secretValueFitsKind(kind, value)).toBe(fits);
    });
  }
});

// Which uses hold the stored VALUE to its kind, and the one that does not. Written as a table over
// every use rather than as "not embeddingKey", so a fourth use has to be placed here before it can
// silently inherit either answer.
describe("valueRuleApplies", () => {
  const USES: [CredentialUse, boolean][] = [
    ["apiKey", true],
    ["injectable", true],
    // The exemption: `resolveEmbeddingStatus` accepts `{ apiKey, baseURL }` as well as the plain
    // string, a second form the catalog does not declare. Holding the value to the kind here would
    // refuse a shape that reader has always taken.
    ["embeddingKey", false],
  ];
  for (const [use, applies] of USES) {
    test(`${use} -> ${applies}`, () => {
      expect(valueRuleApplies(use)).toBe(applies);
    });
  }
});
