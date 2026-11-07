import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import metricsPrisma from "@/api/lib/prisma-metrics";
import { tRanged } from "@/api/lib/ranged";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import config from "@/config";
import { requireDbId } from "@/lib/db-id";
import { instanceIdentity } from "@/lib/instance";
import {
  createInstanceAlertChannel,
  deleteInstanceAlertChannel,
  type InstanceAlertChannelCreate,
  type InstanceAlertChannelUpdate,
  listInstanceAlertChannels,
  listInstanceThresholds,
  resetInstanceThreshold,
  sendInstanceAlertChannelTest,
  setInstanceThreshold,
  updateInstanceAlertChannel,
} from "@/modules/instance-health/channels";
import type { WindowKey } from "@/modules/instance-health/database/read";
import { readDatabaseView } from "@/modules/instance-health/database/view";
import {
  readInstanceHealth,
  requireFleet,
} from "@/modules/instance-health/read";
import { INSTANCE_THRESHOLD_RANGES } from "@/modules/instance-health/signals";

// The instance's own load and its alert channels (docs/logs.md, instance alerts). SUPER_ADMIN only:
// a session or a fleet API key; a tenant principal is refused by the role gate and by the service.
// The services throw these translationKeys; declared here for the API i18n extractor.
// translate('errors.unknownInstanceSignal', 'Unknown instance signal: {{signal}}')
// translate('errors.instanceChannelNeedsUrl', 'This channel has no URL yet: set it before enabling or testing it')
// translate('errors.alertChannelNotFound', 'Alert channel not found')
// translate('errors.noUpdatableFields', 'No updatable fields provided')

const idParams = t.Object({
  id: t.String({
    description: "Instance alert channel id (BigInt serialized as a string).",
  }),
});

const signalParams = t.Object({
  signal: t.String({
    description: "Signal key, from GET /v1/instance-health.",
  }),
});

const typeSchema = t.Union([t.Literal("discord"), t.Literal("webhook")], {
  description:
    "Sink type: discord (Discord webhook) or webhook (generic HTTP endpoint, HMAC-signed when a secret is set).",
});

