import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tRanged } from "@/api/lib/ranged";
import {
  confirmStepUp,
  requireSession,
  STEP_UP_PASSWORD_DESCRIPTION,
} from "@/api/lib/step-up";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import config from "@/config";
import { requireDbId } from "@/lib/db-id";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import { CLIENT_APP_RANGES } from "@/modules/client-apps/ranges";
import {
  createClientApp,
  deleteClientApp,
  getClientApp,
  listClientApps,
  revokeClientAppSecret,
  rotateClientAppSecret,
  updateClientApp,
} from "@/modules/client-apps/service";

// The web applications that embed an agent through the client channel's SDK (docs/client-channel.md,
// "Embedding with the SDK"). Creating an app and rotating its key mint a secret, shown once, so both
// are a person's act confirmed with their password, as minting an API key is. Off with the client
// channel (CLIENT_CHANNEL_ENABLED), these routes do not exist (`clientChannelGate`).
// translate('errors.clientAppNotFound', 'Application not found')
// translate('errors.clientAppSecretNotFound', 'Key not found')
// translate('errors.clientAppTurnstileIncomplete', 'The Turnstile challenge needs its site key and secret')

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

const hide = () => !config.clientChannel.enabled;

const appId = t.Object({
  id: t.String({ description: "Application id (BigInt as a string)." }),
});

const origins = t.Array(t.String({ maxLength: 300 }), {
  maxItems: 20,
  description:
    "Exact origins the browser may call from (`https://app.example.com`): https, or http on localhost; no path and no wildcard.",
});

const anonSessionsPerHour = tRanged(CLIENT_APP_RANGES.anonSessionsPerHour, {
  description:
    "New anonymous sessions one address may open per hour. 20 by default.",
});
const anonMessagesPerMin = tRanged(CLIENT_APP_RANGES.anonMessagesPerMin, {
  description:
    "Messages one anonymous session may send per minute. 10 by default.",
});

const anonExpiryDays = tRanged(CLIENT_APP_RANGES.anonExpiryDays, {
  description:
    "Days an anonymous conversation may sit with no message before it is deleted. 30 by default.",
});

const monthlyCeilingUsd = t.Union(
  [tRanged(CLIENT_APP_RANGES.monthlyCeilingUsd), t.Null()],
  {
    description:
      "The app's own monthly spend ceiling in USD (kept to the cent); null for none. Its turns are refused past it; the tenant's client ceiling still applies.",
  },
);

const turnstileEnabled = t.Boolean({
  description:
    "Whether a new anonymous session must first pass a Cloudflare Turnstile challenge. Needs the site key and the secret; off by default.",
});
const turnstileSiteKey = t.Union(
  [t.String({ minLength: 1, maxLength: 200 }), t.Null()],
  {
    description:
      "The Turnstile widget's public site key, which the page passes to the challenge.",
  },
);
const turnstileSecret = t.Union(
  [t.String({ minLength: 1, maxLength: 200 }), t.Null()],
  {
    description:
      "The Turnstile secret the server verifies the challenge with. Stored encrypted and never returned: the app only says whether one is set (`turnstileSecretSet`).",
  },
);

const SECRET_NOTE =
  "The key (`secret.secret`) is returned ONCE and never again; the application's server signs its users' JWTs with it (HS256), naming it in the JWT header as `kid`.";

