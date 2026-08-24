import { describe, expect, test } from "bun:test";
import { redactSecretsDeep, sanitizeErrorMessage } from "@/lib/redact";
import { unstorableProblem } from "@/lib/text";

// REPAIRING A VALUE CAN RECONSTRUCT WHAT THE REDACTOR JUST FAILED TO MATCH.
//
// The walker does two things to every string: it scrubs secret-shaped substrings, and it repairs the
// characters a `jsonb` column refuses. The order between them is load-bearing and was wrong: a NUL
// inside a token breaks the pattern, so the redactor sees nothing to scrub, and the repair then
// DELETES that NUL and stores the token whole. Measured before the fix:
//
//   { note: "token sk-<NUL>abcdefghijklmnop" }  ->  { note: "token sk-abcdefghijklmnop" }
//   { "pass<NUL>word": "hunter2" }              ->  { password: "hunter2" }
//
// Both are the same mistake in the two places the walker makes a decision about a string, and both
// defeat the invariant the whole module exists for. The repair is what makes the value storable, so
// it cannot simply be dropped: it has to happen BEFORE the decision that reads the string.
//
// A NUL is the character that matters here, because it is the one the repair DELETES. An orphan half
// becomes U+FFFD, which leaves `pass<U+FFFD>word` visibly broken rather than passing as `password`.

const NUL = String.fromCharCode(0);

describe("redactSecretsDeep repairs before it decides", () => {
  test("a NUL inside a token does not smuggle the token past the scrubber", () => {
    const out = redactSecretsDeep({
      note: `token sk-${NUL}abcdefghijklmnop`,
    }) as Record<string, string>;
    expect(out.note).not.toContain("sk-abcdefghijklmnop");
    expect(out.note).toContain("‹redacted›");
  });

  test("a NUL inside a credential key does not smuggle the value past the key rule", () => {
    const out = redactSecretsDeep(
      JSON.parse(`{"pass\\u0000word":"hunter2"}`),
    ) as Record<string, unknown>;
    expect(Object.values(out)).not.toContain("hunter2");
    expect(out.password).toBe("‹redacted›");
  });

  test("still scrubs what it always scrubbed", () => {
    const out = redactSecretsDeep({
      token: "sk-abcdefghijklmnop",
      api_key: "whatever",
      note: "Authorization: Bearer abcdefghijklmnop",
      keep: "ordinary text",
    }) as Record<string, string>;
    expect(out.token).not.toContain("sk-abcdefghijklmnop");
    expect(out.api_key).toBe("‹redacted›");
    expect(out.note).toContain("‹redacted›");
    expect(out.keep).toBe("ordinary text");
  });

  test("whatever it returns, the column can hold it", () => {
    const out = redactSecretsDeep({
      [`k${NUL}1`]: `a${NUL}b`,
      nested: [`c\ud800d`, { deep: `e${NUL}\udc00f` }],
    });
    const json = JSON.stringify(out) ?? "";
    expect(unstorableProblem(json, "serialized")).toBeNull();
  });
});

// The same ordering, in the other function that repairs and then decides. This one guards every
// column that holds an error message (issue #243), and an exception message is exactly where a
// provider's own answer, key included, ends up quoted verbatim.
describe("sanitizeErrorMessage repairs before it decides", () => {
  test("a NUL inside a token does not smuggle the token past the scrubber", () => {
    const out = sanitizeErrorMessage(
      new Error(`upstream rejected token sk-${NUL}abcdefghijklmnop`),
    );
    expect(out).not.toContain("sk-abcdefghijklmnop");
    expect(out).toContain("\u2039redacted\u203a");
  });

  test("whatever it returns, the column can hold it", () => {
    for (const raw of [
      `boom${NUL}tail`,
      "boom\ud800tail",
      "boom\ud800",
      `\ud800${NUL}\udc00`,
    ]) {
      expect(unstorableProblem(sanitizeErrorMessage(raw), "out")).toBeNull();
    }
  });

  test("still bounds what it always bounded", () => {
    const out = sanitizeErrorMessage("x".repeat(600));
    expect(out.length).toBeLessThanOrEqual(500 + "\u2026[truncated]".length);
    expect(out).toContain("[truncated]");
  });
});