export const instanceHealthController = new Elysia({
  prefix: "/v1/instance-health",
  tags: ["Instance health"],
})
  .use(tenancyPlugin)
  .get(
    "/",
    async ({ tenantContext }) => {
      requireFleet(tenantContext);
      return {
        instance: instanceIdentity,
        // Off the main pool, like its authentication: this is the screen an alert about a
        // saturated main pool links to.
        health: await readInstanceHealth(
          config.alertWorker.enabled,
          metricsPrisma,
        ),
      };
    },
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "Read instance health",
        "Returns every instance signal (pools, queues, ingress lag, event loop) with its last value, the last hour sampled every 5 s, its threshold and whether it is firing. In memory: a restart starts the history empty.",
      ),
      response: errors(401, 403),
    },
  )
  .get(
    "/database",
    async ({ tenantContext, query }) => {
      requireFleet(tenantContext);
      return {
        instance: instanceIdentity,
        database: await readDatabaseView(
          (query.window ?? "1h") as WindowKey,
          metricsPrisma,
          config.alertWorker.enabled,
        ),
      };
    },
    {
      requireRole: "SUPER_ADMIN",
      query: t.Object({
        window: t.Optional(
          t.Union([t.Literal("1h"), t.Literal("24h"), t.Literal("7d")], {
            description: "The window the statement figures cover. Default 1h.",
          }),
        ),
      }),
      detail: doc(
        "Read the database screen",
        "Returns the database's own figures: the two statement signals (timeouts per minute, slowest mean as a share of the budget) with their value, threshold and state against it; pg_stat_statements deltas over the window (top statements by total and by mean time, with calls, rows, the mean as a share of DB_TX_TIMEOUT_MS and a mean-time series; or, without the extension, how to enable it), the statements that hit their statement_timeout with the plan captured under the scope they ran in and the window's count of them, the size of the screen's tables and their growth, per table its size, growth, tuples, dead-row ratio, whether autovacuum is overdue and vacuum times, never-scanned indexes and the tables read most by sequential scan. Statement texts are normalized by Postgres ($N for every value).",
      ),
      response: errors(401, 403, 422, 503),
    },
  )
  .get(
    "/channels",
    async ({ tenantContext }) => {
      requireFleet(tenantContext);
      return {
        instance: instanceIdentity,
        channels: await listInstanceAlertChannels(metricsPrisma),
      };
    },
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "List instance alert channels",
        "Returns the instance's alert channels; the url is returned only as a masked preview and the signing secret never.",
      ),
      response: errors(401, 403),
    },
  )
  .post(
    "/channels",
    async ({ tenantContext, body }) => ({
      instance: instanceIdentity,
      channel: await createInstanceAlertChannel(
        requireFleet(tenantContext),
        body as InstanceAlertChannelCreate,
      ),
    }),
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "Create instance alert channel",
        "Creates an alert channel of the instance (not of a tenant). The url and the signing secret go in on write; neither comes back.",
      ),
      body: t.Object({
        name: t.String({
          minLength: 1,
          maxLength: 120,
          description: "Display label.",
        }),
        type: typeSchema,
        url: t.String({
          minLength: 1,
          maxLength: 2048,
          description: "Delivery url; stored encrypted, returned only masked.",
        }),
        signals: t.Optional(
          t.Array(t.String(), {
            description:
              "Signals this channel alerts on; empty or absent means all.",
          }),
        ),
        secret: t.Optional(
          t.Nullable(
            t.String({
              minLength: 1,
              maxLength: 256,
              description: "HMAC signing secret (webhook type); write-only.",
            }),
          ),
        ),
        enabled: t.Optional(
          t.Boolean({ description: "Whether the channel receives alerts." }),
        ),
      }),
      response: errors(400, 401, 403, 422),
    },
  )
  .patch(
    "/channels/:id",
    async ({ tenantContext, params, body }) => ({
      instance: instanceIdentity,
      channel: await updateInstanceAlertChannel(
        requireFleet(tenantContext),
        requireDbId(params.id),
        body as InstanceAlertChannelUpdate,
      ),
    }),
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "Update instance alert channel",
        "Updates fields of an instance alert channel. `secret: null` clears the signing secret.",
      ),
      params: idParams,
      body: t.Object({
        name: t.Optional(
          t.String({ minLength: 1, maxLength: 120, description: "New label." }),
        ),
        type: t.Optional(typeSchema),
        url: t.Optional(
          t.String({
            minLength: 1,
            maxLength: 2048,
            description: "New delivery url.",
          }),
        ),
        signals: t.Optional(
          t.Array(t.String(), {
            description: "Replaces the signal allowlist; [] means all.",
          }),
        ),
        secret: t.Optional(
          t.Nullable(
            t.String({
              minLength: 1,
              maxLength: 256,
              description: "New signing secret, or null.",
            }),
          ),
        ),
        enabled: t.Optional(
          t.Boolean({ description: "Whether the channel receives alerts." }),
        ),
      }),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .delete(
    "/channels/:id",
    async ({ tenantContext, params }) => {
      await deleteInstanceAlertChannel(
        requireFleet(tenantContext),
        requireDbId(params.id),
      );
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "Delete instance alert channel",
        "Removes an instance alert channel.",
      ),
      params: idParams,
      response: errors(400, 401, 403, 404),
    },
  )
  .post(
    "/channels/:id/test",
    async ({ tenantContext, params }) => {
      requireFleet(tenantContext);
      return {
        instance: instanceIdentity,
        result: await sendInstanceAlertChannelTest(requireDbId(params.id)),
      };
    },
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "Test instance alert channel",
        "Synchronously posts a sample alert through the same send a real one takes and returns the outcome; writes no delivery.",
      ),
      params: idParams,
      response: errors(400, 401, 403, 404),
    },
  )
  .get(
    "/thresholds",
    async ({ tenantContext }) => {
      requireFleet(tenantContext);
      return {
        instance: instanceIdentity,
        thresholds: await listInstanceThresholds(),
      };
    },
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "List instance thresholds",
        'Returns each signal\'s threshold and duration ("above X for Y seconds"), with its default.',
      ),
      response: errors(401, 403),
    },
  )
  .put(
    "/thresholds/:signal",
    async ({ tenantContext, params, body }) => ({
      instance: instanceIdentity,
      threshold: await setInstanceThreshold(
        requireFleet(tenantContext),
        params.signal,
        body,
      ),
    }),
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "Set instance threshold",
        "Overrides one signal's threshold and duration. Takes effect on the next sample.",
      ),
      params: signalParams,
      body: t.Object({
        threshold: t.Number({
          minimum: 0,
          description:
            "Alert when the value is above this, in the signal's unit.",
        }),
        durationSeconds: tRanged(INSTANCE_THRESHOLD_RANGES.durationSeconds, {
          description:
            "How long the value must stay above before it alerts; 0 alerts on the first sample.",
        }),
        enabled: t.Optional(
          t.Boolean({ description: "false never alerts on this signal." }),
        ),
      }),
      response: errors(400, 401, 403, 422),
    },
  )
  .delete(
    "/thresholds/:signal",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      threshold: await resetInstanceThreshold(
        requireFleet(tenantContext),
        params.signal,
      ),
    }),
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "Reset instance threshold",
        "Drops the override; the signal goes back to its default.",
      ),
      params: signalParams,
      response: errors(400, 401, 403),
    },
  );
