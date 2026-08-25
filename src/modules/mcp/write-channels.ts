import basePrisma from "@/api/lib/prisma";
import { AppError } from "@/lib/errors";
import {
  bindInbox,
  connectChatwootDeployment,
  getChatwootInstance,
  listChatwootAccounts,
  listDeploymentAccounts,
  listInboxes,
  previewInboxRemoval,
  reconcileInboxBots,
  reconnectInbox,
  removeInbox,
  rotateChatwootDeploymentToken,
  setConnectedAccounts,
  softDisconnectChatwootInstance,
  syncInboxes,
} from "@/modules/chatwoot/management";
import type { VerifiedToken } from "./oauth/tokens";
import {
  adminGate,
  err,
  gate,
  ok,
  parseMcpId,
  recordMcpAudit,
  truncForAudit,
  type WriteDeps,
  type WriteResult,
} from "./write";

// MCP channel + instance write tools: provision/edit/delete Chatwoot instances, probe remote
// accounts, sync inboxes, bind an inbox to an agent, reconnect/reconcile bots. The Chatwoot admin token
// is an infra secret the caller already holds (extracted during provisioning or entered by the user):
// it is passed RAW to deployment_connect/rotate/list_accounts, used in-band, and kept out of the audit
// (which records metadata only). Per-agent credentials still travel by vault reference elsewhere.

function failOf(e: unknown): WriteResult {
  if (e instanceof AppError) return err(e.message);
  throw e;
}

// ── Chatwoot deployment + accounts ──

export interface DeploymentConnectArgs {
  base_url: string;
  // The Chatwoot admin token, raw. The caller already holds it (the agent extracted it via SSH during
  // provisioning, or the user has it). Used in-band but kept out of the audit (metadata only). REST
  // parity: POST /v1/chatwoot/deployment also takes the token inline.
  admin_token: string;
  dry_run?: boolean;
}

// Register the tenant's Chatwoot deployment (base URL + admin token, entered once). Validates the
// credentials by probing /profile and returns the reachable accounts. A different base URL is rejected
// (one deployment per tenant).
export async function deploymentConnect(
  principal: VerifiedToken,
  args: DeploymentConnectArgs,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = adminGate(principal);
  if ("ok" in ctx) return ctx;
  if (!args.admin_token) return err("admin_token is required");
  if (args.dry_run !== false) {
    return ok({
      dryRun: true,
      action: "connect",
      resource: "chatwoot_deployment",
      // The raw token is never echoed back, not even in the preview.
      preview: { baseUrl: args.base_url, adminToken: "(redacted)" },
    });
  }
  try {
    const result = await connectChatwootDeployment(
      ctx,
      { baseUrl: args.base_url, adminToken: args.admin_token },
      {},
      base,
    );
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.deployment_connect",
      target: `chatwoot_deployment:${result.deployment.id}`,
      before: null,
      after: truncForAudit({
        id: result.deployment.id,
        baseUrl: result.deployment.baseUrl,
        reachableAccounts: result.accounts.length,
      }),
    });
    return ok({ dryRun: false, applied: true, ...result });
  } catch (e) {
    return failOf(e);
  }
}

// Rotate the deployment's shared admin token. admin_token is the new token, raw (the caller holds it);
// used in-band and kept out of the audit. Validated against the live deployment.
export async function deploymentRotateToken(
  principal: VerifiedToken,
  args: { admin_token: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = adminGate(principal);
  if ("ok" in ctx) return ctx;
  if (!args.admin_token) return err("admin_token is required");
  const target = "chatwoot_deployment";
  if (args.dry_run !== false) {
    return ok({
      dryRun: true,
      action: "rotate_token",
      target,
      adminTokenRotated: true,
    });
  }
  try {
    const updated = await rotateChatwootDeploymentToken(
      ctx,
      args.admin_token,
      {},
      base,
    );
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.deployment_rotate_token",
      target: `chatwoot_deployment:${updated.id}`,
      before: null,
      after: truncForAudit({ id: updated.id, adminTokenRotated: true }),
    });
    return ok({ dryRun: false, applied: true, deployment: updated });
  } catch (e) {
    return failOf(e);
  }
}

