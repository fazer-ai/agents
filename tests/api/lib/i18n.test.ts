import { describe, expect, test } from "bun:test";
import { translateWithLocale } from "@/api/lib/i18n";
import type { ErrorTranslationKey } from "@/lib/errors";

// NOTE: the AppError → onError localization seam: translationKey + translationParams resolve
// to a localized, interpolated message (the exact call `onError` makes).
describe("translateWithLocale", () => {
  test("interpolates params into the localized entry (both locales)", () => {
    const params = { len: 120_000, max: 100_000 };
    const pt = translateWithLocale(
      "pt-BR",
      "errors.promptTooLong",
      "fallback",
      params,
    );
    expect(pt).toBe(
      "O prompt do sistema é longo demais: 120000 caracteres (limite 100000).",
    );
    const en = translateWithLocale(
      "en",
      "errors.promptTooLong",
      "fallback",
      params,
    );
    expect(en).toBe(
      "System prompt is too long: 120000 characters (limit 100000).",
    );
  });

  // The runtime half of the guard the TYPE now enforces: `ErrorTranslationKey` makes an
  // unregistered key a compile error at every real call site, and the cast here is what it takes to
  // reach this path on purpose. Kept because the fallback is what makes an unregistered key
  // INVISIBLE rather than loud, which is the property the type exists to compensate for.
  test("unknown key falls back to the provided default", () => {
    const unregistered = "errors.__nope__" as ErrorTranslationKey;
    expect(translateWithLocale("pt-BR", unregistered, "the default")).toBe(
      "the default",
    );
  });
});
