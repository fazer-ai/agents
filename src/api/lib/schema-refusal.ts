import type { ValidationError } from "elysia";
import { getLocaleFromHeader, translateWithLocale } from "@/api/lib/i18n";
import type { RefusalBody } from "@/api/lib/refusal";

// translate('errors.invalidRequestValue', 'The value sent in {{field}} is not valid.')
// translate('errors.invalidRequest', 'The request is not valid.')
// translate('errors.internalError', 'Something went wrong')

// What a refusal from the SCHEMA layer answers, and what it records.
//
// Elysia raises `VALIDATION` before the handler runs, and that error's `message` is TypeBox's own
// JSON. src/app.ts had no branch for it, so that JSON WAS the body: no `error` key anywhere in it,
// and `apiErrorMessage` (src/client/lib/apiError.ts) reads `value.error` and answers null for
// everything else, which is its "transport failure, show the generic sentence" branch. Every schema
// refusal in the console therefore showed a fixed sentence, on a family the call-site sweep cannot
// reach: there was nothing in the body for a call site to surface. Issue #255.
//
// The diagnostics do NOT come back, and that is the half with teeth. Measured against the real app
// with NODE_ENV=production: `POST /api/v1/vault` with `{ name: "", value: { api_key: "<secret>" } }`
// answered `{"type":"validation","on":"body","found":{"name":"","value":{"api_key":"<secret>"}}}`,
// and the `logger.error(path, error)` in that branch put the same string on stdout, which is what
// the fleet ships to its log store. Two things make it reachable rather than theoretical: schema
// validation runs BEFORE the role guard (the same request answers 422 unauthenticated), and `name`
// carries `minLength: 1` right next to the write-only secret. In production Elysia already drops
// `property` and `message` from that JSON and keeps only `found`, so the one field that survived to
// the operator was the echo of what they had just sent.
//
// The sentence is GENERIC, and deliberately does not translate TypeBox's rule. In production the
// body carried neither the field nor the rule, so naming the field is a strict gain; carrying the
// rule would mean mapping roughly fourteen TypeBox error codes onto locale entries that age with the
// dependency, and nothing measured asks for that. The rule goes to the log instead, where it is
// diagnosis rather than contract. It is safe there: measured over twelve schema shapes, TypeBox's
// message is derived from the SCHEMA ("Expected string length less or equal to 3", "Expected
// 'only'") and never from the submitted value.
//
// `on: "response"` is the one row that is not the client's fault. It means OUR answer failed OUR
// schema, so answering 422 with a `field` would tell the caller their input was wrong and point them
// at an input they did not send. It is a server fault, recorded as one. It answers a localized
// sentence where the app's other 500 answers plain text, and that divergence is deliberate rather
// than overlooked: this branch already has the locale in hand, and a body a client can read costs
// nothing here. Bringing the `INTERNAL_SERVER_ERROR` branch along is a separate change.
//
// Every OTHER side names its value, `params` and `headers` included, and not only the body. `field`
// says which value the refusal is about by the server's name for it, and for a route parameter or a
// header that name is the parameter's. The client that sent it can match on it; what a console does
// with a name that is not an input on the screen is the renderer's question, not this one.
export interface SchemaRefusal {
  status: number;
  body: RefusalBody;
  severity: "warn" | "error";
  // The line to log INSTEAD of the error itself. Carries the same diagnosis with no submitted value
  // in it: which side was validated, which value, and the schema rule it broke.
  log: string;
}

// The name of the value that failed, in the vocabulary the rest of the app's refusals use: the
// dotted path #245 put on the wire (`guardrails.output.templateMessage`, `systemPrompt`). What
// arrives here is a JSON pointer into the validated value (`/settings/guardrails/templateMessage`),
// which is the same path with a different separator, so the conversion is mechanical.
//
// The conversion is NOT the whole job, because a name has to be one the SERVER chose. A pointer
// segment is not automatically that: TypeBox descends into a `t.Record` whose value type constrains
// anything, and the segment it reports there is the key the CALLER wrote. Measured against the real
// route schema, `POST .../playground/turn` with `draft.promptVars = { "<secret>": <501 chars> }`
// (agents.controller.ts:120, reachable because line 746 mounts that schema directly rather than
// inside a union) reported `/draft/promptVars/<secret>`, which would have put the caller's own string
// in the log line this module exists to keep clean. `toolMocks` (line 117) and the document
// template's field labels do the same. The vault's `value` does not, and the reason is worth
// knowing: it is a `t.Union`, and TypeBox stops at `anyOf` instead of descending.
//
// So the pointer is walked against the schema that refused it, and a segment survives only if that
// schema DECLARES it: an own property of an object, or an index into an array or tuple. The first
// segment the schema does not declare ends the name and takes the rest of the path with it. A record
// therefore answers with the record's own property (`draft.promptVars`), which is the input on the
// screen anyway. What is lost is WHICH key of a many-key record failed; the rule in the log line
// ("Expected string length less or equal to 500") is the half that says what to do about it.
//
// `unknown` in, for both arguments. A standard-schema validator (zod and friends) reports `path` as
// an ARRAY of segments rather than a pointer string (elysia/dist/error.js, the `~standard` branch),
// and its schema is not a JSON Schema at all. No route declares one today; when one does, both
// arguments fail to resolve and the honest answer is to name no field rather than to publish "0" as
// one.
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
