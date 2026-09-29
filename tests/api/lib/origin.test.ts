import { afterAll, describe, expect, mock, test } from "bun:test";

// Capture the real config eagerly so we can put it back on the module
// graph after the production-config scenarios run. Without this, the
// mocked config leaks into every test file that runs later in the same
// process and silently breaks them.
const originalConfig = (await import("@/config")).default;

afterAll(() => {
  mock.module("@/config", () => ({ default: originalConfig }));
});

// `@/api/lib/origin` reads `config.env` and `config.corsOrigin` at
// top-level initialization, so to exercise the production branch we have to
// remount the module with a substituted config and a fresh import URL.
interface OriginConfigOverrides {
  env: "development" | "production";
  corsOrigin: string;
}

async function loadOriginWithConfig(overrides: OriginConfigOverrides) {
  mock.module("@/config", () => ({
    default: { ...originalConfig, ...overrides },
  }));
  const url = `@/api/lib/origin?v=${Math.random()}`;
  const mod = (await import(url)) as typeof import("@/api/lib/origin");
  return mod;
}

describe("parseOrigins", () => {
  test("trims whitespace", async () => {
    const { parseOrigins } = await loadOriginWithConfig({
      env: "development",
      corsOrigin: "localhost:3000",
    });
    expect(parseOrigins("  a.com  ,  b.com  ")).toEqual(["a.com", "b.com"]);
  });

  test("filters out empty entries from trailing or duplicated commas", async () => {
    const { parseOrigins } = await loadOriginWithConfig({
      env: "development",
      corsOrigin: "localhost:3000",
    });
    expect(parseOrigins("a.com,,b.com,")).toEqual(["a.com", "b.com"]);
    expect(parseOrigins("")).toEqual([]);
    expect(parseOrigins(", ,")).toEqual([]);
  });

  test("compiles /regex/ patterns to RegExp", async () => {
    const { parseOrigins } = await loadOriginWithConfig({
      env: "development",
      corsOrigin: "localhost:3000",
    });
    const parsed = parseOrigins("/^https:\\/\\/.*\\.example\\.com$/");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toBeInstanceOf(RegExp);
  });

  test("throws a labelled error when a /regex/ pattern is invalid", async () => {
    const { parseOrigins } = await loadOriginWithConfig({
      env: "development",
      corsOrigin: "localhost:3000",
    });
    expect(() => parseOrigins("/[/")).toThrow(/Invalid regex in CORS_ORIGIN/);
  });
});

describe("isOriginAllowed", () => {
  test("permissive outside production (mirrors cors() default)", async () => {
    const { isOriginAllowed } = await loadOriginWithConfig({
      env: "development",
      corsOrigin: "example.com",
    });
    expect(isOriginAllowed(null)).toBe(true);
    expect(isOriginAllowed("http://anywhere.com")).toBe(true);
  });

  test("in production, a missing Origin header is rejected", async () => {
    const { isOriginAllowed } = await loadOriginWithConfig({
      env: "production",
      corsOrigin: "example.com",
    });
    expect(isOriginAllowed(null)).toBe(false);
    expect(isOriginAllowed("")).toBe(false);
  });

  test("in production, allows configured origin (with or without scheme)", async () => {
    const { isOriginAllowed } = await loadOriginWithConfig({
      env: "production",
      corsOrigin: "example.com",
    });
    expect(isOriginAllowed("https://example.com")).toBe(true);
    expect(isOriginAllowed("http://example.com")).toBe(true);
    expect(isOriginAllowed("example.com")).toBe(true);
  });

  test("in production, rejects unknown origins", async () => {
    const { isOriginAllowed } = await loadOriginWithConfig({
      env: "production",
      corsOrigin: "example.com",
    });
    expect(isOriginAllowed("https://evil.com")).toBe(false);
    expect(isOriginAllowed("https://example.com.evil.com")).toBe(false);
  });

  test("in production, matches comma-separated allowlist", async () => {
    const { isOriginAllowed } = await loadOriginWithConfig({
      env: "production",
      corsOrigin: "a.com,b.com",
    });
    expect(isOriginAllowed("https://a.com")).toBe(true);
    expect(isOriginAllowed("https://b.com")).toBe(true);
    expect(isOriginAllowed("https://c.com")).toBe(false);
  });

  test("in production, regex patterns match", async () => {
    const { isOriginAllowed } = await loadOriginWithConfig({
      env: "production",
      corsOrigin: "/^https:\\/\\/.*\\.example\\.com$/",
    });
    expect(isOriginAllowed("https://app.example.com")).toBe(true);
    expect(isOriginAllowed("https://api.example.com")).toBe(true);
    expect(isOriginAllowed("https://example.com")).toBe(false);
    expect(isOriginAllowed("https://evil.com")).toBe(false);
  });
});
