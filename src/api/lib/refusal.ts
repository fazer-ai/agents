import { getLocaleFromHeader, translateWithLocale } from "@/api/lib/i18n";
import { REJECTED_TENANT_SELECTOR_HEADER } from "@/lib/console-params";
import {
  ActiveTenantNotFoundError,
  type AppError,
  TenantSelectorRefusedError,
} from "@/lib/errors";

// What a refusal ANSWERS: the sentence, localized for whoever reads it, and `field`, the server's own
// name for the one input it is about, identical in every language so a client never parses prose
// per locale (docs/ui.md, the refusal shape). ONE field: `assertSettingsTextSizes` refuses on the
// FIRST oversized change and every other site knows exactly one. A refusal names a field only when
// the operator can fix exactly that input (`requireDbId` refuses a URL segment, so it does not;
// tests/api/lib/refusal-callsites.test.ts holds the sweep). MCP write refusals carry none: their
// reader is a model, with no input to attach it to. `field` is ABSENT, never null, when nothing is
// named, so the many refusals about no input keep their body and "nothing here" has one spelling.
export interface RefusalBody {
  error: string;
  field?: string;
  // The playground turn the refusal ended, for the console's link to its log lines.
  turnId?: string;
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
  return {
    error: message,
    ...(field ? { field } : {}),
    ...(error.turnId ? { turnId: error.turnId } : {}),
  };
}

// The other half of what a refusal answers, and the reason it is a separate function: the body is
// what the OPERATOR reads and this is what the CLIENT acts on before anything reads the body at all.
// Empty for every refusal but the two that refuse a tenant selector, so `Response.json` keeps setting
// its own content type.
export function refusalHeaders(error: AppError): Record<string, string> {
  return error instanceof ActiveTenantNotFoundError ||
    error instanceof TenantSelectorRefusedError
    ? { [REJECTED_TENANT_SELECTOR_HEADER]: error.rejectedTenantId }
    : {};
}
