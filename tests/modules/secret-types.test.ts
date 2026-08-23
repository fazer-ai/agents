import { describe, expect, test } from "bun:test";
import {
  isNonInjectableSecret,
  isSecretTypeId,
  resolveSecretInjection,
} from "@/modules/vault/secret-types";

describe("secret-types catalog", () => {
  test("known ids validate; unknown ones do not", () => {
    expect(isSecretTypeId("chatwoot_api_token")).toBe(true);
    expect(isSecretTypeId("generic")).toBe(true);
    expect(isSecretTypeId("nope")).toBe(false);
  });

  test("header kind with paramName injects a custom header", () => {
    expect(resolveSecretInjection("header", "mykey", "X-Custom-Auth")).toEqual({
      target: "header",
      name: "X-Custom-Auth",
      value: "mykey",
    });
  });

  test("query kind with paramName injects a custom query param", () => {
    expect(resolveSecretInjection("query", "qval", "token")).toEqual({
      target: "query",
      name: "token",
      value: "qval",
    });
  });

  test("header kind WITHOUT paramName returns null (auto-injection disabled)", () => {
    expect(resolveSecretInjection("header", "mykey")).toBeNull();
    expect(resolveSecretInjection("header", "mykey", null)).toBeNull();
    expect(resolveSecretInjection("header", "mykey", "")).toBeNull();
  });

  test("query kind WITHOUT paramName returns null (auto-injection disabled)", () => {
    expect(resolveSecretInjection("query", "mykey")).toBeNull();
    expect(resolveSecretInjection("query", "mykey", null)).toBeNull();
  });

  test("resolveSecretInjection maps service types to their fixed names (paramName ignored)", () => {
    expect(resolveSecretInjection("bearer_token", "x")).toEqual({
      target: "header",
      name: "Authorization",
      value: "Bearer x",
    });
    expect(resolveSecretInjection("basic_auth", "x")).toEqual({
      target: "header",
      name: "Authorization",
      value: "Basic x",
    });
    expect(resolveSecretInjection("chatwoot_api_token", "x")).toEqual({
      target: "header",
      name: "api-access-token",
      value: "x",
    });
    // Service types ignore any paramName passed (they have a fixed name).
    expect(
      resolveSecretInjection("chatwoot_api_token", "x", "SomeName"),
    ).toEqual({
      target: "header",
      name: "api-access-token",
      value: "x",
    });
  });

  test("generic / unknown / empty-secret produce no injection", () => {
    expect(resolveSecretInjection("generic", "x")).toBeNull();
    expect(resolveSecretInjection("nope", "x")).toBeNull();
    expect(resolveSecretInjection(null, "x")).toBeNull();
    expect(resolveSecretInjection("bearer_token", "")).toBeNull();
  });

  // `resolveSecretInjection` returns null for two opposite reasons, and a caller that falls back to
  // a Bearer has to tell them apart: `generic` means "no rule, use your default" — that fallback IS
  // its purpose — while mcp_env and langfuse mean "there is a rule and it says never". Deriving the
  // answer from `injection: "none"` swept in `generic` and fail-closed every contact of an operator
  // using one.
  test("never-outbound is a rule of its own, not `injection: none`", () => {
    expect(isNonInjectableSecret("mcp_env")).toBe(true);
    expect(isNonInjectableSecret("langfuse")).toBe(true);
    expect(isNonInjectableSecret("generic")).toBe(false);
    expect(resolveSecretInjection("generic", "x")).toBeNull();
    expect(isNonInjectableSecret("bearer_token")).toBe(false);
    expect(isNonInjectableSecret("nope")).toBe(false);
    expect(isNonInjectableSecret(null)).toBe(false);
  });
});
