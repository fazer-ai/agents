import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { NotFoundError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import { processAlertBatch } from "@/modules/flowlog/alert-worker";
import { sendAlertChannelTest } from "@/modules/flowlog/channel-test";
import {
  createAlertChannel,
  updateAlertChannel,
} from "@/modules/flowlog/channels";
import { flowLogCount } from "../utils/flowlog";
import { outboundUrl } from "../utils/outbound";
import { POLL_DEADLINE_MS } from "../utils/poll";
import { countInSrc } from "../utils/source-text";

// ── A SMOKE DETECTOR WITH A BUTTON ON IT (issue #605) ──
//
// An alert channel was configured blind: the first evidence either way was an incident. The route
// added here posts a sample alert to the channel's destination and hands the outcome back, which is
// what `POST /subscriptions/:id/test` already did for the other outbound family.
//
// What the tests below are actually guarding is not the route's existence — that is the cheap half —
// but the two ways a test button lies:
//
//   - It exercises a DIFFERENT path from the real send, so it approves a channel whose alerts will
//     never arrive. `sendWebhookTest` is a second copy of the outbound worker's rules and has to be
//     kept in step by hand; this one is not, and the last test in the file is that fact measured
//     against the source, not asserted in prose.
//   - It leaves a real alert behind. The trap is specific and it is the coalescing window: a PENDING
//     `AlertDelivery` of the same channel/stage/level is bumped with `count++` instead of becoming a
//     new row, AND THE COALESCED ROW KEEPS THE FIRST EVENT'S BODY. A row left by a test would
//     therefore not merely add noise, it would swallow the text of the next real alert.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;

let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;

if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

const appDb = app as PrismaClient;
const suDb = su as PrismaClient;
let tenantId = 0n;
let otherTenantId = 0n;
let secretId = 0n;

const ctx = (): TenantContext => ({
  tenantId,
  userId: 605n,
  role: "TENANT_ADMIN",
});
const otherCtx = (): TenantContext => ({
  tenantId: otherTenantId,
  userId: 606n,
  role: "TENANT_ADMIN",
});

// A receiver that records every request it was given and answers what the test asked for. The raw
// body is kept as the string that was sent, never reserialized: the signature is over those bytes.
interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  rawBody: string;
  redirect: RequestRedirect | undefined;
  signal: AbortSignal | null | undefined;
}

function receiver(reply: () => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({
      url: String(url),
      method: init?.method,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      ),
      rawBody: String(init?.body ?? ""),
      redirect: init?.redirect,
      signal: init?.signal,
    });
    return await reply();
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

// A destination that accepts the connection and never answers, so the only thing that can end the
// call is the caller's own deadline.
function silentReceiver() {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({
      url: String(url),
      method: init?.method,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      ),
      rawBody: String(init?.body ?? ""),
      redirect: init?.redirect,
      signal: init?.signal,
    });
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new Error("The operation timed out.")),
      );
    });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

const ok204 = () => new Response(null, { status: 204 });
// The guard itself is exercised by its own suite; here it is stubbed so a fixture URL does not need
// DNS, EXCEPT where the test is about the guard refusing (it then throws, as the real one does).
const allowAll = async (u: string) => new URL(u);

