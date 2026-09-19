import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { type AlertSendDeps, sendAlert } from "./alert-send";

// THE BUTTON ON THE SMOKE DETECTOR (issue #605).
//
// An alert channel was configured blind: a URL pasted with a trailing space, a webhook deleted on the
// Discord side, a rotated token, an egress rule blocking the host — every one of them invisible until
// an alert failed to arrive, which is the one moment nobody is watching for a silence. This posts a
// sample alert now and hands back what happened.
//
// It is the same send the worker performs (`sendAlert`), not a re-statement of it, so a green result
// is evidence about the path a real alert takes. What it does NOT do is leave a trace of a real one:
//
//   - no `AlertDelivery` row. The sharp half, and the reason is the coalescing window: a PENDING row
//     of the same channel/stage/level is bumped with `count++` rather than becoming a new row, AND
//     THE COALESCED ROW KEEPS THE FIRST EVENT'S BODY. A row left here would swallow the summary of
//     the next real alert, so the test would not merely add noise to the history, it would take a
//     real alert's text away.
//   - no flow-log line at warn/error. Those are exactly what `dispatchAlertsForEvent` routes, so a
//     test that logged its own failure would alert about itself, in the channel being tested.
//   - no audit row. The trail records CHANGES; nothing here changes. Same decision already taken for
//     `webhook_test` and `mcp_connection_discover`.

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
    // The one case where a 2xx is not the whole answer: the channel names a signing secret that no
    // longer resolves, so this delivery went out UNSIGNED and a receiver that verifies signatures
    // will reject the real alert while this test reports success.
    warning: res.secretUnresolved
      ? "the configured signing secret did not resolve, so the sample was sent UNSIGNED"
      : null,
  };
}
