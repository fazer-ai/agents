import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { type AlertSendDeps, loadAlertContext, sendAlert } from "./alert-send";

// Posts a sample alert through the same `sendAlert` the worker uses, so a green result is evidence
// about the path a real alert takes. It leaves no trace of a real one: no `AlertDelivery` row (a
// coalesced PENDING row keeps the FIRST event's body, so a test row would swallow the next real
// alert's summary), no warn/error flow-log line (it would alert about itself, in the channel under
// test), and no audit row (nothing changes).

const TEST_DELIVERY_ID = "test";
// DELIBERATELY NOT one of `FLOW_STAGES`. The stage only ever reaches the rendered body here (nothing
// is stored), and a real stage name would make the sample read, in the destination, exactly like an
// alert about that step. The word that says what this is beats a word from the closed vocabulary.
const TEST_STAGE = "test";
// Below the `warn`/`error` the alerting path routes, for the same reason.
const TEST_LEVEL = "info";
// Written to be read in the destination, by a person who may not have asked for it: it says what it
// is, so nobody pages anyone over it, and it is one line like every other alert body.
const TEST_SUMMARY =
  "Test alert from fazer.ai agents. If you can read this, the channel is wired correctly.";

export interface AlertChannelTestResult {
  // The destination answered 2xx.
  ok: boolean;
  // HTTP status the destination answered, or null when no response was received (blocked target,
  // connection error, timeout).
  status: number | null;
  // Short technical reason on failure, null on success. Never the channel's URL.
  error: string | null;
  // Whether the sample went out HMAC-signed.
  signed: boolean;
  // A success on a DISABLED channel is not a channel that is watching, and the operator testing
  // before enabling (the normal order) has to be told which of the two they just proved.
  enabled: boolean;
  // Time the request itself took, null when none was made.
  durationMs: number | null;
  // Operator-facing note about something that succeeded anyway, null when there is none.
  warning: string | null;
}

export async function sendAlertChannelTest(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
  deps: AlertSendDeps = {},
): Promise<AlertChannelTestResult> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const channel = await runScopedOn(base, ctx, (db) =>
    db.alertChannel.findFirst({
      where: { id },
      select: { type: true, url: true, secretRef: true, enabled: true },
    }),
  );
  if (!channel)
    throw new NotFoundError(
      "alert channel not found",
      "errors.alertChannelNotFound",
    );

  const res = await sendAlert(
    base,
    ctx,
    {
      deliveryId: TEST_DELIVERY_ID,
      type: channel.type,
      url: channel.url,
      secretRef: channel.secretRef,
      stage: TEST_STAGE,
      level: TEST_LEVEL,
      summary: TEST_SUMMARY,
      count: 1,
      // A probe is no event: nothing to link to, so the body carries no link and no ids.
      tenantId: ctx.tenantId,
      turnId: null,
      conversationId: null,
      causeKey: null,
      // The tenant's name, so the probe shows the header a real alert will.
      context: await loadAlertContext(base, {
        tenantId: ctx.tenantId,
        conversationId: null,
        agentId: null,
      }).catch(() => null),
    },
    deps,
  );

  return {
    ok: res.ok,
    status: res.status,
    error: res.error,
    signed: res.signed,
    enabled: channel.enabled,
    durationMs: res.durationMs,
    // NOTE: A 2xx is not the whole answer when the channel names a signing secret that no longer
    // resolves: this went out UNSIGNED, and a verifying receiver will reject the real alert. The
    // sentence comes from the resolver so the probe and the delivery row say the same thing.
    warning: res.unsignedReason,
  };
}
