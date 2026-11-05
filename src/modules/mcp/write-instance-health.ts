import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { AppError } from "@/lib/errors";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import type { TenantContext } from "@/lib/tenancy";
import { redactEndpoint } from "@/modules/audit/projection";
import {
  assertEnableHasUrl,
  checkInstanceAlertChannelCreate,
  checkInstanceAlertChannelPending,
  checkInstanceAlertChannelUpdate,
  checkInstanceThreshold,
  createInstanceAlertChannel,
  createPendingInstanceAlertChannel,
  deleteInstanceAlertChannel,
  type InstanceAlertChannelUpdate,
  listInstanceAlertChannels,
  listInstanceThresholds,
  resetInstanceThreshold,
  sendInstanceAlertChannelTest,
  setInstanceThreshold,
  updateInstanceAlertChannel,
} from "@/modules/instance-health/channels";
import {
  readDatabaseScreen,
  type WindowKey,
} from "@/modules/instance-health/database/read";
import { readInstanceHealth } from "@/modules/instance-health/read";
import { isSignalKey } from "@/modules/instance-health/signals";
import { instanceChannelFillUrl } from "@/modules/mcp/console-links";
import { parseMcpId } from "@/modules/mcp/write";
import { hasScope, type VerifiedToken } from "./oauth/tokens";
import { ctxOf, err, ok, type WriteDeps, type WriteResult } from "./write";

// MCP tools for the instance's own load and its alert channels (docs/logs.md, instance alerts).
// mcp:admin and a SUPER_ADMIN token, like the other fleet tools. A channel's url and signing secret
// are accepted write-only (docs/mcp.md, the secret-by-reference exceptions): never returned, shown
// masked in a preview and kept out of the audit row. A channel created without its url stays
// disabled, and the answer carries a console link where the operator fills it.

function failOf(e: unknown): WriteResult {
  if (e instanceof AppError) return err(e.message);
  throw e;
}

function adminGate(principal: VerifiedToken): TenantContext | WriteResult {
  if (!hasScope(principal, "mcp:admin")) {
    return err("insufficient_scope: this tool requires the mcp:admin scope");
  }
  if (principal.role !== "SUPER_ADMIN") {
    return err("forbidden: instance health requires a SUPER_ADMIN token");
  }
  return ctxOf(principal);
}

export async function instanceDatabaseGet(
  principal: VerifiedToken,
  args: { window?: WindowKey },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = adminGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    return ok({
      database: await readDatabaseScreen(args.window ?? "1h", base),
    });
  } catch (e) {
    return failOf(e);
  }
}

export async function instanceHealthGet(
  principal: VerifiedToken,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = adminGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    return ok({
      health: await readInstanceHealth(config.alertWorker.enabled, base),
      thresholds: await listInstanceThresholds(base),
    });
  } catch (e) {
    return failOf(e);
  }
}

export async function instanceAlertChannelList(
  principal: VerifiedToken,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = adminGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    return ok({ channels: await listInstanceAlertChannels(base) });
  } catch (e) {
    return failOf(e);
  }
}

export async function instanceAlertChannelCreate(
  principal: VerifiedToken,
  args: {
    name: string;
    type: "discord" | "webhook";
    signals?: string[];
    url?: string;
    secret?: string;
    enabled?: boolean;
    dry_run?: boolean;
  },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = adminGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    if (args.url === undefined) {
      if (args.secret !== undefined) {
        return err(
          "secret needs url: pass the URL with it, or create the channel without either and fill both from the fillAt link",
        );
      }
      assertEnableHasUrl(args.enabled ?? false, false);
      const input = { name: args.name, type: args.type, signals: args.signals };
      if (args.dry_run !== false) {
        return ok({
          dryRun: true,
          wouldCreate: {
            ...checkInstanceAlertChannelPending(input),
            enabled: false,
            urlMasked: null,
          },
          next: "applied, the answer carries fillAt: a console link where the operator sets the URL and the optional signing secret, and enables the channel",
        });
      }
      const channel = await createPendingInstanceAlertChannel(ctx, input, base);
      return ok({ channel, fillAt: instanceChannelFillUrl(channel.id) });
    }
    const input = {
      name: args.name,
      type: args.type,
      url: args.url,
      signals: args.signals,
      secret: args.secret,
      enabled: args.enabled,
    };
    if (args.dry_run !== false) {
      const checked = checkInstanceAlertChannelCreate(input);
      await assertSafeOutboundUrl(checked.url);
      return ok({
        dryRun: true,
        wouldCreate: {
          name: checked.name,
          type: checked.type,
          signals: checked.signals,
          urlMasked: redactEndpoint(checked.url),
          hasSecret: Boolean(checked.secret),
          enabled: checked.enabled ?? true,
        },
      });
    }
    return ok({
      channel: await createInstanceAlertChannel(ctx, input, base),
    });
  } catch (e) {
    return failOf(e);
  }
}

