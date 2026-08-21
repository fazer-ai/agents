import { GUARDRAIL_CATEGORY_KEYS } from "./prompts";

// What a guardrail verdict's `categories` may leave in `execution_logs.detail`.
//
// The column is documented as ids, counts and enums, never message text, and it is served by the
// Logs page and by `GET /v1/logs` (issue #141). `categories` reads like an enum and is not one: the
// prompt asks for policy keys, nothing holds the model to that, and a model answering the question
// in prose writes the customer's own words there instead. That is the same defect `rationale` had,
// one field over.
//
// Dropping the strangers alone would be worse than it looks: a violation of the operator's
// `customPolicy` has NO key, because the prompt gives it none either ("Additional policy: …"), so
// the row would read `categories: []` and the operator could not tell "nothing was named" from
// "something fired that we cannot name". Hence the count, which answers exactly that question with
// a number. Naming the custom policy would mean editing the prompt of a model that judges, which is
// a change this repo does not make without an A/B battery, and it is not what this issue is about.
//
// The full verdict still reaches the operator on the private note the runtime posts, which lives on
// the conversation the text came from and is therefore the right place for it.
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
