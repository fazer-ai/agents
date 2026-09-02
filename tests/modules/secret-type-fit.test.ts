import { describe, expect, test } from "bun:test";
import {
  type CredentialUse,
  SECRET_TYPES,
  secretTypeFits,
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
    });
  }

  // A kind this build does not know, and the null kind every entry created before the catalog has.
  // Both are the legacy `generic` escape hatch: a plain string with no injection rule. Refusing them
  // would invalidate working installs over a catalog entry we removed.
  for (const use of ["apiKey", "injectable"] as CredentialUse[]) {
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