// List the accounts the deployment's STORED token can reach (no token re-entry).
export async function deploymentListAccounts(
  principal: VerifiedToken,
  _args: { dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = adminGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    const accounts = await listDeploymentAccounts(ctx, {}, base);
    return ok({ accounts });
  } catch (e) {
    return failOf(e);
  }
}

// Apply the selected accounts as a diff: newly-selected are connected (+ inboxes synced), de-selected
// active ones are soft-disconnected (history kept).
export async function deploymentSetAccounts(
  principal: VerifiedToken,
  args: { account_ids: number[]; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = adminGate(principal);
  if ("ok" in ctx) return ctx;
  const target = "chatwoot_deployment:accounts";
  if (args.dry_run !== false) {
    return ok({
      dryRun: true,
      action: "set_accounts",
      target,
      accountIds: args.account_ids,
      note: "Connects newly-selected accounts (syncs their inboxes) and soft-disconnects de-selected ones (history kept). Calls Chatwoot.",
    });
  }
  try {
    const accounts = await setConnectedAccounts(
      ctx,
      args.account_ids,
      {},
      base,
    );
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.deployment_set_accounts",
      target,
      before: null,
      after: truncForAudit({
        accountIds: args.account_ids,
        connected: accounts.filter((a) => a.disconnectedAt === null).length,
      }),
    });
    return ok({ dryRun: false, applied: true, accounts });
  } catch (e) {
    return failOf(e);
  }
}

// Soft-disconnect ONE account: unbind its inboxes' agents and stop handling its traffic, keeping the
// conversation/analytics rows for history. Reconnect by re-selecting it in deployment_set_accounts.
export async function instanceDisconnect(
  principal: VerifiedToken,
  args: { instance_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = adminGate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.instance_id, "instance_id");
  if (typeof id !== "bigint") return id;
  try {
    const current = await getChatwootInstance(ctx, id, base);
    const target = `chatwoot_instance:${id}`;
    const beforeProj = { id: current.id, accountId: current.accountId };
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "disconnect",
        target,
        current: beforeProj,
      });
    }
    await softDisconnectChatwootInstance(ctx, id, base);
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.instance_disconnect",
      target,
      before: truncForAudit(beforeProj),
      after: null,
    });
    return ok({ dryRun: false, applied: true, target });
  } catch (e) {
    return failOf(e);
  }
}

// Probe a Chatwoot base URL for the accounts a token can see (helps discover account_id before
// deployment_connect). Stateless: admin_token is the raw token, used for the probe and never persisted.
export async function instanceListAccounts(
  principal: VerifiedToken,
  args: { base_url: string; admin_token: string },
  _deps: WriteDeps = {},
): Promise<WriteResult> {
  const ctx = adminGate(principal);
  if ("ok" in ctx) return ctx;
  if (!args.admin_token) return err("admin_token is required");
  try {
    const accounts = await listChatwootAccounts({
      baseUrl: args.base_url,
      token: args.admin_token,
    });
    return ok({ accounts });
  } catch (e) {
    return failOf(e);
  }
}

export async function instanceSyncInboxes(
  principal: VerifiedToken,
  args: { instance_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.instance_id, "instance_id");
  if (typeof id !== "bigint") return id;
  try {
    const current = await getChatwootInstance(ctx, id, base);
    const target = `chatwoot_instance:${id}`;
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "sync_inboxes",
        target,
        note: "Reconciles the local inbox mirror with the Chatwoot account (calls Chatwoot).",
        accountId: current.accountId,
      });
    }
    const result = await syncInboxes(ctx, id, {}, base);
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.instance_sync_inboxes",
      target,
      before: null,
      after: truncForAudit(result),
    });
    return ok({ dryRun: false, applied: true, target, result });
  } catch (e) {
    return failOf(e);
  }
}

// ── inboxes ──