export const clientAppsController = new Elysia({
  prefix: "/v1/client-apps",
  tags: ["Client apps"],
})
  .use(tenancyPlugin)
  .get(
    "/",
    async ({ tenantContext, query }) => ({
      instance: instanceIdentity,
      clientApps: await listClientApps(
        ctxOrThrow(tenantContext),
        requireDbId(query.agentId),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      query: t.Object({
        agentId: t.String({ description: "The agent the apps embed." }),
      }),
      detail: {
        ...doc(
          "List client apps",
          "Returns the applications that embed this agent, with the ids of the keys that still verify; never a key.",
        ),
        hide: hide(),
      },
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/:id",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      clientApp: await getClientApp(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: appId,
      detail: { ...doc("Get client app", "One application."), hide: hide() },
      response: errors(400, 401, 403, 404),
    },
  )
  .post(
    "/",
    async ({ tenantContext, body }) => {
      const ctx = ctxOrThrow(tenantContext);
      requireSession(ctx);
      await confirmStepUp(ctx, body.password);
      const created = await createClientApp(ctx, requireDbId(body.agentId), {
        name: body.name,
        allowedOrigins: body.allowedOrigins,
        anonymousEnabled: body.anonymousEnabled,
        anonSessionsPerHour: body.anonSessionsPerHour,
        anonMessagesPerMin: body.anonMessagesPerMin,
        anonExpiryDays: body.anonExpiryDays,
        monthlyCeilingUsd: body.monthlyCeilingUsd,
        turnstileEnabled: body.turnstileEnabled,
        turnstileSiteKey: body.turnstileSiteKey,
        turnstileSecret: body.turnstileSecret,
      });
      return {
        instance: instanceIdentity,
        clientApp: created.app,
        secret: created.secret,
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      body: t.Object({
        agentId: t.String({ description: "The agent the app embeds." }),
        name: t.String({ minLength: 1, maxLength: 120 }),
        allowedOrigins: origins,
        anonymousEnabled: t.Optional(
          t.Boolean({
            description:
              "Whether a page with no signed user may open a session of its own. Off by default.",
          }),
        ),
        anonSessionsPerHour: t.Optional(anonSessionsPerHour),
        anonMessagesPerMin: t.Optional(anonMessagesPerMin),
        anonExpiryDays: t.Optional(anonExpiryDays),
        monthlyCeilingUsd: t.Optional(monthlyCeilingUsd),
        turnstileEnabled: t.Optional(turnstileEnabled),
        turnstileSiteKey: t.Optional(turnstileSiteKey),
        turnstileSecret: t.Optional(turnstileSecret),
        password: t.String({
          minLength: 1,
          description: STEP_UP_PASSWORD_DESCRIPTION,
        }),
      }),
      detail: {
        ...doc(
          "Create client app",
          `Registers an application that embeds the agent and mints its first key. ${SECRET_NOTE} Only a signed-in session may create one, confirmed with its current password.`,
        ),
        hide: hide(),
      },
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .patch(
    "/:id",
    async ({ tenantContext, params, body }) => ({
      instance: instanceIdentity,
      clientApp: await updateClientApp(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
        body,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: appId,
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
        allowedOrigins: t.Optional(origins),
        anonymousEnabled: t.Optional(t.Boolean()),
        anonSessionsPerHour: t.Optional(anonSessionsPerHour),
        anonMessagesPerMin: t.Optional(anonMessagesPerMin),
        anonExpiryDays: t.Optional(anonExpiryDays),
        monthlyCeilingUsd: t.Optional(monthlyCeilingUsd),
        turnstileEnabled: t.Optional(turnstileEnabled),
        turnstileSiteKey: t.Optional(turnstileSiteKey),
        turnstileSecret: t.Optional(turnstileSecret),
      }),
      detail: {
        ...doc(
          "Update client app",
          "Renames the app, replaces its origins, turns anonymous sessions on or off, sets their limits and how long an idle one is kept, sets the app's monthly spend ceiling, or configures the Turnstile challenge before a new anonymous session.",
        ),
        hide: hide(),
      },
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .delete(
    "/:id",
    async ({ tenantContext, params }) => {
      await deleteClientApp(ctxOrThrow(tenantContext), requireDbId(params.id));
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: appId,
      detail: {
        ...doc(
          "Delete client app",
          "Removes the app and its keys: every token it signed stops verifying at once.",
        ),
        hide: hide(),
      },
      response: errors(400, 401, 403, 404),
    },
  )
  .post(
    "/:id/secrets",
    async ({ tenantContext, params, body }) => {
      const ctx = ctxOrThrow(tenantContext);
      requireSession(ctx);
      await confirmStepUp(ctx, body.password);
      const rotated = await rotateClientAppSecret(ctx, requireDbId(params.id));
      return {
        instance: instanceIdentity,
        clientApp: rotated.app,
        secret: rotated.secret,
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: appId,
      body: t.Object({
        password: t.String({
          minLength: 1,
          description: STEP_UP_PASSWORD_DESCRIPTION,
        }),
      }),
      detail: {
        ...doc(
          "Rotate client app key",
          `Mints a new current key; the previous one keeps verifying for 24 hours so users already signed in stay signed in, and any key in an older grace window ends now. ${SECRET_NOTE}`,
        ),
        hide: hide(),
      },
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .delete(
    "/:id/secrets/:kid",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      clientApp: await revokeClientAppSecret(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
        params.kid,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({ description: "Application id (BigInt as a string)." }),
        kid: t.String({ description: "The key's id (`kid`)." }),
      }),
      detail: {
        ...doc(
          "Revoke client app key",
          "Ends a key now, for a key believed leaked. Tokens it signed stop verifying at once; revoking the current key leaves the app signing nobody in until the next rotation.",
        ),
        hide: hide(),
      },
      response: errors(400, 401, 403, 404),
    },
  );
