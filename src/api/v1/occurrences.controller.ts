import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tRanged } from "@/api/lib/ranged";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { MODEL_PROVIDERS } from "@/graph/model-config";
import { requireDbId } from "@/lib/db-id";
import {
  AppError,
  ForbiddenError,
  TenantTargetRequiredError,
} from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import {
  occurrenceCost,
  pageOccurrenceRuns,
  RUNS_LIMIT_RANGE,
} from "@/modules/occurrences/runs";
import {
  ABOVE_USUAL_RATIO_RANGE,
  BASE_URL_MAX,
  BUSINESS_CONTEXT_MAX,
  CADENCE_MINUTES_RANGE,
  CONCENTRATION_SHARE_RANGE,
  CONSOLIDATION_MINUTES_RANGE,
  CREDENTIAL_REF_MAX,
  FIELD_DESCRIPTION_MAX,
  FIELD_NAME_MAX,
  FIELDS_MAX,
  INBOXES_MAX,
  MODEL_ID_MAX,
  NEW_MIN_CONVERSATIONS_RANGE,
  PREVIOUS_DAYS_RANGE,
  WINDOW_MINUTES_RANGE,
} from "@/modules/occurrences/settings";
import {
  countThemes,
  getTheme,
  listThemes,
  THEMES_LIMIT_RANGE,
} from "@/modules/occurrences/views";
import {
  getOccurrencesSettings,
  updateOccurrencesSettings,
} from "@/modules/tenant-settings/service";

// The account's occurrence monitor (docs/occurrences.md): its configuration and its rounds.
// TENANT_ADMIN.

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

const fieldSchema = t.Object({
  key: t.String({
    pattern: "^[a-z0-9_]{1,64}$",
    description:
      "The field's key: lowercase letters, digits and `_`. Also the Chatwoot custom attribute key when `attribute` is true.",
  }),
  name: t.String({ minLength: 1, maxLength: FIELD_NAME_MAX }),
  description: t.String({
    minLength: 1,
    maxLength: FIELD_DESCRIPTION_MAX,
    description: "What the observer is told to write in this field.",
  }),
  attribute: t.Boolean({
    description:
      "Also write the value to the conversation's Chatwoot custom attribute of the same key.",
  }),
});

const nullableString = (description: string, maxLength?: number) =>
  t.Union([t.String({ minLength: 1, maxLength, description }), t.Null()]);

const monitorModelSchema = t.Object({
  provider: t.UnionEnum([...MODEL_PROVIDERS], {
    description: "The monitor's model provider.",
  }),
  model: t.Union([t.String({ maxLength: MODEL_ID_MAX }), t.Null()], {
    description: "The model id; null or blank is the provider's default.",
  }),
  credentialRef: t.Union(
    [t.String({ maxLength: CREDENTIAL_REF_MAX }), t.Null()],
    {
      description:
        "The vault credential (`vault:<id>`) holding the provider's API key; required but for openai-compatible.",
    },
  ),
  baseURL: t.Union([t.String({ maxLength: BASE_URL_MAX }), t.Null()], {
    description:
      "The endpoint, for openai-compatible or a provider that honors a proxy; null uses the credential's.",
  }),
});