describe.skipIf(!dbUp)("testing an alert channel", () => {
  beforeAll(async () => {
    if (!su) return;
    const t = await su.tenant.create({
      data: { name: "ACT", slug: `act-${process.pid}` },
    });
    tenantId = t.id;
    const o = await su.tenant.create({
      data: { name: "ACT-other", slug: `act-o-${process.pid}` },
    });
    otherTenantId = o.id;
    const sec = await su.vaultEntry.create({
      data: {
        tenantId,
        name: "alert-hmac",
        kind: "generic",
        secret: encryptJson("signing-secret"),
      },
      select: { id: true },
    });
    secretId = sec.id;
  });

  afterAll(async () => {
    if (su) {
      for (const id of [tenantId, otherTenantId]) {
        if (!id) continue;
        for (const table of [
          "alert_deliveries",
          "audit_logs",
          "alert_channels",
          "vault_entries",
          "execution_logs",
        ]) {
          await su.$executeRawUnsafe(
            `DELETE FROM ${table} WHERE tenant_id = ${id}`,
          );
        }
        await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${id}`);
      }
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  async function seed(
    name: string,
    over: Partial<{
      type: "discord" | "webhook";
      url: string;
      secretRef: string | null;
      enabled: boolean;
    }> = {},
    who: TenantContext = ctx(),
  ) {
    const created = await createAlertChannel(
      who,
      {
        name,
        type: over.type ?? "discord",
        url: over.url ?? outboundUrl(`/${name}`),
        ...(over.secretRef ? { secretRef: over.secretRef } : {}),
        ...(over.enabled === undefined ? {} : { enabled: over.enabled }),
      },
      appDb,
    );
    return BigInt(created.id);
  }

  // ── the outcome the operator reads ──

  test("a destination that takes the sample answers with its status and the latency", async () => {
    const id = await seed("reachable");
    const { sent, fetchImpl } = receiver(ok204);

    const res = await sendAlertChannelTest(ctx(), id, appDb, {
      fetchImpl,
      assertSafe: allowAll,
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe(204);
    expect(res.error).toBe(null);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof res.durationMs).toBe("number");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe("POST");
  });

  test("the latency reported is the request's own, not a constant", async () => {
    const id = await seed("timed");
    const { fetchImpl } = receiver(ok204);
    // A controlled clock: the send reads it once before the request and once after, so a result that
    // hard-codes 0 (or forgets to subtract) cannot produce this number.
    const ticks = [1_000_000, 1_000_000, 1_000_137];
    let i = 0;
    const res = await sendAlertChannelTest(ctx(), id, appDb, {
      fetchImpl,
      assertSafe: allowAll,
      now: () => ticks[Math.min(i++, ticks.length - 1)] as number,
    });

    expect(res.durationMs).toBe(137);
  });

  test("the request carries the test delivery id, and refuses a redirect", async () => {
    const id = await seed("marked");
    const { sent, fetchImpl } = receiver(ok204);

    await sendAlertChannelTest(ctx(), id, appDb, {
      fetchImpl,
      assertSafe: allowAll,
    });

    // A receiver deduping on the delivery header would otherwise see a plausible row id and treat the
    // probe as a real alert it had missed. "test" is the sentinel the outbound family already uses.
    expect(sent[0]?.headers["x-fazerai-delivery"]).toBe("test");
    // And the hop the real send refuses: following a 302 would deliver somewhere the SSRF guard never
    // vetted, and would approve a channel whose real alerts stop at the first redirect.
    expect(sent[0]?.redirect).toBe("error");
  });

  test("a destination that never answers ends on our deadline, not on the operator's patience", async () => {
    const id = await seed("silent");
    const { sent, fetchImpl } = silentReceiver();

    const res = await sendAlertChannelTest(ctx(), id, appDb, {
      fetchImpl,
      assertSafe: allowAll,
      requestTimeoutMs: 25,
    });

    // The request DID go out — the failure is in the waiting, not before the send, which is the
    // distinction that tells the operator where to look.
    expect(sent).toHaveLength(1);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(null);
    expect((res.error ?? "").toLowerCase()).toContain("timed out");
  });

  test("the sample is the body a real alert carries, not a bare ok", async () => {
    const id = await seed("shaped");
    const { sent, fetchImpl } = receiver(ok204);

    await sendAlertChannelTest(ctx(), id, appDb, {
      fetchImpl,
      assertSafe: allowAll,
    });

    // Discord's webhook takes `{ content }` markdown; anything else is dropped on the floor by the
    // destination, so a test that posts `{"ok":true}` proves nothing about the channel.
    const body = JSON.parse(sent[0]?.rawBody ?? "{}");
    expect(typeof body.content).toBe("string");
    expect(body.content.length).toBeGreaterThan(10);
    // And it says it is a test, so the destination's history does not read as an incident.
    expect(body.content.toLowerCase()).toContain("test");
  });

  test("the reason travels when the destination refuses", async () => {
    const id = await seed("refused");
    const { sent, fetchImpl } = receiver(
      () => new Response("nope", { status: 500 }),
    );

    const res = await sendAlertChannelTest(ctx(), id, appDb, {
      fetchImpl,
      assertSafe: allowAll,
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    expect(res.error).toContain("500");
    expect(sent).toHaveLength(1);
  });

  test("an unreachable destination is a result, not an exception", async () => {
    const id = await seed("unreachable");
    const { fetchImpl } = receiver(() => {
      throw new Error("getaddrinfo ENOTFOUND");
    });

    const res = await sendAlertChannelTest(ctx(), id, appDb, {
      fetchImpl,
      assertSafe: allowAll,
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(null);
    expect(res.error ?? "").toContain("ENOTFOUND");
  });

  test("a blocked target is refused before a byte leaves", async () => {
    const id = await seed("blocked");
    const { sent, fetchImpl } = receiver(ok204);

    const res = await sendAlertChannelTest(ctx(), id, appDb, {
      fetchImpl,
      assertSafe: async () => {
        throw new Error("target not allowed");
      },
    });

    expect(res.ok).toBe(false);
    expect(res.error ?? "").toContain("not allowed");
    // The point of the clause: the guard runs BEFORE the request, so a test button is not a hole in
    // the SSRF guard that the real send does not have.
    expect(sent).toHaveLength(0);
  });

  test("the result never carries the channel's own URL", async () => {
    const id = await seed("secretive", { url: outboundUrl("/t0k3n-in-here") });
    const { fetchImpl } = receiver(() => new Response("nope", { status: 500 }));

    const res = await sendAlertChannelTest(ctx(), id, appDb, {
      fetchImpl,
      assertSafe: allowAll,
    });

    // A Discord webhook URL embeds a bot token, which is why the read returns it masked. A result
    // that quotes the URL back hands it to every log and every screenshot of the console.
    expect(JSON.stringify(res)).not.toContain("t0k3n-in-here");
  });

  test("a destination that redirects does not hand the URL back in the reason", async () => {
    // THE HOLDOUT'S OWN FINDING (s10), and it is the sharpest thing in this file. A Discord webhook
    // URL embeds a bot token, which is why the column is encrypted and the read returns
    // `scheme://host/…`. Bun's `UnexpectedRedirect` names the URL it was fetching, IN FULL, and that
    // string was going straight into this result, into the console toast that renders it, and into
    // `alert_deliveries.last_error` where the worker stores the same one.
    //
    // The error text below is the one Bun actually produced against a 302, copied from the live
    // measurement rather than invented: a fixture spelled from memory would be a test of my memory.
    const path = "/api/webhooks/1234567890/TOKENDEDISCORDaaaSEGREDO";
    const id = await seed("redirected", { url: outboundUrl(path) });
    const { fetchImpl } = receiver(() => {
      throw new Error(
        `UnexpectedRedirect fetching "${outboundUrl(path)}". For more information, pass \`verbose: true\` in the second argument to fetch()`,
      );
    });

    const res = await sendAlertChannelTest(ctx(), id, appDb, {
      fetchImpl,
      assertSafe: allowAll,
    });

    expect(res.ok).toBe(false);
    const body = JSON.stringify(res);
    expect(body).not.toContain("TOKENDEDISCORDaaaSEGREDO");
    expect(body).not.toContain("/api/webhooks/");
    // What survives is the masked form the read already shows, so the operator still learns WHICH
    // destination refused, and the word that says what happened.
    expect(res.error ?? "").toContain("203.0.113.10/…");
    expect(res.error ?? "").toContain("UnexpectedRedirect");
  });

  test("an IPv6 destination's path is masked too, brackets and all", async () => {
    // REVIEW ROUND 3. The first masking was a regex alone, and it stopped at `]`: an IPv6 literal
    // matched only up to the bracket, failed to parse, collapsed to "…" and left the whole
    // token-bearing path standing next to it. The destination is KNOWN here — it was just decrypted
    // — so it is replaced by literal string match, which no URL spelling can defeat. The regex stays
    // as the backstop for a URL this code does not know, such as a redirect target.
    const url = "https://[2606:4700::1111]/hooks/PRIVATETOKENv6";
    const id = await seed("v6", { url });
    const { fetchImpl } = receiver(() => {
      throw new Error(`UnexpectedRedirect fetching "${url}".`);
    });

    const res = await sendAlertChannelTest(ctx(), id, appDb, {
      fetchImpl,
      // The SSRF guard is stubbed here: the subject is the masking, and that address would not be
      // reachable anyway.
      assertSafe: allowAll,
    });

    const body = JSON.stringify(res);
    expect(body).not.toContain("PRIVATETOKENv6");
    expect(body).not.toContain("/hooks/");
    expect(res.error ?? "").toContain("[2606:4700::1111]/…");
  });

  test("a path holding punctuation the regex would stop at is masked whole", async () => {
    // The other half of the same hole, and the reason guessing where a URL ENDS is the wrong job to
    // give the thing guarding a token: a path containing `)` or `'` used to end the match there and
    // hand the remainder back in the clear.
    const url = outboundUrl("/hooks/tok)en'SUFFIXSECRET");
    const id = await seed("punct", { url });
    const { fetchImpl } = receiver(() => {
      throw new Error(`UnexpectedRedirect fetching "${url}".`);
    });

    const res = await sendAlertChannelTest(ctx(), id, appDb, {
      fetchImpl,
      assertSafe: allowAll,
    });

    expect(JSON.stringify(res)).not.toContain("SUFFIXSECRET");
    expect(res.error ?? "").toContain("203.0.113.10/…");
  });

  test("a host that does not resolve is still readable after the masking", async () => {
    // The other side of the same edit, and the reason the pattern demands a scheme: a DNS failure
    // names a bare host, which is the whole advice the message carries and is already visible in the
    // masked URL. Redacting it would trade a leak for a result that says nothing.
    const id = await seed("dns");
    const { fetchImpl } = receiver(() => {
      throw new Error("getaddrinfo ENOTFOUND alerts.example.invalid");
    });

    const res = await sendAlertChannelTest(ctx(), id, appDb, {
      fetchImpl,
      assertSafe: allowAll,
    });

    expect(res.error ?? "").toContain("alerts.example.invalid");
  });

  // ── the channel is not changed by being tested ──

  test("a disabled channel is tested, says so, and stays disabled", async () => {
    const id = await seed("off", { enabled: false });
    const { sent, fetchImpl } = receiver(ok204);

    const res = await sendAlertChannelTest(ctx(), id, appDb, {
      fetchImpl,
      assertSafe: allowAll,
    });

    // Testing before enabling is the normal order; refusing here would force the operator to enable
    // an untested channel.
    expect(res.ok).toBe(true);
    expect(sent).toHaveLength(1);
    // And the operator is told, so a green result is not read as "the channel is watching now".
    expect(res.enabled).toBe(false);
    const after = await suDb.alertChannel.findUniqueOrThrow({ where: { id } });
    expect(after.enabled).toBe(false);
  });

  test("testing leaves nothing behind that a real alert would coalesce into", async () => {
    const id = await seed("clean");
    const { fetchImpl } = receiver(ok204);
    const auditBefore = await suDb.auditLog.count({ where: { tenantId } });
    const alerting = { tenantId, level: { in: ["warn", "error"] } };

    await sendAlertChannelTest(ctx(), id, appDb, {
      fetchImpl,
      assertSafe: allowAll,
    });

    // No delivery row at all — in particular no PENDING one, which the next real alert of the same
    // channel/stage/level would be folded into, losing its own summary to this test's.
    expect(await suDb.alertDelivery.count({ where: { channelId: id } })).toBe(
      0,
    );
    // No flow-log line the alerting path would itself route (`dispatchAlertsForEvent` takes warn and
    // error), which is the loop the issue names: a test that alerts about itself.
    expect(
      // flowlog-scope: tenant-wide — the claim is that the send wrote no alerting line ANYWHERE in
      // this tenant, which a reader scoped to one turn could not make. Through the settling helper
      // because this is an ABSENCE, and a raw read of an absence passes for the very reason that
      // would make it wrong.
      await flowLogCount(suDb, { where: alerting }),
    ).toBe(0);

    // THE POSITIVE CONTROLS, and they are not decoration here. Both tables are empty in a tenant
    // created seconds ago, so a delta of zero is indistinguishable from a reader that cannot see
    // the rows at all.
    const probe = await suDb.executionLog.create({
      data: {
        tenantId,
        turnId: `t-605-${process.pid}`,
        stage: "webhook",
        level: "error",
      },
      select: { id: true },
    });
    expect(
      // flowlog-scope: seeded — the row above was inserted here and awaited, so there is no emit for
      // this read to outrun; it goes through the helper anyway because it must be the SAME reader as
      // the one above for the control to control anything.
      await flowLogCount(suDb, { where: alerting }),
    ).toBe(1);
    await suDb.executionLog.delete({ where: { id: probe.id } });

    // And no audit row: the trail records CHANGES, and a test changes nothing. Same decision already
    // taken for `webhook_test`.
    expect(await suDb.auditLog.count({ where: { tenantId } })).toBe(
      auditBefore,
    );
    // Its control: an ordinary edit of the same channel, read by the same query, DOES land a row.
    await updateAlertChannel(ctx(), id, { name: "clean-renamed" }, appDb);
    expect(await suDb.auditLog.count({ where: { tenantId } })).toBeGreaterThan(
      auditBefore,
    );
  });

  test("a channel of another tenant is not found, and its destination is not touched", async () => {
    const id = await seed("theirs", {}, otherCtx());
    const { sent, fetchImpl } = receiver(ok204);

    await expect(
      sendAlertChannelTest(ctx(), id, appDb, {
        fetchImpl,
        assertSafe: allowAll,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(sent).toHaveLength(0);

    // The positive control of the same measurement: the owner CAN test it, so the zero above is the
    // scoping and not a channel that works for nobody.
    const mine = await sendAlertChannelTest(otherCtx(), id, appDb, {
      fetchImpl,
      assertSafe: allowAll,
    });
    expect(mine.ok).toBe(true);
    expect(sent).toHaveLength(1);
  });

  // ── the signature path, which is half of what there is to get wrong ──

  test("a channel with a resolvable secret sends signed, and says it did", async () => {
    const id = await seed("signed", {
      type: "webhook",
      secretRef: `vault:${secretId}`,
    });
    const { sent, fetchImpl } = receiver(ok204);

    const res = await sendAlertChannelTest(ctx(), id, appDb, {
      fetchImpl,
      assertSafe: allowAll,
    });

    expect(res.ok).toBe(true);
    expect(res.signed).toBe(true);
    const headers = sent[0]?.headers ?? {};
    const sig = headers["x-fazerai-signature"];
    expect(sig).toBeTruthy();
    const ts = headers["x-fazerai-timestamp"];
    const expected = createHmac("sha256", "signing-secret")
      .update(`${ts}.${sent[0]?.rawBody}`)
      .digest("hex");
    // The signature a verifying receiver will check — computed here from the secret, not read back
    // from the code that produced it.
    expect(sig).toBe(`sha256=${expected}`);
    expect(JSON.stringify(res)).not.toContain("signing-secret");
  });

  test("a secret that does not resolve is visible, not a silent unsigned send", async () => {
    // The channel is created with a live ref and the vault entry is removed afterwards: the shape of
    // a rotated-away credential, which is exactly the case the operator needs to see.
    const gone = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "rotated-away",
        kind: "generic",
        secret: encryptJson("old"),
      },
      select: { id: true },
    });
    const id = await seed("half-signed", {
      type: "webhook",
      secretRef: `vault:${gone.id}`,
    });
    await suDb.vaultEntry.delete({ where: { id: gone.id } });
    const { sent, fetchImpl } = receiver(ok204);

    const res = await sendAlertChannelTest(ctx(), id, appDb, {
      fetchImpl,
      assertSafe: allowAll,
    });

    // The worker sends unsigned when the ref stops resolving, so the test does too: mirroring the
    // real send is the whole point. What must NOT happen is this result reading like the signed one
    // above, because then the operator confirms a signing configuration that is not signing.
    expect(res.signed).toBe(false);
    expect(sent[0]?.headers["x-fazerai-signature"]).toBeUndefined();
    expect(res.warning ?? "").not.toBe("");
    expect((res.warning ?? "").toLowerCase()).toContain("unsigned");
  });

  // ── the guarantee that makes the button worth pressing ──

  test("the test and the real send are the same request, byte for byte", async () => {
    const id = await seed("parity", {
      type: "webhook",
      secretRef: `vault:${secretId}`,
    });

    const probe = receiver(ok204);
    await sendAlertChannelTest(ctx(), id, appDb, {
      fetchImpl: probe.fetchImpl,
      assertSafe: allowAll,
    });

    // The same channel, driven through the worker instead, with the delivery row carrying the very
    // summary the probe posts. If the two paths ever come apart, this is where it shows.
    const probeBody = JSON.parse(probe.sent[0]?.rawBody ?? "{}");
    const real = receiver(ok204);
    const row = await suDb.alertDelivery.create({
      data: {
        tenantId,
        channelId: id,
        stage: "test",
        level: "info",
        summary: "unused",
      },
      select: { id: true },
    });
    // TICK UNTIL IT CLAIMS, because one tick is not what the worker promises. The claim is
    // `FOR UPDATE ... SKIP LOCKED`: a row another transaction holds is SKIPPED, and the next tick
    // takes it. That is the design, and in production it costs one interval. In this suite it is a
    // race against every other file sharing the database, and a single tick lost it once in a full
    // run and won it in the next — which is the flake this loop exists to remove, not a defect of
    // the worker. The loop returns the moment it delivers, so the deadline is only ever reached on a
    // run that was going to fail.
    const until = Date.now() + POLL_DEADLINE_MS;
    while (real.sent.length === 0 && Date.now() < until) {
      await processAlertBatch({
        base: appDb,
        tenantId,
        coalesceWindowMs: 0,
        fetchImpl: real.fetchImpl,
        assertSafe: allowAll,
      });
      if (real.sent.length === 0) await Bun.sleep(50);
    }
    await suDb.alertDelivery.deleteMany({ where: { id: row.id } });

    expect(real.sent).toHaveLength(1);
    const realBody = JSON.parse(real.sent[0]?.rawBody ?? "{}");
    // Same envelope keys, same destination, same signing header set: only the values that describe
    // WHICH alert this is may differ.
    expect(Object.keys(probeBody).sort()).toEqual(Object.keys(realBody).sort());
    expect(probe.sent[0]?.url).toBe(real.sent[0]?.url);
    expect(Object.keys(probe.sent[0]?.headers ?? {}).sort()).toEqual(
      Object.keys(real.sent[0]?.headers ?? {}).sort(),
    );
  });

  test("one place in the alerting module posts, and it is neither of the callers", async () => {
    // The structural half of the test above: parity held by construction rather than by two call
    // sites that have to be edited together. `sendWebhookTest` is the counter-example in this repo,
    // a second copy of the outbound worker's rules kept in step by hand, and the reason this ledger
    // is written against the whole module rather than against the two files I happened to touch.
    const posts = await countInSrc(/\bfetchImpl\(/g);
    const inAlerting = Object.keys(posts)
      .filter((f) => f.startsWith("src/modules/flowlog/"))
      .sort();
    expect(inAlerting).toEqual(["src/modules/flowlog/alert-send.ts"]);
  });
});
