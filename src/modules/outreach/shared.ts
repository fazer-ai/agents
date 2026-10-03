import config from "@/config";
import { ForbiddenError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";

// Shared constants and the one feature gate for the "grey rails" outreach module:
// controlled, opt-in sends from the tenant's own secondary/personal accounts against
// merchant leads. The risk model: OFF by default (OUTREACH_ENABLED=false, every surface
// refuses and no worker tick is scheduled); nothing sends without an operator's explicit
// per-job approval (jobs start QUEUED, the worker only claims APPROVED); per-account
// dailyCap + cooldownMin bound the send rate in one atomic UPDATE; every state change is
// audit-logged. Deliberately not a bulk send rail.

// The transports an account can carry (String column: a new bridge is a code
// deploy, not a migration). `manual` = the operator copies the text out and
// sends it by hand, then confirms via mark-sent. `zca_bridge` = POST to the
// zca-bridge sidecar (config.outreach.zcaBridgeUrl or the credential's baseUrl).
export const OUTREACH_TRANSPORTS = ["manual", "zca_bridge"] as const;
export type OutreachTransport = (typeof OUTREACH_TRANSPORTS)[number];

export const OUTREACH_JOB_KINDS = [
  "GROUP_COMMENT",
  "FRIEND_REQUEST",
  "DM",
] as const;

export const OUTREACH_JOB_STATUSES = [
  "QUEUED",
  "APPROVED",
  "SENDING",
  "READY_FOR_MANUAL",
  "SENT",
  "FAILED",
  "CANCELLED",
] as const;

export const OUTREACH_ACCOUNT_STATUSES = [
  "ACTIVE",
  "PAUSED",
  "BANNED",
] as const;

// The single gate every surface funnels through. Thrown at the service layer
// (not only the controller) so no entrypoint - REST today, anything later -
// can reach the feature while it is off. 403 rather than 404: the routes are
// documented, "disabled" is the honest answer, and the console reads it to
// render the disabled state.
export function assertOutreachEnabled(): void {
  if (!config.outreach.enabled) {
    throw new ForbiddenError(
      "Outreach is not enabled on this server",
      "errors.outreachDisabled",
    );
  }
}

// The system actor the worker finalizes rows under. tenantId pins the RLS
// scope to the row's own tenant; the role only fills the TenantContext shape
// (no authorization decision is made off it inside the worker).
export function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}
