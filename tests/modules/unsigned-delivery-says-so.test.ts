import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import { processAlertBatch } from "@/modules/flowlog/alert-worker";
import {
  createAlertChannel,
  listAlertChannels,
} from "@/modules/flowlog/channels";
import {
  createWebhookSubscription,
  listWebhookSubscriptions,
} from "@/modules/webhooks/outbound/subscriptions";
import { sendWebhookTest } from "@/modules/webhooks/outbound/test";
import { processOutboundBatch } from "@/modules/webhooks/outbound/worker";
import { outboundUrl } from "../utils/outbound";
import { POLL_DEADLINE_MS } from "../utils/poll";

// ── A DELIVERY THAT WENT OUT UNSIGNED SAYS SO, AND SAYS WHICH PROBLEM IT WAS ──
//
// A signing secret is a vault REFERENCE; when it stops resolving (entry deleted, or never filled)
// `tryResolveVaultSecret` returns null without throwing and both workers POST unsigned. Stopping
// delivery is wrong: in this family not arriving is the damage itself. So the row records it, as
// advice from `resolveVaultRefState` ("deleted" and "never filled" send the operator to different
// places). The mark lives on the DELIVERY, not the channel: a channel-level mark heals once the
// credential is fixed, and whoever investigates Tuesday's dropped alert needs Tuesday's row.

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

const ctx = (): TenantContext => ({
  tenantId,
  userId: 724n,
  role: "TENANT_ADMIN",
});

interface Sent {
  headers: Record<string, string>;
  rawBody: string;
}

