import { getLocaleFromHeader, translateWithLocale } from "@/api/lib/i18n";
import type { AppError } from "@/lib/errors";

// What a refusal ANSWERS. One place, because the two halves of it are decided by different things
// and get confused for each other otherwise: the sentence is written for whoever is reading, in the
// language they asked for, and the field is a key the client matches on, identical in every language.
//
// The field exists because the server already knew it and spent it on prose. `SettingsTextTooLongError`
// takes `(field, length, max)` and interpolates the field into a localized sentence; a console that
// wants to put the message next to the input it is about would have to parse that sentence back
// apart, per locale. Measured before the change: the same refusal reads "The text in
// guardrails.output.templateMessage is too long…" in English and "O texto em … é longo demais…" in
// pt-BR, with the path embedded in both and named by neither.
//
// ONE field, not a list, because one is what the app produces: `assertSettingsTextSizes` refuses on
// the FIRST oversized change (`const [first] = collectOversizedTextChanges(…)`) and every other site
// that knows a field knows exactly one. A list would be a shape nothing fills.
//
// ABSENT rather than null when nothing was named: most refusals are not about one input (a 403, a
// 404, a conflict), and they must keep answering exactly the body they answer today. A `field: null`
// would be a wire change for all of them and a second spelling of "nothing here" for every client.
export interface RefusalBody {
  error: string;
  field?: string;
}

export function refusalBody(
  error: AppError,
  acceptLanguage: string | null,
): RefusalBody {
  const message = error.translationKey
    ? translateWithLocale(
        getLocaleFromHeader(acceptLanguage),
        error.translationKey,
        error.message,
        error.translationParams,
      )
    : error.message;
  // A blank name is not a name: it would put the key on the wire for a client to match against
  // nothing, which is worse than the honest silence of not naming a field at all.
  const field = error.field?.trim();
  return field ? { error: message, field } : { error: message };
}
