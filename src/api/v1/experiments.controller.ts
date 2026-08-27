import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import config from "@/config";
import { requireDbId } from "@/lib/db-id";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import {
  createExperiment,
  deleteExperiment,
  experimentResults,
  getExperiment,
  listExperiments,
  updateExperiment,
  type Variant,
} from "@/modules/experiments/service";

// The error catalog this controller's routes answer with. `bun i18n:extract` materialises
// src/api/locales/*.json from these lines and prunes anything nothing references, and
// `ErrorTranslationKey` (src/lib/errors.ts) makes a key that is missing here a type error at the
// throw site rather than an English sentence on a pt-BR caller's screen.
// translate('errors.experimentNotFound', 'Experiment not found.')

// Prompt A/B experiments (per-tenant). TENANT_ADMIN. Variant assignment is deterministic per
// thread; /results joins assignments with ConversionEvents for the win-rate breakdown.

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

function ser(e: {
  id: bigint;
  name: string;
  agentId: bigint | null;
  variants: unknown;
  enabled: boolean;
  createdAt: Date;
  updatedAt?: Date;
}) {
  return {
    ...e,
    id: String(e.id),
    agentId: e.agentId === null ? null : String(e.agentId),
  };
}

const variantSchemaT = t.Object({
  key: t.String({
    minLength: 1,
    description: "Stable identifier for this variant within the experiment.",
  }),
  weight: t.Optional(
    t.Number({
      minimum: 0,
      description:
        "Relative assignment weight; higher means more threads land on this variant.",
    }),
  ),
  systemPrompt: t.Optional(
    t.String({
      maxLength: config.agent.promptMaxChars,
      description: `System prompt override applied when this variant is assigned (up to ${config.agent.promptMaxChars} characters, the same ceiling the agent's own prompt is held to).`,
    }),
  ),
});

export const experimentsController = new Elysia({
  prefix: "/v1/experiments",
  tags: ["Resources"],
})
  .use(tenancyPlugin)
  .get(
    "/",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      experiments: (await listExperiments(ctxOrThrow(tenantContext))).map(ser),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List experiments",
        "List all prompt A/B experiments for the current tenant.",
      ),
      response: errors(401, 403, 404),
    },
  )
  .get(
    "/:id",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      experiment: ser(
        await getExperiment(ctxOrThrow(tenantContext), requireDbId(params.id)),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc("Get experiment", "Fetch a single experiment by id."),
      response: errors(400, 401, 403, 404),
      params: t.Object({
        id: t.String({ description: "Experiment id (BigInt as a string)." }),
      }),
    },
  )
  .get(
    "/:id/results",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      results: await experimentResults(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Get experiment results",
        "Return the per-variant conversion breakdown and win rates for an experiment.",
      ),
      response: errors(400, 401, 403, 404),
      params: t.Object({
        id: t.String({ description: "Experiment id (BigInt as a string)." }),
      }),
    },
  )
  .post(
    "/",
    async ({ tenantContext, body }) => {
      const b = body as {
        name: string;
        agentId?: string | null;
        variants: Variant[];
        enabled?: boolean;
      };
      const created = await createExperiment({
        ctx: ctxOrThrow(tenantContext),
        name: b.name,
        agentId: b.agentId ? BigInt(b.agentId) : undefined,
        variants: b.variants,
        enabled: b.enabled,
      });
      return { instance: instanceIdentity, id: String(created.id) };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Create experiment",
        "Create a prompt A/B experiment with one or more variants.",
      ),
      response: errors(400, 401, 403, 404, 422),
      body: t.Object({
        name: t.String({
          minLength: 1,
          maxLength: 200,
          description: "Human-readable name of the experiment.",
        }),
        agentId: t.Optional(
          t.Union([t.String(), t.Null()], {
            description:
              "Agent this experiment applies to (BigInt as a string), or null for any agent.",
          }),
        ),
        variants: t.Array(variantSchemaT, {
          description:
            "The variants under test; assignment is deterministic per conversation thread.",
        }),
        enabled: t.Optional(
          t.Boolean({
            description:
              "Whether the experiment is active and assigning variants.",
          }),
        ),
      }),
    },
  )
  .patch(
    "/:id",
    async ({ tenantContext, params, body }) => {
      const b = body as {
        name?: string;
        agentId?: string | null;
        variants?: Variant[];
        enabled?: boolean;
      };
      const updated = await updateExperiment({
        ctx: ctxOrThrow(tenantContext),
        id: requireDbId(params.id),
        name: b.name,
        agentId:
          b.agentId === undefined
            ? undefined
            : b.agentId
              ? BigInt(b.agentId)
              : null,
        variants: b.variants,
        enabled: b.enabled,
      });
      return { instance: instanceIdentity, experiment: ser(updated) };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Update experiment",
        "Update an experiment name, target agent, variants, or enabled flag.",
      ),
      response: errors(400, 401, 403, 404, 422),
      params: t.Object({
        id: t.String({ description: "Experiment id (BigInt as a string)." }),
      }),
      body: t.Object({
        name: t.Optional(
          t.String({
            minLength: 1,
            maxLength: 200,
            description: "New name for the experiment.",
          }),
        ),
        agentId: t.Optional(
          t.Union([t.String(), t.Null()], {
            description:
              "New target agent (BigInt as a string), or null to apply to any agent.",
          }),
        ),
        variants: t.Optional(
          t.Array(variantSchemaT, {
            description: "Replacement set of variants for the experiment.",
          }),
        ),
        enabled: t.Optional(
          t.Boolean({
            description:
              "Whether the experiment is active and assigning variants.",
          }),
        ),
      }),
    },
  )
  .delete(
    "/:id",
    async ({ tenantContext, params }) => {
      await deleteExperiment(ctxOrThrow(tenantContext), requireDbId(params.id));
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Delete experiment",
        "Delete an experiment and its variant assignments.",
      ),
      response: errors(400, 401, 403, 404),
      params: t.Object({
        id: t.String({ description: "Experiment id (BigInt as a string)." }),
      }),
    },
  );
