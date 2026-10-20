import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { AppError } from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import {
  assertTurnstileComplete,
  type ClientAppUpdate,
  clientAppUpdateSchema,
  deleteClientApp,
  getClientApp,
  listClientApps,
  revokeClientAppSecret,
  updateClientApp,
} from "@/modules/client-apps/service";
import type { VerifiedToken } from "./oauth/tokens";
import {
  diffFields,
  err,
  gate,
  ok,
  parseMcpId,
  readGate,
  type WriteDeps,
  type WriteResult,
} from "./write";

// MCP tools for the applications that embed an agent through the client channel's SDK
// (docs/client-channel.md, "Embedding with the SDK"). Creating an app and rotating its key mint a
// secret that would have to cross the model, so both stay in the console, as creating an API key
// does; reading, editing, deleting and revoking a key are here. The services audit their own writes.

function failOf(e: unknown): WriteResult {
  if (e instanceof AppError) return err(e.message);
  throw e;
}

const channelOff = () =>
  config.clientChannel.enabled
    ? null
    : err(
        "the client channel is off on this instance (CLIENT_CHANNEL_ENABLED)",
      );

export async function clientAppList(
  principal: VerifiedToken,
  args: { agent_id: string },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const off = channelOff();
  if (off) return off;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  const agentId = parseMcpId(args.agent_id, "agent_id");
  if (typeof agentId !== "bigint") return agentId;
  try {
    return ok({
      clientApps: await listClientApps(ctx, agentId, deps.base ?? basePrisma),
    });
  } catch (e) {
    return failOf(e);
  }
}

export async function clientAppUpdate(
  principal: VerifiedToken,
  args: {
    client_app_id: string;
    name?: string;
    allowed_origins?: string[];
    anonymous_enabled?: boolean;
    anon_sessions_per_hour?: number;
    anon_messages_per_min?: number;
    anon_expiry_days?: number;
    monthly_ceiling_usd?: number | null;
    turnstile_enabled?: boolean;
    turnstile_site_key?: string | null;
    dry_run?: boolean;
  },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const off = channelOff();
  if (off) return off;
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.client_app_id, "client_app_id");
  if (typeof id !== "bigint") return id;
  const input: ClientAppUpdate = {
    ...(args.name !== undefined && { name: args.name }),
    ...(args.allowed_origins !== undefined && {
      allowedOrigins: args.allowed_origins,
    }),
    ...(args.anonymous_enabled !== undefined && {
      anonymousEnabled: args.anonymous_enabled,
    }),
    ...(args.anon_sessions_per_hour !== undefined && {
      anonSessionsPerHour: args.anon_sessions_per_hour,
    }),
    ...(args.anon_messages_per_min !== undefined && {
      anonMessagesPerMin: args.anon_messages_per_min,
    }),
    ...(args.anon_expiry_days !== undefined && {
      anonExpiryDays: args.anon_expiry_days,
    }),
    ...(args.monthly_ceiling_usd !== undefined && {
      monthlyCeilingUsd: args.monthly_ceiling_usd,
    }),
    ...(args.turnstile_enabled !== undefined && {
      turnstileEnabled: args.turnstile_enabled,
    }),
    ...(args.turnstile_site_key !== undefined && {
      turnstileSiteKey: args.turnstile_site_key,
    }),
  };
  try {
    if (args.dry_run !== false) {
      const before = await getClientApp(ctx, id, base);
      const after = parseInput(clientAppUpdateSchema, input);
      // NOTE: the preview refuses what the write would, so a dry run never promises a change that 422s.
      assertTurnstileComplete({
        turnstileEnabled: after.turnstileEnabled ?? before.turnstileEnabled,
        turnstileSiteKey:
          after.turnstileSiteKey !== undefined
            ? after.turnstileSiteKey
            : before.turnstileSiteKey,
        turnstileSecret: before.turnstileSecretSet ? "set" : null,
      });
      return ok({
        dryRun: true,
        action: "update",
        target: `client_app:${id}`,
        changes: diffFields(
          before as unknown as Record<string, unknown>,
          after as Record<string, unknown>,
        ),
      });
    }
    return ok({
      dryRun: false,
      applied: true,
      clientApp: await updateClientApp(ctx, id, input, base),
    });
  } catch (e) {
    return failOf(e);
  }
}

export async function clientAppDelete(
  principal: VerifiedToken,
  args: { client_app_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const off = channelOff();
  if (off) return off;
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.client_app_id, "client_app_id");
  if (typeof id !== "bigint") return id;
  const target = `client_app:${id}`;
  try {
    if (args.dry_run !== false) {
      const app = await getClientApp(ctx, id, base);
      return ok({
        dryRun: true,
        action: "delete",
        target,
        name: app.name,
        note: "Removes the app and its keys: every token it signed stops verifying at once.",
      });
    }
    await deleteClientApp(ctx, id, base);
    return ok({ dryRun: false, applied: true, target });
  } catch (e) {
    return failOf(e);
  }
}

export async function clientAppKeyRevoke(
  principal: VerifiedToken,
  args: { client_app_id: string; kid: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const off = channelOff();
  if (off) return off;
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.client_app_id, "client_app_id");
  if (typeof id !== "bigint") return id;
  const target = `client_app:${id}`;
  try {
    if (args.dry_run !== false) {
      const app = await getClientApp(ctx, id, base);
      if (!app.secrets.some((s) => s.kid === args.kid))
        return err("client app key not found");
      return ok({
        dryRun: true,
        action: "revoke_key",
        target,
        kid: args.kid,
        note: "Ends the key now: tokens it signed stop verifying at once. Revoking the current key leaves the app signing nobody in until a new key is minted in the console.",
      });
    }
    return ok({
      dryRun: false,
      applied: true,
      clientApp: await revokeClientAppSecret(ctx, id, args.kid, base),
    });
  } catch (e) {
    return failOf(e);
  }
}