const patchBody = t.Object({
  enabled: t.Optional(t.Boolean()),
  inboxIds: t.Optional(
    t.Array(t.String({ pattern: "^[1-9][0-9]{0,18}$" }), {
      maxItems: INBOXES_MAX,
      description:
        "The inboxes whose conversations the monitor reads (row ids as strings); replaces the list.",
    }),
  ),
  fields: t.Optional(t.Array(fieldSchema, { maxItems: FIELDS_MAX })),
  reasonField: t.Optional(
    nullableString(
      "The key of the field read as the conversation's reason, which the model groups into themes; required to switch the monitor on.",
    ),
  ),
  referenceField: t.Optional(
    nullableString(
      "The key of the optional field read as what the reason refers to; the concentration flag counts by it, and is never raised without it.",
    ),
  ),
  cadenceMinutes: t.Optional(
    tRanged(CADENCE_MINUTES_RANGE, { description: "Minutes between rounds." }),
  ),
  consolidationMinutes: t.Optional(
    tRanged(CONSOLIDATION_MINUTES_RANGE, {
      description: "Minutes between the stronger model's consolidations.",
    }),
  ),
  newMinConversations: t.Optional(
    tRanged(NEW_MIN_CONVERSATIONS_RANGE, {
      description:
        "N: conversations a theme needs in the recent window to be flagged.",
    }),
  ),
  windowMinutes: t.Optional(
    tRanged(WINDOW_MINUTES_RANGE, {
      description: "The recent window, in minutes.",
    }),
  ),
  previousDays: t.Optional(
    tRanged(PREVIOUS_DAYS_RANGE, {
      description:
        "Days before the window a new theme must have no conversations in.",
    }),
  ),
  aboveUsualRatio: t.Optional(
    tRanged(ABOVE_USUAL_RATIO_RANGE, {
      description: "X: times its own usual rate the window has to run at.",
    }),
  ),
  concentrationShare: t.Optional(
    tRanged(CONCENTRATION_SHARE_RANGE, {
      description:
        "Share of the window's conversations with one canonical reference.",
    }),
  ),
  model: t.Optional(
    t.Union([monitorModelSchema, t.Null()], {
      description:
        "The one model every step runs on; required to switch the monitor on.",
    }),
  ),
  businessContext: t.Optional(
    t.String({
      maxLength: BUSINESS_CONTEXT_MAX,
      description:
        "What every step is told about the business, appended to its fixed prompt; empty sends nothing.",
    }),
  ),
});

// Elysia cleans a body to its schema before the handler runs, so a key the block does not have would
// be dropped and the write answered 200. Checked on the raw body instead (the `transform` hook runs
// before that cleaning), and refused like the service refuses it.
export function refuseUnknownOccurrenceKeys(body: unknown): void {
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  const raw = body as Record<string, unknown>;
  const unknown = (keys: string[], known: object) =>
    keys.some((k) => !Object.hasOwn(known, k));
  const fields = Array.isArray(raw.fields) ? raw.fields : [];
  const field = fields.findIndex(
    (f) =>
      f !== null &&
      typeof f === "object" &&
      unknown(Object.keys(f), fieldSchema.properties),
  );
  const model =
    raw.model !== null &&
    typeof raw.model === "object" &&
    !Array.isArray(raw.model) &&
    unknown(Object.keys(raw.model), monitorModelSchema.properties);
  const at = unknown(Object.keys(raw), patchBody.properties)
    ? ""
    : field >= 0
      ? `fields.${field}`
      : model
        ? "model"
        : null;
  if (at === null) return;
  throw at
    ? new AppError(
        `The value sent in ${at} is not valid.`,
        422,
        "errors.invalidRequestValue",
        { field: at },
        at,
      )
    : new AppError("The request is not valid.", 422, "errors.invalidRequest");
}

const unknownKeyRefusals = new WeakMap<Request, unknown>();

