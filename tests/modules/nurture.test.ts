import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { AppError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { drainNurtureEnrollments } from "@/modules/nurture/drain";
import {
  cancelEnrollment,
  enrollLead,
  listNurtureEnrollments,
} from "@/modules/nurture/enrollments";
import {
  cancelOutboxItem,
  listNurtureOutbox,
  markOutboxSent,
} from "@/modules/nurture/outbox";
import {
  createNurtureSequence,
  nurtureStepsSchema,
  updateNurtureSequence,
} from "@/modules/nurture/sequences";
import { renderNurtureTemplate } from "@/modules/nurture/templates";

// Nurture: template rendering is pure; the sequence -> enroll -> drain ->
// outbox -> mark-sent rail is exercised against the real app-role client so
// RLS is what proves tenant fencing. DB tests skip when no test database is up.

// ---------------------------------------------------------------------------
// Pure: templates + step schema
// ---------------------------------------------------------------------------

describe("renderNurtureTemplate", () => {
  test("fills name, product and platform; tolerates spacing", () => {
    const body = renderNurtureTemplate(
      "Hi {{ name }}, the {{product}} you asked about is on {{platform}}.",
      { name: "Lan", product: "Serum BHA", platform: "facebook" },
    );
    expect(body).toBe("Hi Lan, the Serum BHA you asked about is on facebook.");
  });

  test("a lead with no match renders product as empty, unknown tokens verbatim", () => {
    const body = renderNurtureTemplate("{{product}} for {{name}} {{coupon}}", {
      name: "Lan",
      product: null,
      platform: "tiktok",
    });
    expect(body).toBe(" for Lan {{coupon}}");
  });
});

describe("nurtureStepsSchema", () => {
  test("rejects an empty list and a step without a body", () => {
    expect(nurtureStepsSchema.safeParse([]).success).toBe(false);
    expect(
      nurtureStepsSchema.safeParse([
        { delayMin: 0, bodyTemplate: "", channel: "dm" },
      ]).success,
    ).toBe(false);
    expect(
      nurtureStepsSchema.safeParse([
        { delayMin: 0, bodyTemplate: "x", channel: "pigeon" },
      ]).success,
    ).toBe(false);
    expect(
      nurtureStepsSchema.safeParse([
        { delayMin: -5, bodyTemplate: "x", channel: "dm" },
      ]).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DB-backed: the human-executed rail end to end
// ---------------------------------------------------------------------------

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
let otherTenantId = 0n;
const ctx = (tid: bigint): TenantContext => ({
  tenantId: tid,
  userId: null,
  role: "TENANT_ADMIN",
});

describe.skipIf(!dbUp)("nurture rail", () => {
  let productId = 0n;
  let leadId = 0n;
  let otherLeadId = 0n;

  beforeAll(async () => {
    if (!su) return;
    const t = await su.tenant.create({
      data: { name: "Nurture", slug: `nurture-${process.pid}` },
    });
    tenantId = t.id;
    const t2 = await su.tenant.create({
      data: { name: "Nurture Other", slug: `nurture-o-${process.pid}` },
    });
    otherTenantId = t2.id;
    await runScopedOn(appDb, ctx(tenantId), async (db) => {
      const p = await db.merchantProduct.create({
        data: {
          tenantId,
          name: "Serum BHA 2%",
          price: 250000,
          tags: ["serum", "bha"],
        },
      });
      productId = p.id;
      const lead = await db.lead.create({
        data: {
          tenantId,
          platform: "facebook",
          authorName: "Lan Anh",
          text: "cần mua serum bha",
        },
      });
      leadId = lead.id;
      await db.leadProductMatch.create({
        data: { tenantId, leadId, productId, score: 0.9 },
      });
    });
    await runScopedOn(appDb, ctx(otherTenantId), async (db) => {
      const lead = await db.lead.create({
        data: {
          tenantId: otherTenantId,
          platform: "tiktok",
          authorName: "Other Shop",
          text: "x",
        },
      });
      otherLeadId = lead.id;
    });
  });

  afterAll(async () => {
    if (su && tenantId) {
      for (const table of [
        "nurture_outbox",
        "nurture_enrollments",
        "nurture_sequences",
        "lead_product_matches",
        "leads",
        "merchant_products",
        "audit_logs",
        "scheduler_jobs",
      ]) {
        await su.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id IN (${tenantId}, ${otherTenantId})`,
        );
      }
      await su.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id IN (${tenantId}, ${otherTenantId})`,
      );
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("sequence CRUD validates and audits", async () => {
    const seq = await createNurtureSequence(
      ctx(tenantId),
      {
        name: "Two-touch",
        steps: [
          { delayMin: 0, bodyTemplate: "Hi {{name}}", channel: "dm" },
          {
            delayMin: 1440,
            bodyTemplate: "Still thinking about {{product}}?",
            channel: "reply",
          },
        ],
      },
      appDb,
    );
    expect(seq.id).toBeTruthy();
    expect(seq.steps).toHaveLength(2);
    expect(seq.active).toBe(true);

    const updated = await updateNurtureSequence(
      ctx(tenantId),
      BigInt(seq.id),
      { name: "Two-touch v2" },
      appDb,
    );
    expect(updated.name).toBe("Two-touch v2");

    await expect(
      createNurtureSequence(ctx(tenantId), { name: "bad", steps: [] }, appDb),
    ).rejects.toBeInstanceOf(AppError);
  });

  test("enrollLead arms the first step's delay and is idempotent while ACTIVE", async () => {
    const seq = await createNurtureSequence(
      ctx(tenantId),
      {
        name: "Delay rail",
        steps: [{ delayMin: 60, bodyTemplate: "hi", channel: "dm" }],
      },
      appDb,
    );
    const before = Date.now();
    const en = await enrollLead(
      ctx(tenantId),
      { sequenceId: seq.id, leadId: String(leadId) },
      appDb,
    );
    expect(en.status).toBe("ACTIVE");
    expect(en.stepIndex).toBe(0);
    const runAt = en.nextRunAt.getTime();
    expect(runAt).toBeGreaterThanOrEqual(before + 59 * 60_000);
    expect(runAt).toBeLessThanOrEqual(Date.now() + 61 * 60_000);

    // The unique-active rule: a repeat enroll answers the SAME row.
    const again = await enrollLead(
      ctx(tenantId),
      { sequenceId: seq.id, leadId: String(leadId) },
      appDb,
    );
    expect(again.id).toBe(en.id);

    // Enrolling the drain armed a NURTURE_DRAIN scheduler row for the tenant.
    const job = await su?.schedulerJob.findFirst({
      where: { tenantId, kind: "NURTURE_DRAIN" },
    });
    expect(job).not.toBeNull();

    await cancelEnrollment(ctx(tenantId), BigInt(en.id), appDb);
  });

  test("enrolling a paused sequence 422s; a foreign lead 404s", async () => {
    const seq = await createNurtureSequence(
      ctx(tenantId),
      {
        name: "Paused",
        steps: [{ delayMin: 0, bodyTemplate: "hi", channel: "dm" }],
        active: false,
      },
      appDb,
    );
    await expect(
      enrollLead(
        ctx(tenantId),
        { sequenceId: seq.id, leadId: String(leadId) },
        appDb,
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    const activeSeq = await createNurtureSequence(
      ctx(tenantId),
      {
        name: "Scoped",
        steps: [{ delayMin: 0, bodyTemplate: "hi", channel: "dm" }],
      },
      appDb,
    );
    // The lead belongs to another tenant: the scoped read must not find it.
    await expect(
      enrollLead(
        ctx(tenantId),
        { sequenceId: activeSeq.id, leadId: String(otherLeadId) },
        appDb,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("the drain renders, stages PENDING outbox rows and walks to DONE", async () => {
    const seq = await createNurtureSequence(
      ctx(tenantId),
      {
        name: "Instant two-step",
        steps: [
          {
            delayMin: 0,
            bodyTemplate: "Hi {{name}}, saw you on {{platform}}",
            channel: "dm",
          },
          {
            delayMin: 0,
            bodyTemplate: "{{product}} is still available",
            channel: "reply",
          },
        ],
      },
      appDb,
    );
    const en = await enrollLead(
      ctx(tenantId),
      { sequenceId: seq.id, leadId: String(leadId) },
      appDb,
    );

    const first = await drainNurtureEnrollments({
      tenantId,
      base: appDb,
      now: new Date(Date.now() + 60_000),
    });
    expect(first.processed).toBe(1);

    let page = await listNurtureOutbox(ctx(tenantId), {}, appDb);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.status).toBe("PENDING");
    // {{name}}/{{platform}} rendered from the lead.
    expect(page.items[0]?.body).toBe("Hi Lan Anh, saw you on facebook");
    expect(page.items[0]?.leadAuthorName).toBe("Lan Anh");
    expect(page.items[0]?.sequenceName).toBe("Instant two-step");

    const afterFirst = await listNurtureEnrollments(ctx(tenantId), {}, appDb);
    const mid = afterFirst.items.find((e) => e.id === en.id);
    expect(mid?.stepIndex).toBe(1);
    expect(mid?.status).toBe("ACTIVE");

    const second = await drainNurtureEnrollments({
      tenantId,
      base: appDb,
      now: new Date(Date.now() + 120_000),
    });
    expect(second.processed).toBe(1);
    page = await listNurtureOutbox(ctx(tenantId), {}, appDb);
    expect(page.items).toHaveLength(2);
    // {{product}} rendered from the top product match.
    const secondRow = page.items.find((i) =>
      i.body.includes("still available"),
    );
    expect(secondRow?.body).toBe("Serum BHA 2% is still available");

    const done = (await listNurtureEnrollments(ctx(tenantId), {}, appDb)).items;
    expect(done.find((e) => e.id === en.id)?.status).toBe("DONE");
  });

  test("a paused sequence's due enrollment is skipped, resumed later", async () => {
    const seq = await createNurtureSequence(
      ctx(tenantId),
      {
        name: "Gate",
        steps: [{ delayMin: 0, bodyTemplate: "hi {{name}}", channel: "dm" }],
      },
      appDb,
    );
    const en = await enrollLead(
      ctx(tenantId),
      { sequenceId: seq.id, leadId: String(leadId) },
      appDb,
    );
    await updateNurtureSequence(
      ctx(tenantId),
      BigInt(seq.id),
      { active: false },
      appDb,
    );
    const skipped = await drainNurtureEnrollments({
      tenantId,
      base: appDb,
      now: new Date(Date.now() + 60_000),
    });
    expect(skipped.processed).toBe(0);

    await updateNurtureSequence(
      ctx(tenantId),
      BigInt(seq.id),
      { active: true },
      appDb,
    );
    const drained = await drainNurtureEnrollments({
      tenantId,
      base: appDb,
      now: new Date(Date.now() + 60_000),
    });
    expect(drained.processed).toBe(1);
    const row = (
      await listNurtureEnrollments(ctx(tenantId), {}, appDb)
    ).items.find((e) => e.id === en.id);
    expect(row?.status).toBe("DONE");
  });

  test("mark sent flips PENDING once; a second transition 409s", async () => {
    const page = await listNurtureOutbox(
      ctx(tenantId),
      { status: "PENDING" },
      appDb,
    );
    const item = page.items[0];
    expect(item).toBeDefined();
    if (!item) return;
    const sent = await markOutboxSent(ctx(tenantId), BigInt(item.id), appDb);
    expect(sent.status).toBe("SENT");
    expect(sent.sentAt).not.toBeNull();
    await expect(
      markOutboxSent(ctx(tenantId), BigInt(item.id), appDb),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      cancelOutboxItem(ctx(tenantId), BigInt(item.id), appDb),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test("cancel outbox + cancel enrollment leave CANCELLED", async () => {
    const seq = await createNurtureSequence(
      ctx(tenantId),
      {
        name: "Cancel rail",
        steps: [
          { delayMin: 0, bodyTemplate: "a", channel: "dm" },
          { delayMin: 0, bodyTemplate: "b", channel: "dm" },
        ],
      },
      appDb,
    );
    const en = await enrollLead(
      ctx(tenantId),
      { sequenceId: seq.id, leadId: String(leadId) },
      appDb,
    );
    await drainNurtureEnrollments({
      tenantId,
      base: appDb,
      now: new Date(Date.now() + 60_000),
    });
    const pending = (
      await listNurtureOutbox(ctx(tenantId), { status: "PENDING" }, appDb)
    ).items.find((i) => i.enrollmentId === en.id);
    expect(pending).toBeDefined();
    if (!pending) return;
    const cancelledRow = await cancelOutboxItem(
      ctx(tenantId),
      BigInt(pending.id),
      appDb,
    );
    expect(cancelledRow.status).toBe("CANCELLED");
    const cancelledEn = await cancelEnrollment(
      ctx(tenantId),
      BigInt(en.id),
      appDb,
    );
    expect(cancelledEn.status).toBe("CANCELLED");
  });

  test("the other tenant sees none of this tenant's nurture rows", async () => {
    const foreignOutbox = await listNurtureOutbox(
      ctx(otherTenantId),
      {},
      appDb,
    );
    expect(foreignOutbox.items).toHaveLength(0);
    const foreignEnrollments = await listNurtureEnrollments(
      ctx(otherTenantId),
      {},
      appDb,
    );
    expect(foreignEnrollments.items).toHaveLength(0);
    // And a foreign id is simply not found, not a leak.
    const mine = (await listNurtureOutbox(ctx(tenantId), {}, appDb)).items[0];
    expect(mine).toBeDefined();
    if (!mine) return;
    await expect(
      markOutboxSent(ctx(otherTenantId), BigInt(mine.id), appDb),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
