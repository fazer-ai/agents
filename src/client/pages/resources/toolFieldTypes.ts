import type { useTranslation } from "react-i18next";

// The operator-facing name of each declared AI-field type, in ONE place.
//
// Two screens show it — the field editor picks the type, and the test dialog reports a value the
// type cannot take — and a second copy would name the type one way on the tab where it is chosen
// and another way in the sentence that refuses it. Which is worse than an English word: it is a
// word the operator has never seen anywhere.
export function fieldTypeLabels(
  t: ReturnType<typeof useTranslation>["t"],
): Record<string, string> {
  return {
    string: t("tools.typeString", "Text"),
    integer: t("tools.typeInteger", "Integer"),
    number: t("tools.typeNumber", "Number"),
    boolean: t("tools.typeBoolean", "Yes/No"),
    enum: t("tools.typeEnum", "List (enum)"),
    array: t("tools.typeArray", "Array"),
    object: t("tools.typeObject", "JSON object"),
  };
}
