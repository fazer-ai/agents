import { describe, expect, test } from "bun:test";
import { sanitizeBranding } from "@/lib/branding";

// NOTE: The scoped-write cases moved to tenants-admin.test.ts, which the Free tree drops: they
// exercise tenants.admin.service, a paired file that is a ProEditionError stub there. What lives
// here is the branding sanitizer, which is identical in every edition.

describe("sanitizeBranding (server-side)", () => {
  test("keeps allowlisted keys with valid color tokens", () => {
    expect(
      sanitizeBranding({
        accent: "#ff0000",
        accentSolid: "oklch(0.6 0.2 20)",
      }),
    ).toEqual({ accent: "#ff0000", accentSolid: "oklch(0.6 0.2 20)" });
  });
  test("drops the keys the split accent replaced (accentMuted, primary)", () => {
    expect(
      sanitizeBranding({ accentMuted: "#ff0000", primary: "#00ff00" }),
    ).toEqual({});
  });
  test("drops unknown keys and invalid values (anti-injection)", () => {
    expect(
      sanitizeBranding({
        accent: "url(evil)",
        bgPrimary: "#000000",
        accentSoft: "#0f0",
      }),
    ).toEqual({ accentSoft: "#0f0" });
  });
});
