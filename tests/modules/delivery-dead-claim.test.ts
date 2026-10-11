import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  claimingProcessId,
  LEASE_TTL_MS,
  processLeaseId,
  releaseProcessLease,
  resetProcessLeaseForTest,
  startProcessLease,
} from "@/lib/process-lease";
import {
  drainInFlight,
  inFlightWork,
  resetShutdownForTest,
} from "@/lib/shutdown";
import {
  finish,
  runDeadClaimPass,
  sweepDeadClaims,
} from "@/modules/chatwoot/delivery-sweep";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { deliveryRecoveryDedupeKey } from "@/modules/chatwoot/recover-delivery";
import { recordAndProcessChatwootDelivery } from "@/modules/chatwoot/webhook";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";

// A delivery claimed by a process that died without draining is settled once that
// process's lease is gone, instead of after the stranded sweep's 30-minute window, and a claim whose
// process is alive is never touched. The rows are seeded in the state a death leaves (PROCESSING,
// claimed a few seconds ago), and the leases are written directly, which is what a live or a dead
// process looks like from another one.

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

const CHATWOOT_INBOX_ID = 1298;
const AGENT_BOT_ID = 12;
let tenantId = 0n;
let instanceId = 0n;
let seq = 0;
const leases: string[] = [];

async function lease(heartbeatAgoMs: number): Promise<string> {
  const id = randomUUID();
  leases.push(id);
  await suDb.$executeRaw`
    INSERT INTO process_leases (id, heartbeat_at)
    VALUES (${id}::uuid, now() - make_interval(secs => ${heartbeatAgoMs / 1000}))`;
  return id;
}

// A customer message whose processing was claimed `claimedAgoMs` ago by `claimedBy`.
async function claimed(
  claimedBy: string | null,
  over: {
    claimedAgoMs?: number;
    event?: string;
    inboundMessageId?: number | null;
  } = {},
): Promise<bigint> {
  seq += 1;
  const row = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      deliveryId: `dead-claim-${process.pid}-${seq}`,
      event: over.event ?? "message_created",
      status: "PROCESSING",
      receivedAt: new Date(Date.now() - 20_000),
      claimedAt: new Date(Date.now() - (over.claimedAgoMs ?? 10_000)),
      claimedBy,
      conversationId: 7000 + seq,
      inboundMessageId:
        over.inboundMessageId === undefined
          ? 90_000 + seq
          : over.inboundMessageId,
      routeObserved: false,
      routeAgentBotId: AGENT_BOT_ID,
    },
    select: { id: true },
  });
  return row.id;
}

const statusOf = async (id: bigint) =>
  (
    await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id },
      select: { status: true },
    })
  ).status;

const recoveryJobs = (id: bigint) =>
  suDb.schedulerJob.count({
    where: {
      tenantId,
      kind: "DELIVERY_RECOVERY",
      dedupeKey: deliveryRecoveryDedupeKey(id),
    },
  });