export async function instanceAlertChannelUpdate(
  principal: VerifiedToken,
  args: {
    id: string;
    name?: string;
    signals?: string[];
    url?: string;
    secret?: string | null;
    enabled?: boolean;
    dry_run?: boolean;
  },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = adminGate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.id, "id");
  if (typeof id !== "bigint") return id;
  const patch: InstanceAlertChannelUpdate = {};
  if (args.name !== undefined) patch.name = args.name;
  if (args.signals !== undefined) patch.signals = args.signals;
  if (args.url !== undefined) patch.url = args.url;
  if (args.secret !== undefined) patch.secret = args.secret;
  if (args.enabled !== undefined) patch.enabled = args.enabled;
  try {
    if (args.dry_run !== false) {
      const { url, secret, ...checked } =
        checkInstanceAlertChannelUpdate(patch);
      if (url !== undefined) await assertSafeOutboundUrl(url);
      const before = (await listInstanceAlertChannels(base)).find(
        (c) => c.id === String(id),
      );
      if (!before) return err("alert channel not found");
      assertEnableHasUrl(
        checked.enabled ?? before.enabled,
        url !== undefined || before.urlMasked !== null,
      );
      return ok({
        dryRun: true,
        before,
        after: {
          ...before,
          ...checked,
          ...(url !== undefined && { urlMasked: redactEndpoint(url) }),
          ...(secret !== undefined && { hasSecret: secret !== null }),
        },
        urlChanged: url !== undefined,
        secretChanged: secret !== undefined,
      });
    }
    return ok({
      channel: await updateInstanceAlertChannel(ctx, id, patch, base),
    });
  } catch (e) {
    return failOf(e);
  }
}

export async function instanceAlertChannelDelete(
  principal: VerifiedToken,
  args: { id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = adminGate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.id, "id");
  if (typeof id !== "bigint") return id;
  try {
    if (args.dry_run !== false) {
      const before = (await listInstanceAlertChannels(base)).find(
        (c) => c.id === String(id),
      );
      if (!before) return err("alert channel not found");
      return ok({ dryRun: true, wouldDelete: before });
    }
    await deleteInstanceAlertChannel(ctx, id, base);
    return ok({ deleted: String(id) });
  } catch (e) {
    return failOf(e);
  }
}

export async function instanceAlertChannelTest(
  principal: VerifiedToken,
  args: { id: string },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = adminGate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.id, "id");
  if (typeof id !== "bigint") return id;
  try {
    return ok({ result: await sendInstanceAlertChannelTest(id, base) });
  } catch (e) {
    return failOf(e);
  }
}

export async function instanceThresholdSet(
  principal: VerifiedToken,
  args: {
    signal: string;
    threshold?: number;
    duration_seconds?: number;
    enabled?: boolean;
    reset?: boolean;
    dry_run?: boolean;
  },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = adminGate(principal);
  if ("ok" in ctx) return ctx;
  if (!isSignalKey(args.signal)) return err(`unknown signal: ${args.signal}`);
  try {
    const before = (await listInstanceThresholds(base)).find(
      (t) => t.signal === args.signal,
    );
    if (!before) return err(`unknown signal: ${args.signal}`);
    const input = {
      threshold: args.threshold ?? before.threshold,
      durationSeconds: args.duration_seconds ?? before.durationSeconds,
      enabled: args.enabled ?? before.enabled,
    };
    if (args.dry_run !== false) {
      if (!args.reset) checkInstanceThreshold(args.signal, input);
      return ok({
        dryRun: true,
        before,
        after: args.reset
          ? {
              ...before,
              threshold: before.defaultThreshold,
              durationSeconds: before.defaultDurationSeconds,
              enabled: true,
              isDefault: true,
            }
          : { ...before, ...input, isDefault: false },
      });
    }
    return ok({
      threshold: args.reset
        ? await resetInstanceThreshold(ctx, args.signal, base)
        : await setInstanceThreshold(ctx, args.signal, input, base),
    });
  } catch (e) {
    return failOf(e);
  }
}
