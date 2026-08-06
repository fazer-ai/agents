import { describe, expect, test } from "bun:test";
import { shouldRestoreUserBaseUrl } from "@/client/lib/credentialBaseUrl";

describe("shouldRestoreUserBaseUrl", () => {
  test("restores only on the locked → unlocked transition", () => {
    expect(shouldRestoreUserBaseUrl("https://cred.example/v1", null)).toBe(
      true,
    );
  });

  test("does NOT restore when the credential never carried a baseUrl", () => {
    // NOTE: The load-time regression: the picker resolves the entry on mount with no baseUrl, and
    // the parked value is still empty — restoring here wipes the persisted baseURL from the form.
    expect(shouldRestoreUserBaseUrl(null, null)).toBe(false);
  });

  test("does NOT restore while locked (the field shows the credential's URL)", () => {
    expect(shouldRestoreUserBaseUrl(null, "https://cred.example/v1")).toBe(
      false,
    );
    expect(
      shouldRestoreUserBaseUrl("https://a.example/v1", "https://b.example/v1"),
    ).toBe(false);
  });
});
