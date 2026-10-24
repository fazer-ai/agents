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
  createMonitor,
  deleteMonitor,
  duplicateMonitor,
  getMonitorView,
  getOccurrencesSettings,
  listMonitors,
  MONITOR_NAME_MAX,
  MONITORS_MAX,
  renameMonitor,
  requireMonitor,
  resolveMonitor,
  updateMonitorConfig,
  updateOccurrencesSettings,
} from "@/modules/occurrences/monitors";
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

// The account's occurrence monitors (docs/occurrences.md): each one's configuration, themes and
// rounds under `/monitors/:id`, and the paths of before there were several, which answer for the
// account's first monitor. TENANT_ADMIN.
//
// translate('errors.occurrenceMonitorLimit', 'An account holds at most {{max}} occurrence monitors. Delete one to create another.')
// translate('errors.occurrenceMonitorNameRequired', 'A monitor needs a name.')
// translate('errors.occurrenceMonitorNameTooLong', 'A monitor's name has at most {{max}} characters.')
// translate('errors.occurrenceMonitorNameUnstorable', 'The monitor's name has characters that cannot be stored.')
// translate('errors.occurrenceMonitorNotFound', 'Occurrence monitor not found.')
// translate('errors.occurrenceThemeNotFound', 'Theme not found.')
// translate('errors.occurrenceMonitorNameTaken', 'A monitor named {{name}} already exists.')
// translate('errors.occurrenceMonitorAttributeTaken', 'The monitor {{monitor}} already writes the Chatwoot attribute {{key}} on the inbox {{inbox}}. Give this field another key, or turn off its copy to Chatwoot.')

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
  recoverMedia: t.Optional(
    t.Boolean({
      description:
        "Transcribe and describe again, at reading time, a voice note or image upstream Chatwoot no longer holds, with the inbox agent's speech-to-text and vision. Off by default; billed on its own cost lines.",
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

const SET_DOC =
  "Changes any part of the monitor; a field left out keeps its value, `fields` and `inboxIds` replace their lists. Switching it on needs an inbox, the model and a reason field (a declared field); the reference field is optional. An inbox the write adds must be received by an agent (bound or observing).";

const monitorParams = t.Object({
  id: t.String({ description: "The monitor's id." }),
});

const monitorName = t.String({
  minLength: 1,
  maxLength: MONITOR_NAME_MAX,
  description: "The monitor's name, unique in the account.",
});

const runsQuery = t.Object({
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
});

const themesQuery = t.Object({
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
});

const runsPage = (
  ctx: TenantContext,
  monitorId: bigint,
  query: { limit?: number; before?: string },
) =>
  pageOccurrenceRuns(ctx, monitorId, {
    limit: query.limit === undefined ? 20 : Number(query.limit),
    before: query.before ?? null,
  });

async function themesPage(
  ctx: TenantContext,
  monitorId: bigint,
  query: { flagged?: "true" | "false"; limit?: number },
) {
  const flaggedOnly = query.flagged === "true";
  const [themes, total] = await Promise.all([
    listThemes(ctx, monitorId, {
      flaggedOnly,
      ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
    }),
    countThemes(ctx, monitorId, { flaggedOnly }),
  ]);
  return { themes, total };
}

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
        "Get the first monitor's configuration",
        "The configuration of the account's first monitor, as `GET /v1/occurrences/monitors/{id}/config` answers it; the defaults when the account has none. From before there were several monitors; name the monitor instead.",
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
        "Set the first monitor's configuration",
        `${SET_DOC} Writes the account's first monitor, and creates it (named "Ocorrências") when the account has none. From before there were several monitors; name the monitor instead.`,
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/runs",
    async ({ tenantContext, query }) => {
      const ctx = ctxOrThrow(tenantContext);
      const first = await resolveMonitor(ctx, undefined);
      return {
        instance: instanceIdentity,
        ...(first
          ? await runsPage(ctx, first.id, query)
          : { runs: [], total: 0, nextBefore: null }),
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      query: runsQuery,
      detail: doc(
        "List the first monitor's rounds",
        "The rounds of the account's first monitor, as `GET /v1/occurrences/monitors/{id}/runs` lists them. From before there were several monitors; name the monitor instead.",
      ),
      response: errors(401, 403, 404, 422),
    },
  )
  .get(
    "/themes",
    async ({ tenantContext, query }) => {
      const ctx = ctxOrThrow(tenantContext);
      const first = await resolveMonitor(ctx, undefined);
      return {
        instance: instanceIdentity,
        ...(first
          ? await themesPage(ctx, first.id, query)
          : { themes: [], total: 0 }),
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      query: themesQuery,
      detail: doc(
        "List the first monitor's open themes",
        "The open themes of the account's first monitor, as `GET /v1/occurrences/monitors/{id}/themes` lists them. From before there were several monitors; name the monitor instead.",
      ),
      response: errors(401, 403, 404, 422),
    },
  )
  .get(
    "/cost",
    async ({ tenantContext }) => {
      const ctx = ctxOrThrow(tenantContext);
      const first = await resolveMonitor(ctx, undefined);
      return {
        instance: instanceIdentity,
        // No monitor yet has spent nothing: the cost of an id no round carries.
        ...(await occurrenceCost(ctx, first?.id ?? 0n)),
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Get the first monitor's cost",
        "What the account's first monitor cost, as `GET /v1/occurrences/monitors/{id}/cost` says. From before there were several monitors; name the monitor instead.",
      ),
      response: errors(401, 403, 404),
    },
  )
  .get(
    "/themes/:id",
    async ({ tenantContext, params }) => {
      const ctx = ctxOrThrow(tenantContext);
      const first = await resolveMonitor(ctx, undefined);
      if (!first)
        throw new AppError(
          "theme not found",
          404,
          "errors.occurrenceThemeNotFound",
        );
      return {
        instance: instanceIdentity,
        theme: await getTheme(
          ctx,
          first.id,
          requireDbId(params.id, "theme id"),
        ),
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: t.Object({ id: t.String() }),
      detail: doc(
        "Get a theme of the first monitor",
        "One theme of the account's first monitor, as `GET /v1/occurrences/monitors/{id}/themes/{themeId}` answers it. From before there were several monitors; name the monitor instead.",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .get(
    "/monitors",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      monitors: await listMonitors(ctxOrThrow(tenantContext)),
      max: MONITORS_MAX,
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List the occurrence monitors",
        `The account's monitors, first first: name, whether it is on, the inboxes it reads, its newest round, its open themes and how many rounds it has. At most ${MONITORS_MAX} per account (\`max\`).`,
      ),
      response: errors(401, 403, 404),
    },
  )
  .post(
    "/monitors",
    async ({ tenantContext, body, set }) => {
      set.status = 201;
      return {
        instance: instanceIdentity,
        monitor: await createMonitor(ctxOrThrow(tenantContext), body),
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      body: t.Object({ name: monitorName }),
      detail: doc(
        "Create an occurrence monitor",
        `A new monitor, off, with the default configuration; configure it with \`PUT /v1/occurrences/monitors/{id}/config\`. The name is unique in the account (409 when taken). At most ${MONITORS_MAX} per account (422).`,
      ),
      response: errors(400, 401, 403, 404, 409, 422),
    },
  )
  .get(
    "/monitors/:id",
    async ({ tenantContext, params }) => {
      const ctx = ctxOrThrow(tenantContext);
      const id = requireDbId(params.id, "monitor id");
      const m = await requireMonitor(ctx, id);
      return {
        instance: instanceIdentity,
        monitor: await getMonitorView(ctx, id),
        occurrences: m.config,
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: monitorParams,
      detail: doc(
        "Get an occurrence monitor",
        "The monitor as the list shows it, and its configuration.",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .patch(
    "/monitors/:id",
    async ({ tenantContext, params, body }) => ({
      instance: instanceIdentity,
      monitor: await renameMonitor(
        ctxOrThrow(tenantContext),
        requireDbId(params.id, "monitor id"),
        body,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: monitorParams,
      body: t.Object({ name: monitorName }),
      detail: doc(
        "Rename an occurrence monitor",
        "The name is unique in the account (409 when taken).",
      ),
      response: errors(400, 401, 403, 404, 409, 422),
    },
  )
  .delete(
    "/monitors/:id",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      ...(await deleteMonitor(
        ctxOrThrow(tenantContext),
        requireDbId(params.id, "monitor id"),
      )),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: monitorParams,
      detail: doc(
        "Delete an occurrence monitor",
        "Deletes the monitor with its readings, themes, canonicals and rounds, and stops its rounds. Answers how many open themes and rounds went with it.",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .post(
    "/monitors/:id/duplicate",
    async ({ tenantContext, params, body, set }) => {
      set.status = 201;
      return {
        instance: instanceIdentity,
        monitor: await duplicateMonitor(
          ctxOrThrow(tenantContext),
          requireDbId(params.id, "monitor id"),
          body ?? {},
        ),
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: monitorParams,
      body: t.Optional(t.Object({ name: t.Optional(monitorName) })),
      detail: doc(
        "Duplicate an occurrence monitor",
        `A new monitor with the same configuration, off and with no inboxes, so it never reads a conversation twice by accident; themes and rounds stay with the original. Without a name it is the original's, numbered ("Name (2)"). At most ${MONITORS_MAX} per account (422).`,
      ),
      response: errors(400, 401, 403, 404, 409, 422),
    },
  )
  .get(
    "/monitors/:id/config",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      occurrences: (
        await requireMonitor(
          ctxOrThrow(tenantContext),
          requireDbId(params.id, "monitor id"),
        )
      ).config,
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: monitorParams,
      detail: doc(
        "Get a monitor's configuration",
        "The inboxes it reads, the fields it reads off each conversation, which one is the reason grouped into themes and which (optionally) the reference, the model, the business context, and the cadence.",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .put(
    "/monitors/:id/config",
    async ({ tenantContext, params, body, request }) => {
      const refused = unknownKeyRefusals.get(request);
      if (refused) throw refused;
      return {
        instance: instanceIdentity,
        occurrences: await updateMonitorConfig(
          ctxOrThrow(tenantContext),
          requireDbId(params.id, "monitor id"),
          body,
        ),
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: monitorParams,
      transform: ({ body, request }) => {
        try {
          refuseUnknownOccurrenceKeys(body);
        } catch (err) {
          unknownKeyRefusals.set(request, err);
        }
      },
      body: patchBody,
      detail: doc(
        "Set a monitor's configuration",
        `${SET_DOC} A field copied to a Chatwoot attribute that another monitor already copies to on a shared inbox is refused (422), naming that monitor.`,
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/monitors/:id/runs",
    async ({ tenantContext, params, query }) => {
      const ctx = ctxOrThrow(tenantContext);
      const m = await requireMonitor(ctx, requireDbId(params.id, "monitor id"));
      return {
        instance: instanceIdentity,
        ...(await runsPage(ctx, m.id, query)),
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: monitorParams,
      query: runsQuery,
      detail: doc(
        "List a monitor's rounds",
        "The rounds, newest first, a page at a time: when each ran, how long it took, how many conversations it read and how many were still waiting, what each step did and why a step did not complete, how many model calls it made and what they cost. `total` counts every round; `nextBefore` is null on the last page.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/monitors/:id/themes",
    async ({ tenantContext, params, query }) => {
      const ctx = ctxOrThrow(tenantContext);
      return {
        instance: instanceIdentity,
        ...(await themesPage(ctx, requireDbId(params.id, "monitor id"), query)),
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: monitorParams,
      query: themesQuery,
      detail: doc(
        "List a monitor's open themes",
        "The open themes, flagged first: title, why it is flagged, its reference, how many conversations (absorbed themes included) and when it was first and last seen. `total` counts every open theme, past the limit too.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/monitors/:id/themes/:themeId",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      theme: await getTheme(
        ctxOrThrow(tenantContext),
        requireDbId(params.id, "monitor id"),
        requireDbId(params.themeId, "theme id"),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: t.Object({ id: t.String(), themeId: t.String() }),
      detail: doc(
        "Get a theme",
        "One theme with its newest conversations, each with its own reason sentence verbatim and a link to Chatwoot, and what consolidation did to it. An absorbed theme answers as its survivor.",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .get(
    "/monitors/:id/cost",
    async ({ tenantContext, params }) => {
      const ctx = ctxOrThrow(tenantContext);
      const m = await requireMonitor(ctx, requireDbId(params.id, "monitor id"));
      return {
        instance: instanceIdentity,
        ...(await occurrenceCost(ctx, m.id)),
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: monitorParams,
      detail: doc(
        "Get a monitor's cost",
        "What the monitor's model calls cost over the last 7 and the last 30 days, every step included. `costUsd` sums the priced calls and is null when none had a price; `unpricedCalls` says how many it leaves out.",
      ),
      response: errors(400, 401, 403, 404),
    },
  );