export async function inboxBind(
  principal: VerifiedToken,
  args: { inbox_id: string; agent_id?: string | null; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const inboxId = parseMcpId(args.inbox_id, "inbox_id");
  if (typeof inboxId !== "bigint") return inboxId;
  let agentId: bigint | null = null;
  if (args.agent_id !== undefined && args.agent_id !== null) {
    const parsed = parseMcpId(args.agent_id, "agent_id");
    if (typeof parsed !== "bigint") return parsed;
    agentId = parsed;
  }
  try {
    const inboxes = await listInboxes(ctx, base);
    const current = inboxes.find((i) => i.id === String(inboxId));
    if (!current) return err("inbox not found");
    const target = `inbox:${inboxId}`;
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "bind",
        target,
        currentAgentId: current.agentId,
        newAgentId: agentId === null ? null : String(agentId),
        note: "Binding provisions/connects the agent's bot on the inbox (calls Chatwoot).",
      });
    }
    const updated = await bindInbox(ctx, inboxId, agentId, {}, base);
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.inbox_bind",
      target,
      before: truncForAudit({ agentId: current.agentId }),
      after: truncForAudit({ agentId: updated.agentId }),
    });
    return ok({ dryRun: false, applied: true, target, inbox: updated });
  } catch (e) {
    return failOf(e);
  }
}

// Remove the LOCAL mirror of an inbox that was deleted in Chatwoot. The dry run calls Chatwoot too,
// which is the difference that matters: the write refuses a live inbox, so a preview answering from
// its arguments alone would approve exactly what the apply then rejects.
export async function inboxRemove(
  principal: VerifiedToken,
  args: { inbox_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const inboxId = parseMcpId(args.inbox_id, "inbox_id");
  if (typeof inboxId !== "bigint") return inboxId;
  try {
    const cw = { makeClient: deps.makeClient };
    const { inbox, gone } = await previewInboxRemoval(ctx, inboxId, cw, base);
    const target = `inbox:${inboxId}`;
    const beforeProj = {
      id: inbox.id,
      name: inbox.name,
      chatwootInboxId: inbox.chatwootInboxId,
      agentId: inbox.agentId,
    };
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "remove",
        target,
        current: beforeProj,
        goneFromChatwoot: gone,
        note: gone
          ? "Removes the LOCAL mirror only. Past conversations are kept and stop naming an inbox; past usage and log lines are kept."
          : "This inbox still exists in Chatwoot, so applying would be refused. Delete it in Chatwoot first.",
      });
    }
    await removeInbox(ctx, inboxId, cw, base);
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.inbox_remove",
      target,
      before: truncForAudit(beforeProj),
      after: null,
    });
    return ok({ dryRun: false, applied: true, target });
  } catch (e) {
    return failOf(e);
  }
}

export async function inboxReconnect(
  principal: VerifiedToken,
  args: { inbox_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const inboxId = parseMcpId(args.inbox_id, "inbox_id");
  if (typeof inboxId !== "bigint") return inboxId;
  const target = `inbox:${inboxId}`;
  if (args.dry_run !== false) {
    return ok({
      dryRun: true,
      action: "reconnect",
      target,
      note: "Re-provisions the inbox's bot on Chatwoot (calls Chatwoot).",
    });
  }
  try {
    const updated = await reconnectInbox(ctx, inboxId, {}, base);
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.inbox_reconnect",
      target,
      before: null,
      after: truncForAudit({ id: updated.id, agentId: updated.agentId }),
    });
    return ok({ dryRun: false, applied: true, target, inbox: updated });
  } catch (e) {
    return failOf(e);
  }
}

export async function inboxReconcile(
  principal: VerifiedToken,
  args: { dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const target = "inbox:all";
  if (args.dry_run !== false) {
    return ok({
      dryRun: true,
      action: "reconcile",
      target,
      note: "Checks every bound inbox's bot against Chatwoot and re-provisions missing ones (calls Chatwoot).",
    });
  }
  try {
    const status = await reconcileInboxBots(ctx, {}, base);
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.inbox_reconcile",
      target,
      before: null,
      after: truncForAudit(status),
    });
    return ok({ dryRun: false, applied: true, target, status });
  } catch (e) {
    return failOf(e);
  }
}
