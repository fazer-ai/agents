import { describe, expect, test } from "bun:test";
import { translateWithLocale } from "@/api/lib/i18n";
import { AppError } from "@/lib/errors";
import { invalidDocumentTemplate } from "@/modules/documents/validate";

// What the OPERATOR reads when a template is refused.
//
// The global handler localizes an AppError's `translationKey` and, when that key resolves, the
// `message` it was built with is only a fallback — so every malformed block, token, field and style
// came back as one sentence that named none of them. The preview exists to answer "which block, and
// which rule": a round trip that renders the PDF precisely so the refusal can be read is worth
// nothing if the refusal is generic.
//
// Asserted THROUGH the translation, not on the error object, because the masking happened in that
// step: an assertion on `error.message` passes with or without the fix.
function shown(err: AppError, locale: "en" | "pt-BR"): string {
  // No key means nothing to resolve, and the message IS the answer. Spelled as a branch rather than
  // a `?? ""`, which used to hand i18next a key it could never resolve and got the same string by
  // accident.
  if (!err.translationKey) return err.message;
  return translateWithLocale(
    locale,
    err.translationKey,
    err.message,
    err.translationParams,
  );
}

describe("a refused template says which rule refused it", () => {
  const reason =
    'blocks[2]: token "{{cliente}}" names no field this template declares.';

  test("the reason survives translation, in both languages", () => {
    const err = invalidDocumentTemplate(reason);
    expect(shown(err, "en")).toContain(reason);
    expect(shown(err, "pt-BR")).toContain(reason);
    // …and the sentence AROUND it is the reader's language, which is why this is an interpolation
    // rather than dropping the key.
    expect(shown(err, "pt-BR")).toContain("não é válido");
    expect(shown(err, "en")).toContain("not valid");
  });

  test("it is still a 400 the route advertises", () => {
    expect(invalidDocumentTemplate(reason).statusCode).toBe(400);
  });

  // The shape the fix replaced, pinned so it cannot come back by someone "tidying" the key: a plain
  // key with the reason only as a fallback resolves to the generic sentence and drops it.
  test("a key without the interpolation would drop the reason", () => {
    const generic = new AppError(reason, 400, "errors.invalidDocumentTemplate");
    expect(shown(generic, "en")).not.toContain(reason);
  });
});
