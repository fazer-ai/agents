import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  createOutreachAccount,
  listOutreachAccounts,
  updateOutreachAccount,
} from "@/modules/outreach/accounts";
import {
  approveOutreachJob,
  cancelOutreachJob,
  listOutreachJobs,
  markOutreachJobSent,
  queueOutreachJob,
  requeueOutreachJob,
} from "@/modules/outreach/jobs";
import {
  claimDueOutreachJobs,
  deliverOutreachJob,
} from "@/modules/outreach/send";
import { processOutreachBatch } from "@/modules/outreach/worker";

// "Grey rails" outreach: the whole suite is about the SAFETY invariants the module
// exists to hold - the feature flag refuses every surface while off, the worker can
// never send a QUEUED job (approval is the only door), the account's
// dailyCap/cooldownMin bound the send rate atomically, the (tenant, lead, account,
// kind) unique key dedupes, and a manual send is only ever CONFIRMED by the operator.
// DB-backed tests run on the app-role client under real RLS and skip when no test
// database is up; the describe toggles config.outreach.enabled for its run only.

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

const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});
const otherCtx = (): TenantContext => ({
  tenantId: otherTenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

function makeLead(text: string) {
  return suDb.lead.create({
    data: {
      tenantId,
      platform: "facebook",
      authorName: "Lead Author",
      authorHandle: "lead.handle",
      text,
      sourceUrl: "https://facebook.com/post/1",
    },
    select: { id: true, status: true },
  });
}

async function makeAccount(
  input: Partial<Parameters<typeof createOutreachAccount>[1]> = {},
) {
  return createOutreachAccount(
    ctx(),
    {
      platform: "zalo",
      handle: `acct-${Math.random().toString(36).slice(2, 10)}`,
      ...input,
    },
    appDb,
  );
}

// One approved, due job on the account+lead pair, through the public surface
// (queue then approve) so the path to "sendable" is the real one.
async function approvedJob(
  accountId: string,
  leadId: bigint,
  kind: "GROUP_COMMENT" | "FRIEND_REQUEST" | "DM" = "DM",
) {
  const queued = await queueOutreachJob(
    ctx(),
    {
      accountId,
      leadId: String(leadId),
      kind,
      body: "Xin chào, bên mình có sản phẩm phù hợp",
    },
    appDb,
  );
  expect(queued.status).toBe("QUEUED");
  const approved = await approveOutreachJob(ctx(), BigInt(queued.id), appDb);
  expect(approved.status).toBe("APPROVED");
  return approved;
}

// The real claim the worker runs, narrowed to the one job the test armed.
async function claimOne(jobId: string) {
  const claimed = await claimDueOutreachJobs(appDb, 100, tenantId);
  const ours = claimed.find((j) => j.id === BigInt(jobId));
  if (!ours) {
    throw new Error(`job ${jobId} was not claimed`);
  }
  return ours;
}

async function jobRow(id: string) {
  const row = await suDb.outreachJob.findUnique({ where: { id: BigInt(id) } });
  expect(row).not.toBeNull();
  return row as NonNullable<typeof row>;
}

async function accountRow(id: string) {
  const row = await suDb.outreachAccount.findUnique({
    where: { id: BigInt(id) },
  });
  expect(row).not.toBeNull();
  return row as NonNullable<typeof row>;
}

const leadStatus = async (id: bigint) =>
  (await suDb.lead.findUnique({ where: { id }, select: { status: true } }))
    ?.status;

const okFetch = (async () =>
  new Response('{"ok":true}', {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

const failingFetch = (async () =>
  new Response("bridge down", { status: 503 })) as unknown as typeof fetch;

// ── the flag gate (no DB needed: the refusal happens before any query) ─────

describe("outreach flag gate", () => {
  const flagCtx: TenantContext = {
    tenantId: 1n,
    userId: null,
    role: "TENANT_ADMIN",
  };

  test("every service refuses 403 while OUTREACH_ENABLED is off", async () => {
    const was = config.outreach.enabled;
    config.outreach.enabled = false;
    try {
      await expect(
        listOutreachAccounts(flagCtx, {} as PrismaClient),
      ).rejects.toMatchObject({
        statusCode: 403,
        translationKey: "errors.outreachDisabled",
      });
      await expect(
        createOutreachAccount(
          flagCtx,
          { platform: "zalo", handle: "x" },
          {} as PrismaClient,
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        queueOutreachJob(
          flagCtx,
          { accountId: "1", leadId: "1", kind: "DM", body: "hi" },
          {} as PrismaClient,
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        approveOutreachJob(flagCtx, 1n, {} as PrismaClient),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        markOutreachJobSent(flagCtx, 1n, {} as PrismaClient),
      ).rejects.toBeInstanceOf(ForbiddenError);
    } finally {
      config.outreach.enabled = was;
    }
  });

  test("processOutreachBatch no-ops while disabled (an imported call cannot send)", async () => {
    const was = config.outreach.enabled;
    config.outreach.enabled = false;
    try {
      const summary = await processOutreachBatch({ base: {} as PrismaClient });
      expect(summary).toEqual({
        reaped: 0,
        claimed: 0,
        sent: 0,
        readyForManual: 0,
        deferred: 0,
        retried: 0,
        failed: 0,
      });
    } finally {
      config.outreach.enabled = was;
    }
  });
});

// ── DB-backed invariants ───────────────────────────────────────────────────

describe.skipIf(!dbUp)("outreach safety invariants", () => {
  let wasEnabled = false;
  beforeAll(async () => {
    if (!su) return;
    wasEnabled = config.outreach.enabled;
    config.outreach.enabled = true;
    const t = await su.tenant.create({
      data: { name: "Outreach", slug: `outreach-${process.pid}` },
    });
    tenantId = t.id;
    const other = await su.tenant.create({
      data: { name: "OutreachOther", slug: `outreachother-${process.pid}` },
    });
    otherTenantId = other.id;
  });

  afterAll(async () => {
    config.outreach.enabled = wasEnabled;
    if (su && tenantId) {
      for (const tid of [tenantId, otherTenantId]) {
        if (!tid) continue;
        for (const table of [
          "outreach_jobs",
          "outreach_accounts",
          "leads",
          "audit_logs",
        ]) {
          await su.$executeRawUnsafe(
            `DELETE FROM ${table} WHERE tenant_id = ${tid}`,
          );
        }
        await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
      }
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("an account is created ACTIVE with a zeroed counter; the (tenant,platform,handle) key dedupes", async () => {
    const account = await makeAccount({ handle: "dup-check" });
    expect(account.status).toBe("ACTIVE");
    expect(account.transport).toBe("manual");
    expect(account.dailyCap).toBe(20);
    expect(account.sentToday).toBe(0);

    await expect(makeAccount({ handle: "dup-check" })).rejects.toBeInstanceOf(
      ConflictError,
    );

    // The same handle under another tenant is a different account entirely.
    const foreign = await createOutreachAccount(
      otherCtx(),
      { platform: "zalo", handle: "dup-check" },
      appDb,
    );
    expect(foreign.id).not.toBe(account.id);

    // And neither tenant reads the other's rows through the service.
    const ours = await listOutreachAccounts(ctx(), appDb);
    const theirs = await listOutreachAccounts(otherCtx(), appDb);
    expect(ours.every((a) => a.id !== foreign.id)).toBe(true);
    expect(theirs.every((a) => a.id !== account.id)).toBe(true);
  });

  test("the worker never sends QUEUED: only an operator approval makes a job claimable", async () => {
    const account = await makeAccount();
    const lead = await makeLead("queued job must stay put");
    const job = await queueOutreachJob(
      ctx(),
      {
        accountId: account.id,
        leadId: String(lead.id),
        kind: "DM",
        body: "hello",
      },
      appDb,
    );
    expect(job.status).toBe("QUEUED");

    const summary = await processOutreachBatch({
      base: appDb,
      tenantId,
      fetchImpl: okFetch,
    });
    expect(summary.claimed).toBe(0);
    expect((await jobRow(job.id)).status).toBe("QUEUED");

    // Approval is the door: now the claim picks it up (manual transport lands
    // READY_FOR_MANUAL rather than SENT - nothing is on the wire).
    await approveOutreachJob(ctx(), BigInt(job.id), appDb);
    const second = await processOutreachBatch({ base: appDb, tenantId });
    expect(second.claimed).toBe(1);
    expect(second.readyForManual).toBe(1);
    expect((await jobRow(job.id)).status).toBe("READY_FOR_MANUAL");
    // The slot was spent the moment the send was handed to a human.
    expect((await accountRow(account.id)).sentToday).toBe(1);
  });

  test("the (tenant, lead, account, kind) unique key answers a replay with 409", async () => {
    const account = await makeAccount();
    const lead = await makeLead("dedupe key");
    await queueOutreachJob(
      ctx(),
      {
        accountId: account.id,
        leadId: String(lead.id),
        kind: "GROUP_COMMENT",
        body: "comment",
      },
      appDb,
    );
    await expect(
      queueOutreachJob(
        ctx(),
        {
          accountId: account.id,
          leadId: String(lead.id),
          kind: "GROUP_COMMENT",
          body: "again",
        },
        appDb,
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      translationKey: "errors.outreachJobDuplicate",
    });

    // A different kind on the same lead, and the same kind from another
    // account, are distinct touches and both queue.
    const otherAccount = await makeAccount();
    const dm = await queueOutreachJob(
      ctx(),
      {
        accountId: account.id,
        leadId: String(lead.id),
        kind: "DM",
        body: "dm",
      },
      appDb,
    );
    const crossAccount = await queueOutreachJob(
      ctx(),
      {
        accountId: otherAccount.id,
        leadId: String(lead.id),
        kind: "GROUP_COMMENT",
        body: "from elsewhere",
      },
      appDb,
    );
    expect(dm.status).toBe("QUEUED");
    expect(crossAccount.status).toBe("QUEUED");
  });

  test("queueing refuses once sentToday + pending reaches dailyCap", async () => {
    const account = await makeAccount({ dailyCap: 2 });
    const l1 = await makeLead("cap 1");
    const l2 = await makeLead("cap 2");
    const l3 = await makeLead("cap 3");
    await queueOutreachJob(
      ctx(),
      { accountId: account.id, leadId: String(l1.id), kind: "DM", body: "a" },
      appDb,
    );
    await queueOutreachJob(
      ctx(),
      { accountId: account.id, leadId: String(l2.id), kind: "DM", body: "b" },
      appDb,
    );
    // 0 sent today + 2 pending >= cap 2: the third job is refused at write time.
    await expect(
      queueOutreachJob(
        ctx(),
        {
          accountId: account.id,
          leadId: String(l3.id),
          kind: "DM",
          body: "c",
        },
        appDb,
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      translationKey: "errors.outreachDailyCap",
    });
  });

  test("a spent dailyCap defers the claim instead of sending past it", async () => {
    const account = await makeAccount({ dailyCap: 1 });
    const lead = await makeLead("cap spent");
    const job = await approvedJob(account.id, lead.id);

    // Burn the day's slot directly: as if the account already sent once.
    await suDb.$executeRawUnsafe(
      `UPDATE outreach_accounts SET sent_today = 1, sent_today_date = CURRENT_DATE WHERE id = ${account.id}`,
    );

    const claimed = await claimOne(job.id);
    const outcome = await deliverOutreachJob(appDb, claimed, {
      fetchImpl: okFetch,
    });
    expect(outcome).toBe("deferred");

    // Back to APPROVED, rescheduled to the next UTC day boundary, and the
    // counter was not touched a second time.
    const row = await jobRow(job.id);
    expect(row.status).toBe("APPROVED");
    expect(row.scheduledAt.getTime()).toBeGreaterThan(Date.now());
    expect((await accountRow(account.id)).sentToday).toBe(1);
  });

  test("cooldownMin holds a second send until the gap has passed", async () => {
    const account = await makeAccount({ cooldownMin: 60 });
    const lead = await makeLead("cooldown");
    const job = await approvedJob(account.id, lead.id);

    // The account touched someone a minute ago. last_sent_at is stored as the UTC
    // wall (the slot UPDATE writes now() AT TIME ZONE 'UTC'), so the backdate writes
    // the same wall - plain now() lands the session zone's wall on a non-UTC machine.
    await suDb.$executeRawUnsafe(
      `UPDATE outreach_accounts SET last_sent_at = (now() - interval '1 minute') AT TIME ZONE 'UTC' WHERE id = ${account.id}`,
    );

    const claimed = await claimOne(job.id);
    const outcome = await deliverOutreachJob(appDb, claimed, {
      fetchImpl: okFetch,
      now: new Date(),
    });
    expect(outcome).toBe("deferred");
    const row = await jobRow(job.id);
    expect(row.status).toBe("APPROVED");
    // Rescheduled to roughly lastSent + 60min, not retried immediately.
    const acct = await accountRow(account.id);
    expect(row.scheduledAt.getTime()).toBeGreaterThan(
      (acct.lastSentAt as Date).getTime() + 50 * 60_000,
    );
  });

  test("a PAUSED account's approved jobs are never claimed; resuming releases them", async () => {
    const account = await makeAccount();
    const lead = await makeLead("paused account");
    const job = await approvedJob(account.id, lead.id);

    await updateOutreachAccount(
      ctx(),
      BigInt(account.id),
      { status: "PAUSED" },
      appDb,
    );
    const summary = await processOutreachBatch({ base: appDb, tenantId });
    expect(summary.claimed).toBe(0);
    expect((await jobRow(job.id)).status).toBe("APPROVED");

    await updateOutreachAccount(
      ctx(),
      BigInt(account.id),
      { status: "ACTIVE" },
      appDb,
    );
    const claimed = await claimOne(job.id);
    // Deliver it to a terminal-ish state so the row does not linger in SENDING.
    const outcome = await deliverOutreachJob(appDb, claimed, {
      fetchImpl: okFetch,
    });
    expect(outcome).toBe("ready_for_manual");
  });

  test("a BANNED account cannot take new jobs", async () => {
    const account = await makeAccount();
    const lead = await makeLead("banned account");
    await updateOutreachAccount(
      ctx(),
      BigInt(account.id),
      { status: "BANNED" },
      appDb,
    );
    await expect(
      queueOutreachJob(
        ctx(),
        {
          accountId: account.id,
          leadId: String(lead.id),
          kind: "DM",
          body: "x",
        },
        appDb,
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      translationKey: "errors.outreachAccountBanned",
    });
  });

  test("manual transport: READY_FOR_MANUAL -> operator mark-sent -> SENT, lead CONTACTED", async () => {
    const account = await makeAccount({ transport: "manual" });
    const lead = await makeLead("manual send");
    const job = await approvedJob(account.id, lead.id);

    const claimed = await claimOne(job.id);
    const outcome = await deliverOutreachJob(appDb, claimed, {
      fetchImpl: okFetch,
    });
    expect(outcome).toBe("ready_for_manual");
    expect((await jobRow(job.id)).status).toBe("READY_FOR_MANUAL");
    // The slot stays consumed: the send is owed even before the confirmation.
    expect((await accountRow(account.id)).sentToday).toBe(1);
    // Nothing about the lead has been claimed yet.
    expect(await leadStatus(lead.id)).toBe("NEW");

    // Only READY_FOR_MANUAL may be marked: a premature confirm is a 409.
    const other = await queueOutreachJob(
      ctx(),
      {
        accountId: account.id,
        leadId: String((await makeLead("not ready")).id),
        kind: "FRIEND_REQUEST",
        body: "later",
      },
      appDb,
    );
    await expect(
      markOutreachJobSent(ctx(), BigInt(other.id), appDb),
    ).rejects.toBeInstanceOf(ConflictError);

    const sent = await markOutreachJobSent(ctx(), BigInt(job.id), appDb);
    expect(sent.status).toBe("SENT");
    expect(sent.sentAt).not.toBeNull();
    expect(await leadStatus(lead.id)).toBe("CONTACTED");
    const audit = await suDb.auditLog.findMany({
      where: { tenantId, action: "outreach.sent" },
    });
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  test("zca_bridge success sends, stamps SENT and moves the lead to CONTACTED", async () => {
    const account = await makeAccount({ transport: "zca_bridge" });
    const lead = await makeLead("zca ok");
    const job = await approvedJob(account.id, lead.id);

    const calls: string[] = [];
    const spyFetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;

    const claimed = await claimOne(job.id);
    const outcome = await deliverOutreachJob(appDb, claimed, {
      fetchImpl: spyFetch,
    });
    expect(outcome).toBe("sent");
    expect(calls[0]).toContain("/send");
    const row = await jobRow(job.id);
    expect(row.status).toBe("SENT");
    expect(row.sentAt).not.toBeNull();
    expect(await leadStatus(lead.id)).toBe("CONTACTED");
  });

  test("a zca_bridge error retries under the attempt budget, then fails terminally", async () => {
    const account = await makeAccount({ transport: "zca_bridge" });
    const lead = await makeLead("zca fail");
    const job = await approvedJob(account.id, lead.id);

    const claimed = await claimOne(job.id);
    const first = await deliverOutreachJob(appDb, claimed, {
      fetchImpl: failingFetch,
    });
    expect(first).toBe("retried");
    let row = await jobRow(job.id);
    // Retryable: back to APPROVED with the error recorded and the slot released.
    expect(row.status).toBe("APPROVED");
    expect(row.attempts).toBe(1);
    expect(row.error).toContain("503");
    expect(row.scheduledAt.getTime()).toBeGreaterThan(Date.now());
    expect((await accountRow(account.id)).sentToday).toBe(0);
    expect(await leadStatus(lead.id)).toBe("NEW");

    // At the attempt budget the job is FAILED terminal (requeue is a human call).
    // The retry only runs after its backoff, so the account's cooldown (which a
    // failed attempt still pays - last_sent_at stays) has long elapsed by then;
    // the test moves it back the way a real retry finds it.
    await suDb.$executeRawUnsafe(
      `UPDATE outreach_accounts SET last_sent_at = (now() - interval '1 hour') AT TIME ZONE 'UTC' WHERE id = ${account.id}`,
    );
    const last = await deliverOutreachJob(
      appDb,
      { ...claimed, attempts: 2 },
      { fetchImpl: failingFetch },
    );
    expect(last).toBe("failed");
    row = await jobRow(job.id);
    expect(row.status).toBe("FAILED");
    expect(row.attempts).toBe(3);

    // The operator's road back: requeue lands QUEUED and the worker cannot
    // touch it until a fresh approval.
    const requeued = await requeueOutreachJob(ctx(), BigInt(job.id), appDb);
    expect(requeued.status).toBe("QUEUED");
    await processOutreachBatch({ base: appDb, tenantId, fetchImpl: okFetch });
    expect((await jobRow(job.id)).status).toBe("QUEUED");
  });

  test("cancel works from QUEUED and a cancelled job cannot be approved", async () => {
    const account = await makeAccount();
    const lead = await makeLead("cancel me");
    const job = await queueOutreachJob(
      ctx(),
      {
        accountId: account.id,
        leadId: String(lead.id),
        kind: "DM",
        body: "cancel",
      },
      appDb,
    );
    const cancelled = await cancelOutreachJob(ctx(), BigInt(job.id), appDb);
    expect(cancelled.status).toBe("CANCELLED");
    await expect(
      approveOutreachJob(ctx(), BigInt(job.id), appDb),
    ).rejects.toBeInstanceOf(ConflictError);

    // A queue against a lead that is not the tenant's answers 404.
    await expect(
      queueOutreachJob(
        ctx(),
        {
          accountId: account.id,
          leadId: "999999999",
          kind: "DM",
          body: "ghost",
        },
        appDb,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("the other tenant cannot reach a job even naming its id", async () => {
    const account = await makeAccount();
    const lead = await makeLead("isolation");
    const job = await queueOutreachJob(
      ctx(),
      {
        accountId: account.id,
        leadId: String(lead.id),
        kind: "DM",
        body: "iso",
      },
      appDb,
    );
    await expect(
      approveOutreachJob(otherCtx(), BigInt(job.id), appDb),
    ).rejects.toBeInstanceOf(NotFoundError);
    const theirs = await listOutreachJobs(otherCtx(), {}, appDb);
    expect(theirs.items.every((j) => j.id !== job.id)).toBe(true);
  });
});
