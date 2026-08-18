import { describe, expect, test } from "bun:test";
import { apiErrorMessage } from "@/client/lib/apiError";

describe("apiErrorMessage", () => {
  test("returns the backend's localized message", () => {
    expect(
      apiErrorMessage({
        status: 400,
        value: {
          error:
            "O texto em handoff.instructions é longo demais: 1829 caracteres (limite 1500).",
        },
      }),
    ).toBe(
      "O texto em handoff.instructions é longo demais: 1829 caracteres (limite 1500).",
    );
  });

  test("null for anything that is not a body with a message", () => {
    for (const e of [
      null,
      undefined,
      "boom",
      new Error("network"),
      { status: 500 },
      { value: null },
      { value: {} },
      { value: { error: "" } },
      { value: { error: "   " } },
      { value: { error: 42 } },
    ]) {
      expect(apiErrorMessage(e)).toBeNull();
    }
  });
});