export const occurrencesController = new Elysia({
  prefix: "/v1/occurrences",
  tags: ["Resources"],
})
  .use(tenancyPlugin)
  .get(
    "/config",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      occurrences: await getOccurrencesSettings(ctxOrThrow(tenantContext)),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Get the occurrence monitor",
        "The account's occurrence monitor: the inboxes it reads, the fields it reads off each conversation, which one is the reason grouped into themes and which (optionally) the reference, the monitor's model, the business context, and the cadence.",
      ),
      response: errors(401, 403, 404),
    },
  )
  .put(
    "/config",
    async ({ tenantContext, body, request }) => {
      const refused = unknownKeyRefusals.get(request);
      if (refused) throw refused;
      return {
        instance: instanceIdentity,
        occurrences: await updateOccurrencesSettings(
          ctxOrThrow(tenantContext),
          body,
        ),
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      // Read here, answered in the handler: a request without a session is told to sign in first.
      transform: ({ body, request }) => {
        try {
          refuseUnknownOccurrenceKeys(body);
        } catch (err) {
          unknownKeyRefusals.set(request, err);
        }
      },
      body: patchBody,
      detail: doc(
        "Set the occurrence monitor",
        "Changes any part of the monitor; a field left out keeps its value, `fields` and `inboxIds` replace their lists. Switching it on needs an inbox, the model and a reason field (a declared field); the reference field is optional. An inbox the write adds must be received by an agent (bound or observing).",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/runs",
    async ({ tenantContext, query }) => ({
      instance: instanceIdentity,
      ...(await pageOccurrenceRuns(ctxOrThrow(tenantContext), {
        limit: query.limit === undefined ? 20 : Number(query.limit),
        before: query.before ?? null,
      })),
    }),
    {
      requireRole: "TENANT_ADMIN",
      query: t.Object({
        limit: t.Optional(
          t.Numeric({
            minimum: RUNS_LIMIT_RANGE.min,
            maximum: RUNS_LIMIT_RANGE.max,
            description: "How many rounds to return, 1 to 200 (default 20).",
          }),
        ),
        before: t.Optional(
          t.String({
            pattern: "^[1-9][0-9]{0,18}$",
            description:
              "The next page: pass back `nextBefore` from the previous one. The rounds older than that round, so a round that starts meanwhile never shifts a page.",
          }),
        ),
      }),
      detail: doc(
        "List the monitor's rounds",
        "The rounds, newest first, a page at a time: when each ran, how long it took, how many conversations it read and how many were still waiting, what each step did and why a step did not complete, how many model calls it made and what they cost. `total` counts every round; `nextBefore` is null on the last page.",
      ),
      response: errors(401, 403, 404, 422),
    },
  )
  .get(
    "/themes",
    async ({ tenantContext, query }) => {
      const ctx = ctxOrThrow(tenantContext);
      const flaggedOnly = query.flagged === "true";
      const [themes, total] = await Promise.all([
        listThemes(ctx, {
          flaggedOnly,
          ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
        }),
        countThemes(ctx, { flaggedOnly }),
      ]);
      return { instance: instanceIdentity, themes, total };
    },
    {
      requireRole: "TENANT_ADMIN",
      query: t.Object({
        flagged: t.Optional(
          t.Union([t.Literal("true"), t.Literal("false")], {
            description: "Only the flagged themes.",
          }),
        ),
        limit: t.Optional(
          t.Numeric({
            minimum: THEMES_LIMIT_RANGE.min,
            maximum: THEMES_LIMIT_RANGE.max,
            description: "How many themes, 1 to 500 (default 100).",
          }),
        ),
      }),
      detail: doc(
        "List the open themes",
        "The open themes, flagged first: title, why it is flagged, its reference, how many conversations (absorbed themes included) and when it was first and last seen. `total` counts every open theme, past the limit too.",
      ),
      response: errors(401, 403, 404, 422),
    },
  )
  .get(
    "/cost",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      ...(await occurrenceCost(ctxOrThrow(tenantContext))),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Get the monitor's cost",
        "What the monitor's model calls cost over the last 7 and the last 30 days, every step included. `costUsd` sums the priced calls and is null when none had a price; `unpricedCalls` says how many it leaves out.",
      ),
      response: errors(401, 403, 404),
    },
  )
  .get(
    "/themes/:id",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      theme: await getTheme(
        ctxOrThrow(tenantContext),
        requireDbId(params.id, "theme id"),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: t.Object({ id: t.String() }),
      detail: doc(
        "Get a theme",
        "One theme with its newest conversations, each with its own reason sentence verbatim and a link to Chatwoot, and what consolidation did to it. An absorbed theme answers as its survivor.",
      ),
      response: errors(400, 401, 403, 404),
    },
  );