function receiver() {
  const sent: Sent[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent.push({
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      ),
      rawBody: String(init?.body ?? ""),
    });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

const allowAll = async (u: string) => new URL(u);
// Both spellings go out together, so checking one is not checking the signature.
const signatureHeaders = (s: Sent | undefined) =>
  Object.keys(s?.headers ?? {}).filter((h) => h.endsWith("-signature"));

describe.skipIf(!dbUp)("a delivery that went out unsigned", () => {
  beforeAll(async () => {
    if (!su) return;
    const t = await su.tenant.create({
      data: { name: "U724", slug: `u724-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    if (su && tenantId) {
      for (const table of [
        "alert_deliveries",
        "outbound_webhook_deliveries",
        "audit_logs",
        "alert_channels",
        "webhook_subscriptions",
        "vault_entries",
      ]) {
        await su.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  async function vaultEntry(name: string, status: "active" | "pending") {
    return await suDb.vaultEntry.create({
      data: {
        tenantId,
        name,
        kind: "generic",
        secret: encryptJson("s3cr3t"),
        status,
      },
      select: { id: true },
    });
  }

  async function channelWith(name: string, secretRef: string | null) {
    const c = await createAlertChannel(
      ctx(),
      {
        name,
        type: "webhook",
        url: outboundUrl(`/${name}`),
        ...(secretRef ? { secretRef } : {}),
      },
      appDb,
    );
    return BigInt(c.id);
  }

  // Drives the REAL worker, not the send in isolation: the claim is about what the row holds after
  // the delivery, and only the worker writes the row.
  //
  // It TICKS until the row is claimed rather than ticking once. `claimDue` takes its rows with
  // `FOR UPDATE ... SKIP LOCKED`, so a row another transaction happens to be holding is not waited
  // for, it is skipped, and the batch comes back having claimed nothing. Alone that never happens
  // and under the full suite it does, which is how it presents: a green file and one red run whose
  // message is about an empty `unsignedReason` rather than about a claim that never occurred.
  async function deliverOnce(channelId: bigint) {
    const r = receiver();
    const row = await suDb.alertDelivery.create({
      data: {
        tenantId,
        channelId,
        stage: "generate",
        level: "error",
        summary: "boom",
      },
      select: { id: true },
    });
    const deadline = Date.now() + POLL_DEADLINE_MS;
    let after = await suDb.alertDelivery.findUniqueOrThrow({
      where: { id: row.id },
    });
    while (after.status === "PENDING" && Date.now() < deadline) {
      await processAlertBatch({
        base: appDb,
        tenantId,
        coalesceWindowMs: 0,
        fetchImpl: r.fetchImpl,
        assertSafe: allowAll,
      });
      after = await suDb.alertDelivery.findUniqueOrThrow({
        where: { id: row.id },
      });
    }
    return { sent: r.sent, row: after };
  }

  test("a deleted credential still delivers, unsigned, and the row says which problem it was", async () => {
    const v = await vaultEntry("gone", "active");
    const id = await channelWith("deleted", `vault:${v.id}`);
    await suDb.vaultEntry.delete({ where: { id: v.id } });

    const { sent, row } = await deliverOnce(id);

    // (a) it ARRIVES. Not delivering is the damage itself in this family.
    expect(sent).toHaveLength(1);
    // (b) unsigned, on both spellings.
    expect(signatureHeaders(sent[0])).toEqual([]);
    // (c) and it does not re-enter the ladder: the alert already arrived, a retry duplicates it.
    expect(row.status).toBe("DELIVERED");
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt).toBe(null);
    // (d) the row records the fact, and as advice a person can act on.
    expect(row.unsignedReason ?? "").not.toBe("");
    expect((row.unsignedReason ?? "").toLowerCase()).toContain("unsigned");
    // (e) and the mark did not overwrite the alert's own body.
    expect(row.summary).toBe("boom");
  });

  test("deleted and never-filled are different advice, not one sentence for both", async () => {
    const gone = await vaultEntry("gone2", "active");
    const deletedId = await channelWith("deleted2", `vault:${gone.id}`);
    await suDb.vaultEntry.delete({ where: { id: gone.id } });
    const empty = await vaultEntry("never-filled", "pending");
    const pendingId = await channelWith("pending", `vault:${empty.id}`);

    const d = await deliverOnce(deletedId);
    const p = await deliverOnce(pendingId);

    expect(signatureHeaders(d.sent[0])).toEqual([]);
    expect(signatureHeaders(p.sent[0])).toEqual([]);
    // Telling someone to fill in a credential that was DELETED sends them looking for a row that is
    // not there. `tryResolveVaultSecret` collapses both into null; `resolveVaultRefState` does not.
    expect(d.row.unsignedReason).not.toBe(p.row.unsignedReason);
    // Both are prose, not an opaque enum: the person reading the value has to be able to act on it.
    expect((d.row.unsignedReason ?? "").split(" ").length).toBeGreaterThan(4);
    expect((p.row.unsignedReason ?? "").split(" ").length).toBeGreaterThan(4);
  });

  test("the two happy paths stay quiet, and the silent one is the expensive noise", async () => {
    const live = await vaultEntry("live", "active");
    const signedId = await channelWith("signed", `vault:${live.id}`);
    const plainId = await channelWith("plain", null);

    const s = await deliverOnce(signedId);
    const p = await deliverOnce(plainId);

    // The signed one really signs, checked against the secret rather than against the code.
    const ts = s.sent[0]?.headers["x-fazerai-timestamp"];
    const expected = createHmac("sha256", "s3cr3t")
      .update(`${ts}.${s.sent[0]?.rawBody}`)
      .digest("hex");
    expect(s.sent[0]?.headers["x-fazerai-signature"]).toBe(
      `sha256=${expected}`,
    );
    expect(s.row.unsignedReason).toBe(null);
    // And a channel that never configured a secret is NOT a problem to report. Marking it would be
    // the most expensive noise available: an operator learning to skip the mark.
    expect(signatureHeaders(p.sent[0])).toEqual([]);
    expect(p.row.unsignedReason).toBe(null);
  });

  test("fixing the credential signs the next one and does not heal the old row", async () => {
    const empty = await vaultEntry("to-fill", "pending");
    const id = await channelWith("healing", `vault:${empty.id}`);

    const before = await deliverOnce(id);
    expect(before.row.unsignedReason ?? "").not.toBe("");

    // NOTE: the operator fills the credential in, so the reference resolves from here on.
    await suDb.vaultEntry.update({
      where: { id: empty.id },
      data: { status: "active", secret: encryptJson("s3cr3t") },
    });
    const after = await deliverOnce(id);

    // The next delivery signs.
    expect(signatureHeaders(after.sent[0]).length).toBeGreaterThan(0);
    expect(after.row.unsignedReason).toBe(null);
    // THE OLD ROW DOES NOT HEAL. This is why the mark is on the delivery and not on the channel:
    // whoever is investigating why a receiver dropped an alert on Tuesday needs Tuesday's row, and a
    // channel-level mark disappears the moment the credential is fixed.
    const old = await suDb.alertDelivery.findUniqueOrThrow({
      where: { id: before.row.id },
    });
    expect(old.unsignedReason).toBe(before.row.unsignedReason);
  });
});

// ── THE SAME FACT, ON THE SCREEN AND ON THE OTHER BUS ──────────────────────────────────────────
//
// The delivery row is what an incident is read from afterwards. These two keep the operator from
// having to reach an incident first: the channel list, which asks the vault (the row alone cannot
// see the two vault states), and the outbound webhook family, whose probe sends where its worker does.

describe.skipIf(!dbUp)(
  "the channel list answers whether alerts are signed",
  () => {
    beforeAll(async () => {
      if (!su) return;
      const t = await su.tenant.create({
        data: { name: "U724b", slug: `u724b-${process.pid}` },
      });
      tenantId = t.id;
    });

    afterAll(async () => {
      if (su && tenantId) {
        for (const table of [
          "alert_channels",
          "webhook_subscriptions",
          "vault_entries",
        ]) {
          await su.$executeRawUnsafe(
            `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
          );
        }
        await su.$executeRawUnsafe(
          `DELETE FROM tenants WHERE id = ${tenantId}`,
        );
      }
    });

    test("each of the six states is its own answer, and only one of them is Signed", async () => {
      const filled = await suDb.vaultEntry.create({
        data: {
          tenantId,
          name: "ok",
          kind: "generic",
          secret: encryptJson("s"),
          status: "active",
        },
        select: { id: true },
      });
      const empty = await suDb.vaultEntry.create({
        data: {
          tenantId,
          name: "empty",
          kind: "generic",
          secret: encryptJson({}),
          status: "pending",
        },
        select: { id: true },
      });
      const doomed = await suDb.vaultEntry.create({
        data: {
          tenantId,
          name: "doomed",
          kind: "generic",
          secret: encryptJson("s"),
          status: "active",
        },
        select: { id: true },
      });

      const mk = async (name: string, over: Record<string, unknown>) =>
        await createAlertChannel(
          ctx(),
          { name, type: "webhook", url: outboundUrl(`/${name}`), ...over },
          appDb,
        );

      await mk("signed", { secretRef: `vault:${filled.id}` });
      await mk("pending", { secretRef: `vault:${empty.id}` });
      await mk("missing", { secretRef: `vault:${doomed.id}` });
      await mk("none", {});
      const ignored = await mk("ignored", { secretRef: `vault:${filled.id}` });
      // The stranded ref: the editor omits an untouched picker, so switching type keeps the column.
      await suDb.alertChannel.update({
        where: { id: BigInt(ignored.id) },
        data: { type: "discord" },
      });
      // A legacy row can hold a secret typed where a reference belongs. `readableVaultRef` refuses
      // to publish it, and the state has to say why.
      const unreadable = await mk("unreadable", {});
      await suDb.alertChannel.update({
        where: { id: BigInt(unreadable.id) },
        data: { secretRef: "sha256=not-a-reference" },
      });

      // NOTE: the credential is deleted AFTER the channel was saved: `requireVaultRef` checks on write,
      // and this is the window that opens afterwards.
      await suDb.vaultEntry.delete({ where: { id: doomed.id } });

      const byName = new Map(
        (await listAlertChannels(ctx(), appDb)).map((c) => [c.name, c]),
      );
      expect(byName.get("signed")?.signingState).toBe("signed");
      expect(byName.get("pending")?.signingState).toBe("pending");
      expect(byName.get("missing")?.signingState).toBe("missing");
      expect(byName.get("none")?.signingState).toBe("none");
      expect(byName.get("ignored")?.signingState).toBe("ignored");
      expect(byName.get("unreadable")?.signingState).toBe("unreadable");
      // And the older fields did not move under it: they are the published v1 shape.
      expect(byName.get("missing")?.hasSecret).toBe(true);
      expect(byName.get("missing")?.secretRef).toBe(`vault:${doomed.id}`);
      // The one nobody should be asked to act on is the one that reads as nothing.
      expect(byName.get("unreadable")?.secretRef).toBe(null);
    });
  },
);

describe.skipIf(!dbUp)(
  "the outbound webhook family carries the same fact",
  () => {
    beforeAll(async () => {
      if (!su) return;
      const t = await su.tenant.create({
        data: { name: "U724c", slug: `u724c-${process.pid}` },
      });
      tenantId = t.id;
    });

    afterAll(async () => {
      if (su && tenantId) {
        for (const table of [
          "outbound_webhook_deliveries",
          "audit_logs",
          "webhook_subscriptions",
          "vault_entries",
        ]) {
          await su.$executeRawUnsafe(
            `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
          );
        }
        await su.$executeRawUnsafe(
          `DELETE FROM tenants WHERE id = ${tenantId}`,
        );
      }
    });

    async function subscription(name: string) {
      const v = await suDb.vaultEntry.create({
        data: {
          tenantId,
          name,
          kind: "generic",
          secret: encryptJson("s3cr3t"),
          status: "active",
        },
        select: { id: true },
      });
      const sub = await createWebhookSubscription(
        ctx(),
        {
          url: outboundUrl(`/${name}`),
          events: ["conversation.created"],
          secretRef: `vault:${v.id}`,
        },
        appDb,
      );
      await suDb.vaultEntry.delete({ where: { id: v.id } });
      return BigInt(sub.id);
    }

    test("the worker delivers unsigned and the LEDGER says so, not just the process log", async () => {
      const subscriptionId = await subscription("worker");
      const row = await suDb.outboundWebhookDelivery.create({
        data: {
          tenantId,
          subscriptionId,
          event: "conversation.created",
          payload: { version: 1 },
        },
        select: { id: true },
      });
      // Ticks until claimed, for the same `SKIP LOCKED` reason as the alert half above.
      const r = receiver();
      const deadline = Date.now() + POLL_DEADLINE_MS;
      let after = await suDb.outboundWebhookDelivery.findUniqueOrThrow({
        where: { id: row.id },
      });
      while (after.status === "PENDING" && Date.now() < deadline) {
        await processOutboundBatch({
          base: appDb,
          tenantId,
          fetchImpl: r.fetchImpl,
          assertSafe: allowAll,
        });
        after = await suDb.outboundWebhookDelivery.findUniqueOrThrow({
          where: { id: row.id },
        });
      }

      expect(r.sent).toHaveLength(1);
      expect(signatureHeaders(r.sent[0])).toEqual([]);
      // NOTE: delivered, not retried: a missing secret does not fall through to retry/backoff.
      expect(after.status).toBe("DELIVERED");
      expect(after.attempts).toBe(1);
      expect(after.lastError).toBe(null);
      // The delivery ledger is the operator-readable surface of this family, and this is the row it
      // shows: a clean 2xx that a verifying receiver threw away.
      expect((after.unsignedReason ?? "").toLowerCase()).toContain("unsigned");
    });

    test("the subscription list stops calling a deleted credential Signed", async () => {
      // NOTE: a label derived from the row alone reads a ref whose entry was deleted exactly like a
      // live one.
      await subscription("list-gone");
      const live = await suDb.vaultEntry.create({
        data: {
          tenantId,
          name: "list-live",
          kind: "generic",
          secret: encryptJson("s3cr3t"),
          status: "active",
        },
        select: { id: true },
      });
      const empty = await suDb.vaultEntry.create({
        data: {
          tenantId,
          name: "list-empty",
          kind: "generic",
          secret: encryptJson({}),
          status: "pending",
        },
        select: { id: true },
      });
      await createWebhookSubscription(
        ctx(),
        {
          url: outboundUrl("/list-live"),
          events: ["conversation.created"],
          secretRef: `vault:${live.id}`,
        },
        appDb,
      );
      await createWebhookSubscription(
        ctx(),
        {
          url: outboundUrl("/list-empty"),
          events: ["conversation.created"],
          secretRef: `vault:${empty.id}`,
        },
        appDb,
      );
      await createWebhookSubscription(
        ctx(),
        { url: outboundUrl("/list-none"), events: ["conversation.created"] },
        appDb,
      );

      const byUrl = new Map(
        (await listWebhookSubscriptions(ctx(), appDb)).map((x) => [x.url, x]),
      );
      expect(byUrl.get(outboundUrl("/list-live"))?.signingState).toBe("signed");
      expect(byUrl.get(outboundUrl("/list-empty"))?.signingState).toBe(
        "pending",
      );
      expect(byUrl.get(outboundUrl("/list-none"))?.signingState).toBe("none");
      expect(byUrl.get(outboundUrl("/list-gone"))?.signingState).toBe(
        "missing",
      );
      // The deleted one still PUBLISHES its ref — the column holds it and the audit trail records it —
      // and that is exactly why the state has to be a separate field rather than inferred from it.
      expect(byUrl.get(outboundUrl("/list-gone"))?.hasSecret).toBe(true);
    });

    test("the Test button stops refusing what its own worker sends", async () => {
      const subscriptionId = await subscription("probe");
      const seen: Sent[] = [];
      const original = globalThis.fetch;
      globalThis.fetch = (async (_url: string, init: RequestInit) => {
        seen.push({
          headers: Object.fromEntries(
            Object.entries((init?.headers ?? {}) as Record<string, string>),
          ),
          rawBody: String(init?.body ?? ""),
        });
        return new Response("ok", { status: 200 });
      }) as unknown as typeof fetch;
      let result: Awaited<ReturnType<typeof sendWebhookTest>>;
      try {
        result = await sendWebhookTest(ctx(), subscriptionId, appDb);
      } finally {
        globalThis.fetch = original;
      }

      // NOTE: the probe sends as the worker does: a probe on a different path from the real send
      // condemns what works and approves what does not.
      expect(seen).toHaveLength(1);
      expect(signatureHeaders(seen[0])).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.error).toBe(null);
      // NOTE: `ok` alone would hide that it went unsigned, so the outcome carries the sentence.
      expect(result.signed).toBe(false);
      expect((result.warning ?? "").toLowerCase()).toContain("unsigned");
    });
  },
);
