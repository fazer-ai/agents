import { GUARDRAIL_CATEGORY_KEYS } from "./prompts";

// What a guardrail verdict's `categories` may leave in `execution_logs.detail`, which is documented as
// ids, counts and enums and served by the Logs page and `GET /v1/logs`. `categories` is model-written
// and may carry the customer's words, so only known keys are kept. The rest are COUNTED, not just
// dropped: a `customPolicy` violation has no key, and `categories: []` could not tell "nothing named"
// from "something fired we cannot name". The full verdict is on the conversation's private note.
export function loggableCategories(categories: readonly string[]): {
  categories: string[];
  categoriesUnnamed?: number;
} {
  const named = categories.filter((c) => GUARDRAIL_CATEGORY_KEYS.includes(c));
  const unnamed = categories.length - named.length;
  return unnamed > 0
    ? { categories: named, categoriesUnnamed: unnamed }
    : { categories: named };
}
