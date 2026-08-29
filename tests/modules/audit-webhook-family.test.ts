import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import {
  createAlertChannel,
  deleteAlertChannel,
  updateAlertChannel,
} from "@/modules/flowlog/channels";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import {
  alertChannelCreate,
  alertChannelDelete,
  webhookCreate,
  webhookDeliveryRequeue,
  webhookUpdate,
} from "@/modules/mcp/write-webhooks";
import { requeueWebhookDelivery } from "@/modules/webhooks/outbound/deliveries";
import {
  createWebhookSubscription,
  deleteWebhookSubscription,
  updateWebhookSubscription,
} from "@/modules/webhooks/outbound/subscriptions";
import { sendWebhookTest } from "@/modules/webhooks/outbound/test";
import { countingBase } from "../utils/counting-base";
import { outboundUrl } from "../utils/outbound";
import { countInSrc } from "../utils/source-text";

// The outbound-webhook and alert-channel trail, moved into the services that perform the writes
// (issue #397, under the epic #306).
//
// Seven actions existed and all seven were written by an MCP tool after the service had already
// committed, so the same change made from the console left no row at all — every probe in this file
// fails on the base for that reason. Two things this family carries that the proving family did not:
//
//   - Both halves hold a secret in the row's neighbourhood. A subscription's `secretRef` is a vault
//     REFERENCE (`vault:<id>`, canonicalized on write by `requireVaultRef`, and these services are
//     the only writers of the column), and an alert channel's `url` is stored encrypted because a
//     Discord URL embeds a bot token. The row names the ref and the MASKED url, never either secret.
//   - The alert-channel editor PATCHes its whole form on every save, so a row per apply is not noise
//     here: it is the only thing that would show a save that changed something the operator did not
//     mean to change.

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
let tenantId = 0n;
let secretId = 0n;

const USER = 9391n;
const DISCORD_TOKEN = "abcdefTOKEN";

const ctx = (over: Partial<TenantContext> = {}): TenantContext => ({
  tenantId,
  userId: USER,
  role: "TENANT_ADMIN",
  ...over,
});

const principal = (over: Partial<VerifiedToken> = {}): VerifiedToken => ({
  userId: USER,
  tenantId,
  role: "TENANT_ADMIN",
  scopes: ["mcp:read", "mcp:write"],
  clientId: "c",
  jti: "j",
  ...over,
});

async function rows(action?: string) {
  return (
    (await su?.auditLog.findMany({
      where: { tenantId, ...(action ? { action } : {}) },
      orderBy: { id: "asc" },
    })) ?? []
  );
}

// The row holds BigInt ids, which `JSON.stringify` refuses outright.
function textOf(row: unknown): string {
  return JSON.stringify(row, (_k, v) =>
    typeof v === "bigint" ? String(v) : v,
  );
}

async function clearAudit() {
  await su?.$executeRawUnsafe(
    `DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`,
  );
}

async function seedDelivery(subscriptionId: bigint): Promise<bigint> {
  const row = await (su as PrismaClient).outboundWebhookDelivery.create({
    data: {
      tenantId,
      subscriptionId,
      event: "conversation.created",
      payload: { value: 42 },
      status: "DEAD",
      attempts: 8,
      lastError: "non-2xx response: 500",
    },
  });
  return row.id;
}

// ── the fence under the projection's own justification ──
//
// Both projections carry `secretRef` in full, on the grounds that it is a REFERENCE and never a
// secret — and that grounds is not a property of the column, which is a plain string, but of these
// two services being the only writers of it: both canonicalize through `requireVaultRef`. An audit
// row is append-only and readable by every tenant admin, so a third writer that stored a raw value
// there would put it somewhere no correction reaches, and nothing would fail.
//
// The count is what says so, and it runs without a database because it reads the tree.
describe("the projections' claim about who writes these columns", () => {
  const OWNERS: Record<string, string> = {
    webhookSubscription: "src/modules/webhooks/outbound/subscriptions.ts",
    alertChannel: "src/modules/flowlog/channels.ts",
  };

  for (const [model, owner] of Object.entries(OWNERS)) {
    test(`only ${owner} writes ${model}`, async () => {
      // Every Prisma write verb that can put a value in a column, not just the two these services
      // happen to use: an `upsert` or an `updateManyAndReturn` added later is the same defect.
      const found = await countInSrc(
        new RegExp(
          `\\b${model}\\.(create|createMany|update|updateMany|upsert)\\w*\\(`,
          "g",
        ),
      );
      expect(Object.keys(found).sort()).toEqual([owner]);
    });
  }
});

