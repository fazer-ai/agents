import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import {
  approveDocumentRequest,
  createApprovalRequest,
  expireDueApprovalRequests,
  openedJobKey,
  rejectDocumentRequest,
} from "@/modules/documents/approval";
import { runOutcomeJob } from "@/modules/documents/approval-outcome";
import { freezeDocumentSnapshot } from "@/modules/documents/issue";
import { documentStarter } from "@/modules/documents/starters";
import { createDocumentTemplate } from "@/modules/documents/templates";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";
import { outboundUrl } from "../utils/outbound";

// A document approval request announces itself to the tenant's webhook subscriptions: once when it is
// opened, once when it is decided (approved, rejected or expired), and once when the outcome job
// records what the decision came to, with ids, statuses and times only (docs/api-and-fleet.md,
// Outbound webhooks).

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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const DIR = `/tmp/fazerai-doc-approval-events-${process.pid}`;
const CUSTOMER = "Ana Ribeiro Evento";
const NOTE = "nota interna do revisor";
let tenantA = 0n;
let tenantB = 0n;
let templateId = 0n;
let instanceId = 0n;
let conversationId = 0n;
let keySeq = 0;

function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

async function openRequest(): Promise<bigint> {
  const now = new Date();
  const frozen = await freezeDocumentSnapshot({
    ctx: ctx(tenantA),
    base: appDb,
    templateId,
    values: {
      cliente: CUSTOMER,
      itens: [{ description: "Consultoria", quantity: 2, unitPrice: 450 }],
      validade: "2026-09-05",
    },
    now,
  });
  const req = await createApprovalRequest({
    ctx: ctx(tenantA),
    base: appDb,
    frozen,
    idempotencyKey: `approval-events-${process.pid}-${++keySeq}`,
    threadId: `${tenantA}:${instanceId}:77`,
    chatwootInstanceId: instanceId,
    conversationId,
    now,
  });
  return BigInt(req.id);
}

type Delivery = { event: string; data: Record<string, unknown>; raw: string };

async function deliveries(tenantId: bigint, event: string) {
  const rows = await suDb.outboundWebhookDelivery.findMany({
    where: { tenantId, event },
    orderBy: { id: "asc" },
    select: { event: true, payload: true },
  });
  return rows.map(
    (r): Delivery => ({
      event: r.event,
      data: (r.payload as { data: Record<string, unknown> }).data,
      raw: JSON.stringify(r.payload),
    }),
  );
}

async function forRequest(event: string, requestId: bigint) {
  return (await deliveries(tenantA, event)).filter(
    (d) => d.data.request_id === String(requestId),
  );
}

