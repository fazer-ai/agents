import type { ValidationError } from "elysia";
import { getLocaleFromHeader, translateWithLocale } from "@/api/lib/i18n";
import type { RefusalBody } from "@/api/lib/refusal";

// translate('errors.invalidRequestValue', 'The value sent in {{field}} is not valid.')
// translate('errors.invalidRequest', 'The request is not valid.')
// translate('errors.internalError', 'Something went wrong')

// What a refusal from the schema layer answers, and what it logs. The submitted value reaches
// neither: Elysia's VALIDATION error echoes it, validation runs before the role guard, and the log
// leaves the box. The body names the field with a generic sentence; TypeBox's rule, derived from the
// schema and never from the value, goes to the log rather than onto locale entries that would age
// with the dependency. `on: "response"` is our answer failing our schema: a 500 with no `field`,
// since a 422 would blame an input the caller never sent. Every other side, `params` and `headers`
// included, names its value. More in docs/ui.md, "Where a server refusal goes".
export interface SchemaRefusal {
  status: number;
  body: RefusalBody;
  severity: "warn" | "error";
  // The line to log INSTEAD of the error itself. Carries the same diagnosis with no submitted value
  // in it: which side was validated, which value, and the schema rule it broke.
  log: string;
}

// The failing value's name in the app's refusal vocabulary (`guardrails.output.templateMessage`),
// from the JSON pointer TypeBox reports. A segment survives only if the refusing schema declares it
// (an own property, or an array or tuple index): under a `t.Record` TypeBox reports the key the
// CALLER wrote, which would put the caller's string in the log. A record answers with its own name,
// losing only which key failed. `unknown` in, because a standard-schema validator reports `path` as
// an array against a schema that is not JSON Schema: that resolves to no field, not to "0".
function declaredChild(node: unknown, segment: string): unknown {
  if (typeof node !== "object" || node === null) return undefined;
  const schema = node as { properties?: unknown; items?: unknown };

  const properties = schema.properties;
  // NOTE: `Object.hasOwn`, not a plain read: a caller-supplied key of `constructor` or
  // `toString` would otherwise resolve off the prototype and count as declared.
  if (
    typeof properties === "object" &&
    properties !== null &&
    Object.hasOwn(properties, segment)
  ) {
    return (properties as Record<string, unknown>)[segment];
  }

  const items = schema.items;
  if (items !== undefined && /^[0-9]+$/.test(segment)) {
    // NOTE: a tuple reports `items` as an array, one schema per position; an array reports
    // one schema for every position. An index past the end of a tuple resolves to undefined
    // and ends the name.
    return Array.isArray(items) ? items[Number(segment)] : items;
  }

  return undefined;
}

export function fieldFromPointer(
  pointer: unknown,
  schema: unknown,
): string | undefined {
  if (typeof pointer !== "string" || pointer === "root") return undefined;
  const segments = pointer
    .split("/")
    .filter((segment) => segment.length > 0)
    // NOTE: RFC 6901, `~1` before `~0`, or an escaped `~1` would decode into a separator.
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));

  const named: string[] = [];
  let node = schema;
  for (const segment of segments) {
    node = declaredChild(node, segment);
    if (node === undefined) break;
    named.push(segment);
  }
  return named.length > 0 ? named.join(".") : undefined;
}

// The schema the failing value was checked against. Elysia hands over the compiled validator and
// reads the schema off it the same way (`validator?.schema ?? validator`, elysia/dist/error.js).
function validatedSchema(error: ValidationError): unknown {
  const validator = error.validator as unknown;
  if (
    typeof validator === "object" &&
    validator !== null &&
    "schema" in validator
  ) {
    return (validator as { schema: unknown }).schema;
  }
  return validator;
}

export function schemaRefusal(
  error: ValidationError,
  acceptLanguage: string | null,
): SchemaRefusal {
  const locale = getLocaleFromHeader(acceptLanguage);
  const field = fieldFromPointer(
    error.valueError?.path,
    validatedSchema(error),
  );
  const rule = error.valueError?.message ?? "no rule reported";
  const where = field ? `${error.type}.${field}` : error.type;

  if (error.type === "response") {
    return {
      status: 500,
      body: {
        error: translateWithLocale(
          locale,
          "errors.internalError",
          "Something went wrong",
        ),
      },
      severity: "error",
      log: `response failed its own schema at ${where}: ${rule}`,
    };
  }

  const body: RefusalBody = field
    ? {
        error: translateWithLocale(
          locale,
          "errors.invalidRequestValue",
          "The value sent in {{field}} is not valid.",
          { field },
        ),
        field,
      }
    : {
        error: translateWithLocale(
          locale,
          "errors.invalidRequest",
          "The request is not valid.",
        ),
      };

  return {
    status: 422,
    body,
    severity: "warn",
    log: `refused ${where}: ${rule}`,
  };
}
