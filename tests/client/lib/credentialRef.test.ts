import { describe, expect, test } from "bun:test";
import { canonicalVaultRef, formatVaultRef } from "@/client/lib/credentialRef";

// One spelling to compare against, because a ref reaches the agent unvalidated (`PATCH
// /v1/agents/:id` stores what it is handed) while every list the browser builds is canonical.
describe("canonicalVaultRef", () => {
  test("keeps a canonical ref as it is", () => {
    expect(canonicalVaultRef("vault:7")).toBe("vault:7");
  });

  // The forms BigInt accepts, which is what every resolver in this system parses the id with.
  test("normalizes the spellings the resolvers already accept", () => {
    expect(canonicalVaultRef("vault:0007")).toBe(formatVaultRef("7"));
    expect(canonicalVaultRef("vault: 7 ")).toBe(formatVaultRef("7"));
  });

  test("has no answer for a name or a malformed id", () => {
    expect(canonicalVaultRef("openai-key")).toBeNull();
    expect(canonicalVaultRef("vault:abc")).toBeNull();
    expect(canonicalVaultRef("")).toBeNull();
  });

  // `BigInt("")` is 0n, so an empty id canonicalizes to entry 0 instead of to "not a ref". That
  // MIRRORS the server resolver, which builds the same `{ id: 0n }` and matches nothing (ids are a
  // positive bigserial). Both routes end at the same verdict, and the canonicalizer's job is to
  // agree with the resolver rather than to be independently tidy.
  test("follows the resolver on an empty id, which matches no entry", () => {
    expect(canonicalVaultRef("vault:")).toBe(formatVaultRef("0"));
  });
});