describe.skipIf(!dbUp)("document approval outbound events", () => {
  beforeAll(async () => {
    tenantA = (
      await suDb.tenant.create({
        data: { name: "ApprEvA", slug: `appr-ev-a-${process.pid}` },
      })
    ).id;
    tenantB = (
      await suDb.tenant.create({
        data: { name: "ApprEvB", slug: `appr-ev-b-${process.pid}` },
      })
    ).id;
    const starter = documentStarter("quote", "pt-BR");
    if (!starter) throw new Error("no starter");
    const tpl = await createDocumentTemplate(
      ctx(tenantA),
      {
        name: starter.name,
        blocks: starter.blocks,
        fields: starter.fields,
        style: starter.style,
        numberPrefix: "EVT-",
      },
      appDb,
    );
    templateId = BigInt(tpl.id);
    await suDb.documentTemplate.update({
      where: { id: templateId },
      data: { requiresApproval: true },
    });
    const instance = await seedChatwootInstance(suDb, {
      tenantId: tenantA,
      accountId: 9100 + (process.pid % 800),
    });
    instanceId = instance.id;
    conversationId = (
      await suDb.conversation.create({
        data: {
          tenantId: tenantA,
          chatwootInstanceId: instanceId,
          chatwootConversationId: 77,
          status: "open",
          threadId: `${tenantA}:${instanceId}:77`,
        },
      })
    ).id;
    await suDb.webhookSubscription.create({
      data: {
        tenantId: tenantA,
        url: outboundUrl("/approvals"),
        events: [
          "document.approval_requested",
          "document.approval_decided",
          "document.approval_outcome",
        ],
        enabled: true,
      },
    });
    await suDb.webhookSubscription.create({
      data: {
        tenantId: tenantA,
        url: outboundUrl("/conversations"),
        events: ["conversation.created"],
        enabled: true,
      },
    });
    await suDb.webhookSubscription.create({
      data: {
        tenantId: tenantB,
        url: outboundUrl("/other-tenant"),
        events: ["document.approval_requested", "document.approval_decided"],
        enabled: true,
      },
    });
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB]) {
      if (!tid) continue;
      for (const table of [
        "outbound_webhook_deliveries",
        "webhook_subscriptions",
        "scheduler_jobs",
        "audit_logs",
        "document_approval_requests",
        "issued_documents",
        "document_templates",
        "conversations",
        "chatwoot_instances",
        "chatwoot_deployments",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tid}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
    await rm(DIR, { recursive: true, force: true });
  });

  test("opening a request announces it once, with its ids and expiry and none of the document's values", async () => {
    const id = await openRequest();
    const row = await suDb.documentApprovalRequest.findUniqueOrThrow({
      where: { id },
      select: { expiresAt: true },
    });
    const sent = await forRequest("document.approval_requested", id);
    expect(sent.map((d) => d.data)).toEqual([
      {
        request_id: String(id),
        template_id: String(templateId),
        conversation_id: String(conversationId),
        chatwoot_conversation_id: "77",
        expires_at: row.expiresAt.toISOString(),
        status: "pending",
      },
    ]);
    expect(sent.some((d) => d.raw.includes(CUSTOMER))).toBe(false);
  });

  test("two approvals racing announce one decision, carrying the document they issued", async () => {
    const id = await openRequest();
    const reviewer = (
      await suDb.user.create({
        data: {
          email: `appr-ev-${process.pid}@example.com`,
          name: "Revisor",
          passwordHash: "x",
        },
      })
    ).id;
    try {
      await Promise.all(
        [0, 1].map(() =>
          approveDocumentRequest({
            ctx: ctx(tenantA),
            requestId: id,
            reviewerUserId: reviewer,
            base: appDb,
            storageDir: DIR,
          }),
        ),
      );
      const row = await suDb.documentApprovalRequest.findUniqueOrThrow({
        where: { id },
        select: { issuedDocumentId: true, decidedAt: true },
      });
      const sent = await forRequest("document.approval_decided", id);
      expect(sent.map((d) => d.data)).toEqual([
        {
          request_id: String(id),
          conversation_id: String(conversationId),
          chatwoot_conversation_id: "77",
          status: "approved",
          reviewer_user_id: String(reviewer),
          issued_document_id: String(row.issuedDocumentId),
          decided_at: row.decidedAt?.toISOString(),
        },
      ]);
      expect(sent.some((d) => d.raw.includes("Revisor"))).toBe(false);
    } finally {
      await suDb.documentApprovalRequest.updateMany({
        where: { reviewerUserId: reviewer },
        data: { reviewerUserId: null },
      });
      await suDb.user.delete({ where: { id: reviewer } });
    }
  });

  test("a rejection announces its status without the reviewer's note, and a second one announces nothing", async () => {
    const id = await openRequest();
    await rejectDocumentRequest({
      ctx: ctx(tenantA),
      requestId: id,
      note: NOTE,
      base: appDb,
    });
    await rejectDocumentRequest({
      ctx: ctx(tenantA),
      requestId: id,
      note: NOTE,
      base: appDb,
    }).catch(() => undefined);
    const sent = await forRequest("document.approval_decided", id);
    expect(sent.map((d) => d.data.status)).toEqual(["rejected"]);
    expect(sent[0]?.data.issued_document_id).toBeNull();
    expect(sent.some((d) => d.raw.includes(NOTE))).toBe(false);
  });

  test("the expiry sweep announces each request it expires, once", async () => {
    const first = await openRequest();
    const second = await openRequest();
    const past = new Date(Date.now() - 60_000);
    await suDb.documentApprovalRequest.updateMany({
      where: { id: { in: [first, second] } },
      data: { expiresAt: past },
    });
    const now = new Date();
    const expired = await expireDueApprovalRequests(tenantA, now, appDb);
    expect(expired.map(String).sort()).toEqual(
      [String(first), String(second)].sort(),
    );
    expect(await expireDueApprovalRequests(tenantA, now, appDb)).toEqual([]);
    for (const id of [first, second]) {
      const sent = await forRequest("document.approval_decided", id);
      expect(sent.map((d) => d.data)).toEqual([
        {
          request_id: String(id),
          conversation_id: String(conversationId),
          chatwoot_conversation_id: "77",
          status: "expired",
          reviewer_user_id: null,
          issued_document_id: null,
          decided_at: now.toISOString(),
        },
      ]);
    }
  });

  test("the outcome job announces what the decision came to once, however many runs reach it", async () => {
    const id = await openRequest();
    await rejectDocumentRequest({
      ctx: ctx(tenantA),
      requestId: id,
      base: appDb,
    });
    // No bot on the conversation, so the outcome is that nobody could be told.
    await suDb.schedulerJob.deleteMany({
      where: { tenantId: tenantA, dedupeKey: openedJobKey(id) },
    });
    // Two runs racing past the "already recorded" read: only the one whose write lands announces.
    await Promise.all(
      [0, 1].map(() =>
        runOutcomeJob(tenantA, { requestId: String(id) }, appDb),
      ),
    );
    await runOutcomeJob(tenantA, { requestId: String(id) }, appDb);
    const row = await suDb.documentApprovalRequest.findUniqueOrThrow({
      where: { id },
      select: { outcome: true },
    });
    expect(row.outcome).toBe("NO_AGENT");
    const sent = await forRequest("document.approval_outcome", id);
    expect(sent.map((d) => d.data)).toEqual([
      {
        request_id: String(id),
        conversation_id: String(conversationId),
        chatwoot_conversation_id: "77",
        outcome: "no_agent",
      },
    ]);
  });

  test("only subscriptions to the event receive it, and never another tenant's", async () => {
    await openRequest();
    const toA = await suDb.outboundWebhookDelivery.findMany({
      where: { tenantId: tenantA, event: { startsWith: "document." } },
      select: { subscription: { select: { url: true } } },
    });
    expect(toA.length).toBeGreaterThan(0);
    expect(
      toA.every((d) => d.subscription.url === outboundUrl("/approvals")),
    ).toBe(true);
    expect(
      await suDb.outboundWebhookDelivery.count({
        where: { tenantId: tenantB },
      }),
    ).toBe(0);
  });
});
