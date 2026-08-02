import { describe, expect, test } from "bun:test";
import {
  sanitizeSiteUrl,
  sanitizeSupportEmail,
  toDto,
} from "@/api/features/branding/branding.service";

// Footer-link white-labeling (issue #4): the sanitizers are the single gate between operator
// input and an href/mailto: in every visitor's sidebar, so they are pinned here. The write
// validation errors throw BEFORE any DB access, so they run without Postgres. The
// updateBrandingColors block is Full-only: in the Free edition that module is the
// ProEditionError stub, so the validation path does not exist to be tested.

describe("sanitizeSiteUrl", () => {
  test("accepts absolute http(s) URLs, trimmed", () => {
    expect(sanitizeSiteUrl("https://acme.example.com")).toBe(
      "https://acme.example.com",
    );
    expect(sanitizeSiteUrl("  http://acme.example.com/about  ")).toBe(
      "http://acme.example.com/about",
    );
  });

  test("rejects non-http(s) schemes and relative/invalid values", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,x",
      "ftp://files.example.com",
      "acme.example.com",
      "/relative/path",
      "not a url",
      "",
      "   ",
    ]) {
      expect(sanitizeSiteUrl(bad)).toBeNull();
    }
    expect(sanitizeSiteUrl(null)).toBeNull();
    expect(sanitizeSiteUrl(42)).toBeNull();
  });

  test("rejects URLs over the length bound", () => {
    const long = `https://acme.example.com/${"a".repeat(512)}`;
    expect(sanitizeSiteUrl(long)).toBeNull();
  });
});

describe("sanitizeSupportEmail", () => {
  test("accepts plausible addresses, trimmed", () => {
    expect(sanitizeSupportEmail("help@acme.example.com")).toBe(
      "help@acme.example.com",
    );
    expect(sanitizeSupportEmail("  suporte@acme.com.br  ")).toBe(
      "suporte@acme.com.br",
    );
  });

  test("rejects malformed addresses", () => {
    for (const bad of [
      "help",
      "help@",
      "@acme.com",
      "help@acme",
      "he lp@acme.com",
      "help@ac me.com",
      "help@@acme.com",
      "",
      "   ",
    ]) {
      expect(sanitizeSupportEmail(bad)).toBeNull();
    }
    expect(sanitizeSupportEmail(undefined)).toBeNull();
  });

  test("rejects addresses over the length bound", () => {
    const long = `${"a".repeat(250)}@x.io`;
    expect(sanitizeSupportEmail(long)).toBeNull();
  });
});

describe("toDto footer-link fields (defense in depth on read)", () => {
  const row = {
    brandName: null,
    colorMode: "SIMPLE",
    brandColor: null,
    tokensLight: {},
    tokensDark: {},
    logoDarkKey: null,
    logoLightKey: null,
    faviconDarkKey: null,
    faviconLightKey: null,
    siteUrl: null as string | null,
    supportEmail: null as string | null,
    hideGithubLink: false,
    updatedAt: new Date(0),
  };

  test("passes sane stored values through", () => {
    const dto = toDto({
      ...row,
      siteUrl: "https://acme.example.com",
      supportEmail: "help@acme.example.com",
      hideGithubLink: true,
    });
    expect(dto.siteUrl).toBe("https://acme.example.com");
    expect(dto.supportEmail).toBe("help@acme.example.com");
    expect(dto.hideGithubLink).toBe(true);
  });

  test("nulls out values that no longer pass the sanitizers", () => {
    // e.g. a row written before validation existed, or tampered at rest.
    const dto = toDto({
      ...row,
      siteUrl: "javascript:alert(1)",
      supportEmail: "not-an-email",
    });
    expect(dto.siteUrl).toBeNull();
    expect(dto.supportEmail).toBeNull();
    expect(dto.hideGithubLink).toBe(false);
  });
});