describe.skipIf(!dbUp)("the webhook and alert-channel trail", () => {
  beforeAll(async () => {
    if (!su) return;
    const t = await su.tenant.create({
      data: { name: "AWH", slug: `awh-${process.pid}` },
    });
    tenantId = t.id;
    const sec = await su.vaultEntry.create({
      data: {
        tenantId,
        name: "wh-secret",
        kind: "generic",
        secret: encryptJson("signing-secret"),
      },
      select: { id: true },
    });
    secretId = sec.id;
    await su.vaultEntry.create({
      data: {
        tenantId,
        name: "discord-url",
        kind: "generic",
        secret: encryptJson(outboundUrl(`/api/webhooks/123/${DISCORD_TOKEN}`)),
      },
    });
  });

  afterAll(async () => {
    if (su && tenantId) {
      for (const table of [
        "audit_logs",
        "outbound_webhook_deliveries",
        "webhook_subscriptions",
        "alert_channels",
        "scheduler_jobs",
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

  // ── outbound subscriptions ──

  test("creating a subscription through the service writes the row the MCP tool used to write", async () => {
    await clearAudit();
    const created = await createWebhookSubscription(
      ctx(),
      { url: outboundUrl("/hook"), events: ["conversation.created"] },
      appDb,
    );
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row?.action).toBe("webhook.create");
    expect(row?.target).toBe(`webhook:${created.id}`);
    expect(row?.actorId).toBe(USER);
    // No transport said so: absent on the context means the cookie session.
    expect(row?.actorType).toBe("user");
    expect(row?.after).toMatchObject({
      urlMasked: "https://203.0.113.10/…",
      events: ["conversation.created"],
      enabled: true,
    });
  });

  test("an update carries what changed, before and after", async () => {
    const created = await createWebhookSubscription(
      ctx(),
      { url: outboundUrl("/before"), events: ["conversation.created"] },
      appDb,
    );
    await clearAudit();
    await updateWebhookSubscription(
      ctx(),
      BigInt(created.id),
      { url: outboundUrl("/after"), enabled: false },
      appDb,
    );
    const [row] = await rows();
    expect(row?.action).toBe("webhook.update");
    expect(row?.target).toBe(`webhook:${created.id}`);
    // Both URLs are on the same host, so the mask is identical on both sides and `urlReplaced` is
    // what says the destination moved. `enabled` is the field the projection can show.
    expect(row?.before).toMatchObject({
      urlMasked: "https://203.0.113.10/…",
      enabled: true,
    });
    expect(row?.after).toMatchObject({
      urlMasked: "https://203.0.113.10/…",
      enabled: false,
      urlReplaced: true,
    });
  });

  test("the row names the vault entry a signing secret came from, never the secret", async () => {
    await clearAudit();
    const created = await createWebhookSubscription(
      ctx(),
      {
        url: outboundUrl("/signed"),
        events: ["conversation.created"],
        secretRef: `vault:${secretId}`,
      },
      appDb,
    );
    const [row] = await rows();
    expect(row?.action).toBe("webhook.create");
    expect(row?.after).toMatchObject({ secretRef: `vault:${secretId}` });
    expect(textOf(row)).not.toContain("signing-secret");
    await clearAudit();
    // Rotating it is a change the trail has to carry: the ref moves, the secret never appears.
    await updateWebhookSubscription(
      ctx(),
      BigInt(created.id),
      { secretRef: null },
      appDb,
    );
    const [rotated] = await rows();
    expect(rotated?.before).toMatchObject({ secretRef: `vault:${secretId}` });
    expect(rotated?.after).toMatchObject({ secretRef: null });
  });

  test("a credential in the URL does not reach the row, which outlives the subscription", async () => {
    await clearAudit();
    // The three places one hides, and the live read surfaces return all of them whole — those are
    // deletable and this row is not.
    const created = await createWebhookSubscription(
      ctx(),
      {
        url: `https://user:PWSECRET@203.0.113.10/hook?token=QSECRET#f=HSECRET`,
        events: ["conversation.created"],
      },
      appDb,
    );
    const [row] = await rows();
    expect(row?.action).toBe("webhook.create");
    expect(row?.after).toMatchObject({ urlMasked: "https://203.0.113.10/…" });
    for (const secret of ["PWSECRET", "QSECRET", "HSECRET"]) {
      expect(textOf(row)).not.toContain(secret);
    }
    // The column still holds it whole: this is the trail's rule, not a change to what is stored.
    expect(created.url).toContain("QSECRET");
  });

  test("rotating a token the row cannot show still writes a row", async () => {
    const created = await createWebhookSubscription(
      ctx(),
      {
        url: "https://203.0.113.10/hook?token=OLDSECRET",
        events: ["conversation.created"],
      },
      appDb,
    );
    await clearAudit();
    await updateWebhookSubscription(
      ctx(),
      BigInt(created.id),
      { url: "https://203.0.113.10/hook?token=NEWSECRET" },
      appDb,
    );
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    // Both sides redact to the same string, so nothing in the projection moved.
    expect((row?.before as { urlMasked: string })?.urlMasked).toBe(
      (row?.after as { urlMasked: string })?.urlMasked,
    );
    expect(row?.after).toMatchObject({ urlReplaced: true });
    expect(textOf(row)).not.toContain("NEWSECRET");
  });

  test("a concurrent update cannot file a change it did not make", async () => {
    // The narrow window the row lock exists for, and the same shape the delivery requeue is tested
    // with. A first writer commits `enabled: false` while holding the row; this update takes the
    // lock, so its snapshot is what the holder left. Without the lock its `findFirst` reads the
    // pre-holder state, the `updateMany` then blocks and wakes, and the row it files says
    // `enabled: true → false` — the holder's change, attributed to this writer.
    const created = await createWebhookSubscription(
      ctx(),
      { url: outboundUrl("/race"), events: ["conversation.created"] },
      appDb,
    );
    await clearAudit();
    let held = false;
    const holder = (su as PrismaClient).$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE webhook_subscriptions SET enabled = false WHERE id = ${created.id}`,
        );
        held = true;
        await Bun.sleep(500);
      },
      { timeout: 10_000 },
    );
    await Bun.sleep(120);
    // The rendezvous FIRED: without this the test is a `sleep` with a better name.
    expect(held).toBe(true);
    await Promise.all([
      holder,
      updateWebhookSubscription(
        ctx(),
        BigInt(created.id),
        { events: ["conversation.handoff"] },
        appDb,
      ),
    ]);
    const [row] = await rows();
    expect(row?.action).toBe("webhook.update");
    expect(row?.before).toMatchObject({ enabled: false });
    expect(row?.after).toMatchObject({ enabled: false });
  });

  test("a subscription save that moves nothing writes no row", async () => {
    const created = await createWebhookSubscription(
      ctx(),
      { url: outboundUrl("/unchanged"), events: ["conversation.created"] },
      appDb,
    );
    await clearAudit();
    // A caller is free to PATCH a field to the value it already holds; `enabled` is the one the
    // console's own toggle sends.
    await updateWebhookSubscription(
      ctx(),
      BigInt(created.id),
      { enabled: true },
      appDb,
    );
    expect(await rows()).toEqual([]);
    // The positive control, same call, same row: one field moved.
    await updateWebhookSubscription(
      ctx(),
      BigInt(created.id),
      { enabled: false },
      appDb,
    );
    expect((await rows()).map((r) => r.action)).toEqual(["webhook.update"]);
  });

  test("a delete leaves the record of what was deleted", async () => {
    const created = await createWebhookSubscription(
      ctx(),
      { url: outboundUrl("/doomed"), events: ["conversation.created"] },
      appDb,
    );
    await clearAudit();
    await deleteWebhookSubscription(ctx(), BigInt(created.id), appDb);
    const [row] = await rows();
    expect(row?.action).toBe("webhook.delete");
    expect(row?.target).toBe(`webhook:${created.id}`);
    expect(row?.before).toMatchObject({ urlMasked: "https://203.0.113.10/…" });
  });

  test("a delete records what the last writer left, not what this caller first saw", async () => {
    // The delete takes the same lock as the update, and for the same reason: an update committing
    // between an unlocked snapshot and the `deleteMany` leaves the row describing a subscription
    // that no longer looked like that when it was removed.
    const created = await createWebhookSubscription(
      ctx(),
      { url: outboundUrl("/race-del"), events: ["conversation.created"] },
      appDb,
    );
    await clearAudit();
    let held = false;
    const holder = (su as PrismaClient).$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE webhook_subscriptions SET enabled = false WHERE id = ${created.id}`,
        );
        held = true;
        await Bun.sleep(500);
      },
      { timeout: 10_000 },
    );
    await Bun.sleep(120);
    expect(held).toBe(true);
    await Promise.all([
      holder,
      deleteWebhookSubscription(ctx(), BigInt(created.id), appDb),
    ]);
    const [row] = await rows();
    expect(row?.action).toBe("webhook.delete");
    expect(row?.before).toMatchObject({
      enabled: false,
      urlMasked: "https://203.0.113.10/…",
    });
  });

  test("requeueing a dead delivery records the state the requeue undid", async () => {
    const sub = await createWebhookSubscription(
      ctx(),
      { url: outboundUrl("/requeue"), events: ["conversation.created"] },
      appDb,
    );
    const id = await seedDelivery(BigInt(sub.id));
    await clearAudit();
    await requeueWebhookDelivery(ctx(), id, appDb);
    const [row] = await rows();
    expect(row?.action).toBe("webhook_delivery.requeue");
    expect(row?.target).toBe(`webhook_delivery:${id}`);
    // The LOCKED read, which is the whole reason this one is recorded from inside the service.
    expect(row?.before).toMatchObject({ status: "DEAD", attempts: 8 });
    expect(row?.after).toMatchObject({ status: "PENDING", attempts: 0 });
  });

  // ── alert channels ──

  test("creating an alert channel records the masked URL and never the token in it", async () => {
    await clearAudit();
    const created = await createAlertChannel(
      ctx(),
      {
        name: "ops",
        type: "discord",
        url: outboundUrl(`/api/webhooks/123/${DISCORD_TOKEN}`),
        minLevel: "error",
      },
      appDb,
    );
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row?.action).toBe("alert_channel.create");
    expect(row?.target).toBe(`alert_channel:${created.id}`);
    expect(row?.after).toMatchObject({
      name: "ops",
      type: "discord",
      urlMasked: created.urlMasked,
    });
    // The row is readable by every tenant admin; the URL it names is the masked one.
    expect(textOf(row)).not.toContain(DISCORD_TOKEN);
  });

  test("a save that drops the signing secret says so, which is the console's own shape", async () => {
    const created = await createAlertChannel(
      ctx(),
      {
        name: "signed",
        type: "webhook",
        url: outboundUrl("/alerts"),
        secretRef: `vault:${secretId}`,
      },
      appDb,
    );
    expect(created.hasSecret).toBe(true);
    await clearAudit();
    // What the editor PATCHes on every save: the whole form, with `secretRef` null whenever the
    // operator did not retype it.
    await updateAlertChannel(
      ctx(),
      BigInt(created.id),
      { name: "renamed", secretRef: null },
      appDb,
    );
    const [row] = await rows();
    expect(row?.action).toBe("alert_channel.update");
    expect(row?.before).toMatchObject({
      name: "signed",
      secretRef: `vault:${secretId}`,
    });
    expect(row?.after).toMatchObject({ name: "renamed", secretRef: null });
  });

  test("a save that moves nothing writes no row", async () => {
    const created = await createAlertChannel(
      ctx(),
      { name: "still", type: "discord", url: outboundUrl("/same") },
      appDb,
    );
    await clearAudit();
    // Every field at the value it already holds, which is what the editor sends when the operator
    // opens it and saves without touching anything.
    await updateAlertChannel(
      ctx(),
      BigInt(created.id),
      {
        name: "still",
        type: "discord",
        minLevel: created.minLevel as "error",
        stages: created.stages,
        enabled: created.enabled,
      },
      appDb,
    );
    expect(await rows()).toEqual([]);
    // The positive control, on the same channel and through the same call: one field moved.
    await updateAlertChannel(
      ctx(),
      BigInt(created.id),
      { name: "moved" },
      appDb,
    );
    expect((await rows()).map((r) => r.action)).toEqual([
      "alert_channel.update",
    ]);
  });

  test("replacing the destination with another on the SAME host still writes a row", async () => {
    const created = await createAlertChannel(
      ctx(),
      {
        name: "rotated",
        type: "discord",
        url: outboundUrl("/api/webhooks/1/AAA"),
      },
      appDb,
    );
    await clearAudit();
    await updateAlertChannel(
      ctx(),
      BigInt(created.id),
      { url: outboundUrl("/api/webhooks/2/BBB") },
      appDb,
    );
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    // The mask is `scheme://host/…`, identical on both sides — everything the channel posts to has
    // changed and the projection alone cannot say so.
    expect(row?.action).toBe("alert_channel.update");
    expect((row?.before as { urlMasked: string })?.urlMasked).toBe(
      (row?.after as { urlMasked: string })?.urlMasked,
    );
    expect(row?.after).toMatchObject({ urlReplaced: true });
    expect(textOf(row)).not.toContain("BBB");
  });

  test("silencing a channel is a change the row carries", async () => {
    // The console has a toggle of its own for this, next to the editor. Disabling a channel stops
    // every alert it would have sent, which is the one change on this screen an operator is most
    // likely to be asked about later.
    const created = await createAlertChannel(
      ctx(),
      { name: "silenced", type: "discord", url: outboundUrl("/quiet") },
      appDb,
    );
    await clearAudit();
    await updateAlertChannel(
      ctx(),
      BigInt(created.id),
      { enabled: false },
      appDb,
    );
    const [row] = await rows();
    expect(row?.action).toBe("alert_channel.update");
    expect(row?.before).toMatchObject({ enabled: true });
    expect(row?.after).toMatchObject({ enabled: false });
  });

  test("narrowing what a channel is told about is a change too", async () => {
    // `minLevel` and `stages` decide which alerts reach the channel at all. Silence arrived at by
    // narrowing the filter looks exactly like silence arrived at by the toggle, from the outside.
    const created = await createAlertChannel(
      ctx(),
      {
        name: "narrowed",
        type: "discord",
        url: outboundUrl("/narrow"),
        minLevel: "info",
        stages: ["generate", "tool"],
      },
      appDb,
    );
    await clearAudit();
    await updateAlertChannel(
      ctx(),
      BigInt(created.id),
      { minLevel: "error", stages: ["generate"] },
      appDb,
    );
    const [row] = await rows();
    expect(row?.before).toMatchObject({
      minLevel: "info",
      stages: ["generate", "tool"],
    });
    expect(row?.after).toMatchObject({
      minLevel: "error",
      stages: ["generate"],
    });
  });

  test("deleting an alert channel names what was removed", async () => {
    const created = await createAlertChannel(
      ctx(),
      { name: "doomed", type: "discord", url: outboundUrl("/gone") },
      appDb,
    );
    await clearAudit();
    await deleteAlertChannel(ctx(), BigInt(created.id), appDb);
    const [row] = await rows();
    expect(row?.action).toBe("alert_channel.delete");
    expect(row?.target).toBe(`alert_channel:${created.id}`);
    expect(row?.before).toMatchObject({ name: "doomed", type: "discord" });
  });

  test("a concurrent channel update cannot file a change it did not make", async () => {
    const created = await createAlertChannel(
      ctx(),
      { name: "raced", type: "discord", url: outboundUrl("/race-ch") },
      appDb,
    );
    await clearAudit();
    let held = false;
    const holder = (su as PrismaClient).$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE alert_channels SET enabled = false WHERE id = ${created.id}`,
        );
        held = true;
        await Bun.sleep(500);
      },
      { timeout: 10_000 },
    );
    await Bun.sleep(120);
    expect(held).toBe(true);
    await Promise.all([
      holder,
      updateAlertChannel(ctx(), BigInt(created.id), { name: "raced2" }, appDb),
    ]);
    const [row] = await rows();
    expect(row?.action).toBe("alert_channel.update");
    expect(row?.before).toMatchObject({ name: "raced", enabled: false });
    expect(row?.after).toMatchObject({ name: "raced2", enabled: false });
  });

  test("a channel delete records what the last writer left", async () => {
    const created = await createAlertChannel(
      ctx(),
      { name: "race-del", type: "discord", url: outboundUrl("/race-chdel") },
      appDb,
    );
    await clearAudit();
    let held = false;
    const holder = (su as PrismaClient).$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE alert_channels SET enabled = false WHERE id = ${created.id}`,
        );
        held = true;
        await Bun.sleep(500);
      },
      { timeout: 10_000 },
    );
    await Bun.sleep(120);
    expect(held).toBe(true);
    await Promise.all([
      holder,
      deleteAlertChannel(ctx(), BigInt(created.id), appDb),
    ]);
    const [row] = await rows();
    expect(row?.action).toBe("alert_channel.delete");
    expect(row?.before).toMatchObject({ enabled: false, name: "race-del" });
  });

  test("a destination that will not decrypt is not reported as unchanged", async () => {
    // The blob is unreadable after a key rotation, and `maskUrl` already carries a fallback for it.
    // An update that leaves it alone cannot be SHOWN to have left the destination alone, so the row
    // says the destination moved rather than staying silent about the one case nobody can read.
    const row = await (su as PrismaClient).alertChannel.create({
      data: {
        tenantId,
        name: "unreadable",
        type: "discord",
        url: "not-a-blob",
        minLevel: "error",
        stages: [],
      },
      select: { id: true },
    });
    await clearAudit();
    await updateAlertChannel(
      ctx(),
      row.id,
      { name: "still unreadable" },
      appDb,
    );
    const [audit] = await rows();
    expect(audit?.action).toBe("alert_channel.update");
    expect(audit?.after).toMatchObject({ urlReplaced: true });
  });

  // ── attribution and the door ──

  test("a Bearer API key is attributed as one, not as a browser session", async () => {
    await clearAudit();
    await createWebhookSubscription(
      ctx({ actorType: "api_key" }),
      { url: outboundUrl("/by-key"), events: ["conversation.created"] },
      appDb,
    );
    const [row] = await rows();
    expect(row?.actorType).toBe("api_key");
    // The SAME action either way: the action names what changed, the actor names the door.
    expect(row?.action).toBe("webhook.create");
  });

  test("the MCP tools write one row each, not one per layer", async () => {
    await clearAudit();
    const created = await webhookCreate(
      principal(),
      {
        url: outboundUrl("/by-mcp"),
        events: ["conversation.created"],
        dry_run: false,
      },
      { base: appDb },
    );
    expect(created.ok).toBe(true);
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row?.action).toBe("webhook.create");
    expect(row?.actorType).toBe("mcp");
    expect(row?.actorId).toBe(USER);
  });

  test("an MCP update and an MCP delete write the service's actions too", async () => {
    const sub = await createWebhookSubscription(
      ctx(),
      { url: outboundUrl("/mcp-target"), events: ["conversation.created"] },
      appDb,
    );
    const channel = await createAlertChannel(
      ctx(),
      { name: "mcp-target", type: "discord", url: outboundUrl("/ch") },
      appDb,
    );
    await clearAudit();
    await webhookUpdate(
      principal(),
      { webhook_id: sub.id, enabled: false, dry_run: false },
      { base: appDb },
    );
    await alertChannelDelete(
      principal(),
      { channel_id: channel.id, dry_run: false },
      { base: appDb },
    );
    expect((await rows()).map((r) => r.action)).toEqual([
      "webhook.update",
      "alert_channel.delete",
    ]);
  });

  test("the MCP requeue records once, and from inside the service's lock", async () => {
    const sub = await createWebhookSubscription(
      ctx(),
      { url: outboundUrl("/mcp-requeue"), events: ["conversation.created"] },
      appDb,
    );
    const id = await seedDelivery(BigInt(sub.id));
    await clearAudit();
    const res = await webhookDeliveryRequeue(
      principal(),
      { delivery_id: String(id), dry_run: false },
      { base: appDb },
    );
    expect(res.ok).toBe(true);
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row?.action).toBe("webhook_delivery.requeue");
    expect(row?.actorType).toBe("mcp");
    // The tool used to be HANDED this, because its own read would have been outside the lock.
    expect(row?.before).toMatchObject({ status: "DEAD", attempts: 8 });
  });

  test("a dry run applies nothing and records nothing", async () => {
    await clearAudit();
    await webhookCreate(
      principal(),
      { url: outboundUrl("/previewed"), events: ["conversation.created"] },
      { base: appDb },
    );
    await alertChannelCreate(
      principal(),
      { name: "previewed", type: "discord", url_ref: "discord-url" },
      { base: appDb },
    );
    expect(await rows()).toEqual([]);
  });

  test("a refused mutation writes no row", async () => {
    await clearAudit();
    await expect(
      createWebhookSubscription(
        ctx(),
        { url: outboundUrl("/bad"), events: ["not.a.real.event"] },
        appDb,
      ),
    ).rejects.toThrow();
    expect(await rows()).toEqual([]);
  });

  // ── the row and the mutation share one transaction ──

  test("applying an MCP alert-channel write opens no transaction of its own", async () => {
    const { base, total } = countingBase(appDb);
    await clearAudit();
    const res = await alertChannelCreate(
      principal(),
      {
        name: "one tx",
        type: "discord",
        url_ref: "discord-url",
        dry_run: false,
      },
      { base },
    );
    expect(res.ok).toBe(true);
    // FIVE before this. Four of them are reads the tool takes before it writes anything —
    // `resolveSecretRef` resolves the name, `resolveSecretValue` resolves it again and then reads
    // the secret — and the mutation is the fourth. The fifth was the transport opening its OWN
    // transaction for the audit row, after the service had already committed: a failure in between
    // landed the change with no record of it.
    expect(total()).toBe(4);
    expect((await rows()).map((r) => r.action)).toEqual([
      "alert_channel.create",
    ]);
  });

  // ── the decision this family carries: the test send ──

  test("sending a test delivery records nothing, and the create beside it did", async () => {
    const created = await createWebhookSubscription(
      ctx(),
      { url: outboundUrl("/tested"), events: ["conversation.created"] },
      appDb,
    );
    // The create IS the positive control: the same tenant, the same reader, one row.
    expect((await rows("webhook.create")).length).toBeGreaterThan(0);
    await clearAudit();
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("ok", { status: 200 })) as unknown as typeof fetch;
    try {
      const result = await sendWebhookTest(ctx(), BigInt(created.id), appDb);
      expect(result.ok).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
    // The trail records CHANGES. A test send changes nothing here, and everything it can reach was
    // named by the audited registration that put the URL there — the same actor, the same trail.
    expect(await rows()).toEqual([]);
  });
});