describe.skipIf(!dbUp)("deliveries claimed by a dead process", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "DC", slug: `dead-claim-${process.pid}` },
    });
    tenantId = t.id;
    instanceId = (
      await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 1298,
        baseUrl: "https://chat.dead-claim.example",
        adminToken: encryptJson("ADMIN"),
      })
    ).id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
      },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: AGENT_BOT_ID,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `dead-claim-route-${process.pid}`,
        name: "Atendente",
      },
    });
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: CHATWOOT_INBOX_ID,
        name: "Suporte",
        agentId: agent.id,
      },
    });
  });

  // Every test starts from no deliveries and no leases of this file: a pass reads every dead claim,
  // so a fixture left behind (or a lease of one that lapses later) would be settled by the next test.
  afterEach(async () => {
    await releaseProcessLease();
    resetProcessLeaseForTest();
    await suDb.$executeRawUnsafe(
      `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM chatwoot_webhook_deliveries WHERE tenant_id = ${tenantId}`,
    );
    await suDb.$executeRaw`DELETE FROM process_leases WHERE id = ANY(${leases}::uuid[])`;
  });

  afterAll(async () => {
    if (!dbUp) return;
    for (const table of [
      "execution_logs",
      "scheduler_jobs",
      "chatwoot_webhook_deliveries",
      "conversations",
      "contacts",
      "inboxes",
      "chatwoot_agent_bots",
      "agents",
      "chatwoot_instances",
      "chatwoot_deployments",
    ]) {
      await suDb
        .$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = ${tenantId}`)
        .catch(() => {});
    }
    await suDb.$executeRaw`DELETE FROM process_leases WHERE id = ANY(${leases}::uuid[])`;
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("a customer message whose claimer has no lease is DEAD with its recovery armed, ten seconds after the claim", async () => {
    // The bug: nothing but the 30-minute stranded sweep ever settled a PROCESSING row.
    const row = await claimed(randomUUID());
    await sweepDeadClaims({ base: appDb });
    expect(await statusOf(row)).toBe("DEAD");
    expect(await recoveryJobs(row)).toBe(1);
  });

  test("a claim whose lease lapsed is settled, and one renewed inside the lease is left PROCESSING", async () => {
    // The two sides of the lease's lifetime: a pass that ignored the renewal would take a live
    // process's delivery and arm a second answer beside its turn.
    const dead = await claimed(await lease(LEASE_TTL_MS + 5_000));
    const alive = await claimed(await lease(LEASE_TTL_MS - 5_000));
    await sweepDeadClaims({ base: appDb });
    expect(await statusOf(dead)).toBe("DEAD");
    expect(await statusOf(alive)).toBe("PROCESSING");
    expect(await recoveryJobs(alive)).toBe(0);
  });

  test("older live claims filling a pass's batch do not hide a dead one behind them", async () => {
    // A capped read that skipped live claims after reading them would return the same live rows
    // every pass and never reach the dead one.
    const live = await lease(0);
    await claimed(live, { claimedAgoMs: 600_000 });
    await claimed(live, { claimedAgoMs: 590_000 });
    const dead = await claimed(randomUUID(), { claimedAgoMs: 1_000 });
    await sweepDeadClaims({ base: appDb, batch: 2 });
    expect(await statusOf(dead)).toBe("DEAD");
  });

  test("this process's own claims are never taken, even with its lease lapsed", async () => {
    // Its own rows include the ones a live attempt left PROCESSING on purpose for the stranded sweep.
    const self = await lease(LEASE_TTL_MS * 3);
    const row = await claimed(self);
    await sweepDeadClaims({ base: appDb, self });
    expect(await statusOf(row)).toBe("PROCESSING");
  });

  test("a claim that names no process (an older build) keeps the stranded sweep's window", async () => {
    const row = await claimed(null);
    await sweepDeadClaims({ base: appDb });
    expect(await statusOf(row)).toBe("PROCESSING");
  });

  test("a dead claim stamped by a clock ahead of this one is still settled", async () => {
    // `claimedAt` comes from the dead process's host; a zero window reads a claim from its future as
    // one still in flight and leaves it until the clocks agree.
    const row = await claimed(randomUUID(), { claimedAgoMs: -5 * 60_000 });
    await sweepDeadClaims({ base: appDb });
    expect(await statusOf(row)).toBe("DEAD");
  });

  test("a status change claimed by a dead process is closed PROCESSED with no recovery", async () => {
    // The stranded sweep's verdict, earlier: no customer message, nothing for the DEAD worklist.
    const row = await claimed(randomUUID(), {
      event: "conversation_status_changed",
      inboundMessageId: null,
    });
    await sweepDeadClaims({ base: appDb });
    expect(await statusOf(row)).toBe("PROCESSED");
    expect(await recoveryJobs(row)).toBe(0);
  });

  test("two passes at once settle a dead claim once", async () => {
    const row = await claimed(randomUUID());
    const [a, b] = await Promise.all([
      sweepDeadClaims({ base: appDb }),
      sweepDeadClaims({ base: appDb }),
    ]);
    expect(await statusOf(row)).toBe("DEAD");
    expect(await recoveryJobs(row)).toBe(1);
    expect(a.lost + b.lost).toBe(1);
  });

  test("a row that leaves PROCESSING forgets its claimer, so an older build's claim from DEAD is not taken", async () => {
    // An older build's recovery claims DEAD -> PROCESSING without writing `claimed_by`; a dead claimer
    // left on the row would make the next pass end that live recovery.
    const row = await claimed(randomUUID());
    await sweepDeadClaims({ base: appDb });
    expect(await statusOf(row)).toBe("DEAD");
    await suDb.chatwootWebhookDelivery.update({
      where: { id: row },
      data: { status: "PROCESSING", claimedAt: new Date() },
    });
    await sweepDeadClaims({ base: appDb });
    expect(await statusOf(row)).toBe("PROCESSING");
  });

  test("the terminal write is guarded on the claim the pass judged dead", async () => {
    // Read as claimed by a dead process, then claimed again (a recovery from DEAD) before the write:
    // the write must miss rather than end the live attempt.
    const dead = randomUUID();
    const row = await claimed(randomUUID());
    const read = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: row },
      select: {
        id: true,
        status: true,
        chatwootInstanceId: true,
        deliveryId: true,
        event: true,
        receivedAt: true,
        claimedAt: true,
        conversationId: true,
        inboundMessageId: true,
        humanReplyShape: true,
        humanReplyMessageId: true,
        routeObserved: true,
        routeAgentBotId: true,
        routeRemembers: true,
      },
    });
    const won = await finish(
      { ...read, status: "PROCESSING", claimedBy: dead },
      tenantId,
      "DEAD",
      appDb,
    );
    expect(won).toBe(false);
    expect(await statusOf(row)).toBe("PROCESSING");
  });

  test("the terminal write misses an attempt claimed again by the same process", async () => {
    // A process whose lease lapsed for a moment can claim the row again from DEAD under the same id;
    // a pass that read the earlier attempt must not end the new one.
    const claimer = randomUUID();
    const row = await claimed(claimer);
    const read = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: row },
      select: {
        id: true,
        status: true,
        chatwootInstanceId: true,
        deliveryId: true,
        event: true,
        receivedAt: true,
        claimedAt: true,
        claimedBy: true,
        conversationId: true,
        inboundMessageId: true,
        humanReplyShape: true,
        humanReplyMessageId: true,
        routeObserved: true,
        routeAgentBotId: true,
        routeRemembers: true,
      },
    });
    await suDb.chatwootWebhookDelivery.update({
      where: { id: row },
      data: { claimedAt: new Date(), claimedBy: claimer },
    });
    const won = await finish(
      { ...read, status: "PROCESSING" },
      tenantId,
      "DEAD",
      appDb,
    );
    expect(won).toBe(false);
    expect(await statusOf(row)).toBe("PROCESSING");
  });

  test("a claim made while this process holds a lease names it, and one made without a lease names nobody", async () => {
    const deliver = async (messageId: number) => {
      const n = normalizeChatwootEvent({
        event: "message_created",
        id: messageId,
        private: false,
        content: "oi",
        message_type: "incoming",
        sender: { id: 77, name: "Cliente", type: null },
        conversation: {
          id: 8000 + messageId,
          inbox_id: CHATWOOT_INBOX_ID,
          // Held by a human: the delivery takes the gate's exit and spends no model call.
          status: "open",
          contact_inbox: { id: 61_000 + messageId },
          meta: {
            assignee_type: "User",
            assignee: { id: 5, name: "Ana" },
            sender: { id: 77, name: "Cliente" },
          },
          channel: "Channel::Api",
          last_activity_at: Math.floor(Date.now() / 1000),
          updated_at: Math.floor(Date.now() / 1000),
        },
      });
      if (!n) throw new Error("payload did not normalize");
      const deliveryId = `dead-claim-live-${process.pid}-${messageId}`;
      await recordAndProcessChatwootDelivery({
        tenantId,
        instanceId,
        deliveryId,
        agentBotId: AGENT_BOT_ID,
        normalized: n,
        base: appDb,
      });
      const seen = await suDb.$queryRawUnsafe<
        Array<{ claimed_by: string | null }>
      >(
        `SELECT claimed_by::text AS claimed_by FROM ${PROBE} WHERE delivery_id = $1`,
        deliveryId,
      );
      expect(seen).toHaveLength(1);
      return seen[0]?.claimed_by ?? null;
    };
    // The claim is read as it is written: the row is PROCESSED a moment later, which forgets the claimer.
    const PROBE = `dead_claim_probe_${process.pid}`;
    await suDb.$executeRawUnsafe(
      `CREATE TABLE ${PROBE} (delivery_id text, claimed_by uuid)`,
    );
    await suDb.$executeRawUnsafe(
      `CREATE FUNCTION ${PROBE}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO ${PROBE} VALUES (NEW.delivery_id, NEW.claimed_by); RETURN NEW; END $$`,
    );
    await suDb.$executeRawUnsafe(
      `CREATE TRIGGER ${PROBE} AFTER UPDATE ON chatwoot_webhook_deliveries FOR EACH ROW WHEN (OLD.status = 'PENDING' AND NEW.status = 'PROCESSING' AND NEW.tenant_id = ${tenantId}) EXECUTE FUNCTION ${PROBE}()`,
    );
    try {
      expect(await deliver(1)).toBeNull();
      await startProcessLease(appDb, 60_000);
      leases.push(processLeaseId());
      expect(await deliver(2)).toBe(processLeaseId());
    } finally {
      await suDb.$executeRawUnsafe(
        `DROP TRIGGER ${PROBE} ON chatwoot_webhook_deliveries`,
      );
      await suDb.$executeRawUnsafe(`DROP FUNCTION ${PROBE}()`);
      await suDb.$executeRawUnsafe(`DROP TABLE ${PROBE}`);
    }
  });

  test("a running pass holds the shutdown drain open, and a draining process starts none", async () => {
    // A pass the drain does not wait for can be cut between closing a row and arming what it owes.
    const row = await claimed(randomUUID());
    const pass = runDeadClaimPass(appDb);
    expect(inFlightWork().byKind["chatwoot-dead-claim-pass"]).toBe(1);
    await pass;
    expect(await statusOf(row)).toBe("DEAD");
    const later = await claimed(randomUUID());
    try {
      await drainInFlight({ boundMs: 0 });
      await runDeadClaimPass(appDb);
      expect(await statusOf(later)).toBe("PROCESSING");
    } finally {
      resetShutdownForTest();
    }
  });

  test("a renewal on the wire when the process exits does not write the lease back after its deletion", async () => {
    // The exit's deletion has to land last, or the lease outlives the process by a whole lifetime.
    const ops: string[] = [];
    let unblock = () => {};
    let renewing = () => {};
    const secondRenewal = new Promise<void>((r) => {
      renewing = r;
    });
    let inserts = 0;
    const fake = {
      $executeRaw: (sql: TemplateStringsArray) => {
        const text = sql.join("?");
        if (text.includes("INSERT")) {
          inserts += 1;
          if (inserts === 1) {
            ops.push("renew");
            return Promise.resolve(1);
          }
          renewing();
          return new Promise((resolve) => {
            unblock = () => {
              ops.push("renew");
              resolve(1);
            };
          });
        }
        ops.push("delete");
        return Promise.resolve(1);
      },
    } as unknown as PrismaClient;
    await startProcessLease(fake, 5);
    await secondRenewal;
    const released = releaseProcessLease(5_000);
    // The renewal answers only after the release has had its chance to delete.
    await Bun.sleep(1);
    unblock();
    await released;
    expect(ops.at(-1)).toBe("delete");
  });

  test("a process stops naming itself on claims once its renewals stop committing, and its lease leaves with it", async () => {
    await startProcessLease(appDb, 60_000);
    const id = processLeaseId();
    leases.push(id);
    expect(claimingProcessId()).toBe(id);
    // Half the lease without a committed renewal: another process may soon read this one as dead.
    expect(
      claimingProcessId(performance.now() + LEASE_TTL_MS / 2 + 1),
    ).toBeNull();
    await releaseProcessLease();
    expect(claimingProcessId()).toBeNull();
    const left = await suDb.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM process_leases WHERE id = ${id}::uuid`;
    expect(left[0]?.n).toBe(0);
  });
});
