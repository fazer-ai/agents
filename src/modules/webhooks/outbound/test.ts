import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { resolveSigningSecret } from "@/modules/vault/service";
import { OUTBOUND_ENVELOPE_VERSION } from "./events";
import { outboundHeaders } from "./signing";

// On-demand "send a sample payload" for a subscription (the Test button). Unlike a real emit, this
// is SYNCHRONOUS: it POSTs a clearly-marked test envelope to the subscription's URL through the SAME
// delivery primitives the worker uses (SSRF guard, HMAC signing with the vault secret, no redirects,
// timeout) and returns the HTTP outcome so the operator gets immediate reachability feedback. It
// never enqueues an OutboundWebhookDelivery and never touches the scheduler. The `event` is the
// sentinel "webhook.test" (NOT a real OUTBOUND_EVENT) so a receiver can tell it apart from live data.

const TEST_TIMEOUT_MS = 10_000;
const TEST_EVENT = "webhook.test";

export interface WebhookTestResult {
  // POST returned a 2xx.
  ok: boolean;
  // HTTP status code, or null when no response was received (SSRF block, DNS/connection error, timeout).
  status: number | null;
  // Short technical reason on failure (shown to the operator), null on success.
  error: string | null;
  // Whether the payload was HMAC-signed (true only when the subscription has a resolvable secretRef).
  signed: boolean;
  // Set when the sample went out UNSIGNED although a secret is configured: the sentence naming which
  // of the two credential problems it is (issue #724). Null on the two quiet cases — it signed, or
  // no secret is configured — so a subscription that never wanted signing gets no warning.
  warning: string | null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildTestEnvelope(
  tenantId: bigint,
  events: string[],
): Record<string, unknown> {
  return {
    version: OUTBOUND_ENVELOPE_VERSION,
    instance_id: instanceIdentity.instanceId,
    event: TEST_EVENT,
    occurred_at: new Date().toISOString(),
    tenant_id: String(tenantId),
    data: {
      message:
        "Test delivery from fazer.ai agents. If you received this, your endpoint is reachable.",
      subscribed_events: events,
    },
  };
}

export async function sendWebhookTest(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<WebhookTestResult> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const sub = await runScopedOn(base, ctx, (db) =>
    db.webhookSubscription.findFirst({
      where: { id },
      select: { url: true, secretRef: true, events: true },
    }),
  );
  if (!sub)
    throw new NotFoundError(
      "webhook subscription not found",
      "errors.webhookSubscriptionNotFound",
    );

  // A blocked URL is reported as a failed test (with the reason), not a thrown 400 — the operator
  // wants the outcome in the result, same as a connection error.
  try {
    await assertSafeOutboundUrl(sub.url);
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: errMsg(err),
      signed: false,
      warning: null,
    };
  }

  // THE PROBE USED TO REFUSE WHERE ITS WORKER SENDS (issue #724).
  //
  // A configured-but-unresolvable secret used to end this function with `ok: false` and nothing on
  // the wire. The worker next door does the opposite — it POSTs unsigned and moves the row to
  // DELIVERED — so the button told the operator the endpoint was unreachable while the endpoint was
  // being reached all day, unsigned, by the code the button exists to stand in for. A probe that
  // exercises a different path from the real send condemns what works and approves what does not.
  //
  // It now mirrors the worker: send, report `signed: false`, and carry the sentence that says which
  // credential problem it is. The refusal is not the thing worth keeping here; being told is.
  let secret: string | null = null;
  let warning: string | null = null;
  try {
    const resolved = await runScopedOn(base, ctx, (db) =>
      resolveSigningSecret(db, sub.secretRef),
    );
    secret = resolved.secret;
    warning = resolved.unsignedReason;
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: `secret resolution failed: ${errMsg(err)}`,
      signed: false,
      warning: null,
    };
  }

  const rawBody = JSON.stringify(buildTestEnvelope(tenantId, sub.events));
  const ts = Math.floor(Date.now() / 1000);
  const headers = outboundHeaders({
    contentType: "application/json",
    deliveryId: "test",
    timestampSeconds: ts,
    rawBody,
    secret,
  });

  try {
    const res = await fetch(sub.url, {
      method: "POST",
      headers,
      body: rawBody,
      redirect: "error",
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    const ok = res.status >= 200 && res.status < 300;
    return {
      ok,
      status: res.status,
      error: ok ? null : `non-2xx response: ${res.status}`,
      signed: Boolean(secret),
      warning,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: `request failed: ${errMsg(err)}`,
      signed: Boolean(secret),
      warning,
    };
  }
}
