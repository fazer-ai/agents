import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import { getKpis } from "@/modules/analytics/service";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { seedChatwootInstance } from "../utils/chatwoot";

// Chatwoot's first-response SLA, asked where it is WRITTEN FROM — the real receiver
// (`processChatwootDelivery`), not `mirrorChatwootEvent` called by hand.
//
// Every fixture here is a `message_created` or a `conversation_updated`, and that is the point:
// those are the events an Agent Bot actually receives. `AgentBotListener` never dispatches
// `conversation_created` to a bot, so a rule that needed one would pass under a fixture that builds
// it and report nothing in production. Nothing in this file constructs that event.
//
// The agent is `enabled: false` on purpose. It is the case the numbers exist for (an inbox the bot
// never touches still has a service level) and it proves the mirror does not come from the agent
// pipeline: nothing here can run a turn, ask a model, or write LlmUsage.
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

const CHATWOOT_INBOX_ID = 5511;
const AGENT_BOT_ID = 77;

// The SLA pair as Chatwoot spells it: `created_at` is rendered by the jbuilder partials as epoch
// seconds, `first_reply_created_at` is a plain attribute and serializes as an ISO-8601 string. Both
// spellings are exercised because both arrive.
function convPayload(
  convId: number,
  sla: { createdAt?: number; firstReplyAt?: Date | null } = {},
  overrides: Record<string, unknown> = {},
) {
  return {
    id: convId,
    inbox_id: CHATWOOT_INBOX_ID,
    status: "open",
    contact_inbox: { id: 70_000 + convId },
    meta: {
      assignee_type: "User",
      assignee: { id: 31, name: "Ana (atendente)" },
      sender: { id: 21, name: "Cliente" },
    },
    channel: "Channel::Api",
    last_activity_at: Math.floor(Date.now() / 1000),
    ...(sla.createdAt !== undefined ? { created_at: sla.createdAt } : {}),
    ...(sla.firstReplyAt !== undefined
      ? { first_reply_created_at: sla.firstReplyAt?.toISOString() ?? null }
      : {}),
    ...overrides,
  };
}

async function seedTenant(slug: string) {
  const t = await suDb.tenant.create({ data: { name: "Monitor", slug } });
  const inst = await seedChatwootInstance(suDb, {
    tenantId: t.id,
    accountId: 5,
    baseUrl: "https://chat.monitor.example",
    adminToken: encryptJson("ADMIN"),
  });
  // The monitoring premise: the platform is on, the AI is off.
  const agent = await suDb.agent.create({
    data: {
      tenantId: t.id,
      name: "Atendente",
      systemPrompt: "x",
      enabled: false,
      mode: "production",
      settings: {},
    },
    select: { id: true },
  });
  await suDb.inbox.create({
    data: {
      tenantId: t.id,
      chatwootInstanceId: inst.id,
      chatwootInboxId: CHATWOOT_INBOX_ID,
      name: "WhatsApp",
      agentId: agent.id,
    },
    select: { id: true },
  });
  return { tenantId: t.id, instanceId: inst.id };
}

async function dropTenant(tenantId: bigint | undefined) {
  if (!tenantId) return;
  for (const table of [
    "execution_logs",
    "llm_usage",
    "chatwoot_webhook_deliveries",
    "conversations",
    "contacts",
    "inboxes",
    "agents",
    "chatwoot_instances",
  ]) {
    await suDb.$executeRawUnsafe(
      `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
    );
  }
  await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
}

function makeDeliver(on: () => { tenantId: bigint; instanceId: bigint }) {
  return async (raw: Record<string, unknown>, tag: string) => {
    const n = normalizeChatwootEvent(raw);
    if (!n) throw new Error(`fixture did not normalize: ${tag}`);
    const target = on();
    const d = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId: target.tenantId,
        chatwootInstanceId: target.instanceId,
        deliveryId: `sla-probe-${process.pid}-${tag}`,
        event: String(raw.event),
        status: "PENDING",
      },
      select: { id: true },
    });
    return processChatwootDelivery({
      tenantId: target.tenantId,
      instanceId: target.instanceId,
      deliveryRowId: d.id,
      agentBotId: AGENT_BOT_ID,
      normalized: n,
      base: appDb,
      deps: {
        makeClient: (async () =>
          ({
            sendMessage: async () => {
              throw new Error("a disabled agent must not speak");
            },
            sendPrivateNote: async () => ({}),
            toggleTyping: async () => ({}),
          }) as unknown as ChatwootClient) as never,
        makeModel: () => {
          throw new Error("a disabled agent must not ask a model");
        },
      },
    });
  };
}

describe.skipIf(!dbUp)("the mirrored first-response SLA", () => {
  let tenantId: bigint;
  let instanceId: bigint;
  const deliver = makeDeliver(() => ({ tenantId, instanceId }));

  async function stored(convId: number) {
    return suDb.conversation.findFirst({
      where: { tenantId, chatwootConversationId: convId },
      select: { chatwootCreatedAt: true, chatwootFirstReplyAt: true },
    });
  }

  beforeAll(async () => {
    ({ tenantId, instanceId } = await seedTenant(`sla-mirror-${process.pid}`));
  });
  afterAll(async () => {
    await dropTenant(tenantId);
  });

  test("takes both readings off the payload, in the spellings Chatwoot sends", async () => {
    const convId = 9811;
    const createdAt = Math.floor(Date.now() / 1000) - 3_600;
    const firstReplyAt = new Date((createdAt + 22) * 1000 + 341);
    await deliver(
      {
        event: "message_created",
        id: convId * 10,
        content: "bom dia, posso ajudar?",
        message_type: "outgoing",
        private: false,
        sender: { id: 31, name: "Ana", type: "user" },
        conversation: convPayload(convId, { createdAt, firstReplyAt }),
      },
      `${convId}-reply`,
    );

    const row = await stored(convId);
    expect(row?.chatwootCreatedAt?.getTime()).toBe(createdAt * 1000);
    // The fraction survives: the ISO spelling carries milliseconds and the column is TIMESTAMP(3).
    expect(row?.chatwootFirstReplyAt?.getTime()).toBe(firstReplyAt.getTime());
  });

  // An epoch a Date cannot hold. `Number.isFinite` says yes and `> 0` says yes, so the only thing
  // standing between the payload and the column is whether the Date that comes out is a date at
  // all. It is not, and Prisma refuses an Invalid Date, which would fail the WHOLE delivery over
  // an optional field, and fail it again on every retry, because the payload never changes. The
  // mirror's own rule for a reading it cannot use is to keep what it stored, so that is what an
  // unreadable timestamp has to do too.
  test("an epoch no Date can hold is absent, and does not fail the delivery", async () => {
    const convId = 9815;
    await deliver(
      {
        event: "message_created",
        id: convId * 10,
        content: "oi",
        message_type: "incoming",
        private: false,
        conversation: convPayload(
          convId,
          {},
          {
            created_at: 1e20,
            first_reply_created_at: "99999999999999999999",
          },
        ),
      },
      `${convId}-unholdable`,
    );

    const row = await stored(convId);
    // The row exists: the delivery went through and mirrored everything else.
    expect(row === null).toBe(false);
    expect(row?.chatwootCreatedAt).toBeNull();
    expect(row?.chatwootFirstReplyAt).toBeNull();
  });

  // The third spelling asks the same question: text that is not a date at all. It reaches a
  // different branch from the two above (neither a number nor all digits), and the answer has to be
  // the same one, or the branch that happens to be exercised decides whether a delivery survives.
  test("text that is not a date is absent too", async () => {
    const convId = 9816;
    await deliver(
      {
        event: "conversation_updated",
        ...convPayload(
          convId,
          {},
          {
            created_at: "sometime last tuesday",
            first_reply_created_at: "n/a",
          },
        ),
      },
      `${convId}-unparseable`,
    );

    const row = await stored(convId);
    expect(row === null).toBe(false);
    expect(row?.chatwootCreatedAt).toBeNull();
    expect(row?.chatwootFirstReplyAt).toBeNull();
  });

  test("a conversation the mirror first meets mid-dialogue keeps the source's numbers", async () => {
    // No conversation_created is delivered here — an Agent Bot never gets one. The row is born from
    // a message that is NOT the conversation's first, and the readings it carries are still the
    // whole conversation's, because Chatwoot computed them from its messages table.
    const convId = 9812;
    const createdAt = Math.floor(Date.now() / 1000) - 86_400;
    const firstReplyAt = new Date((createdAt + 45) * 1000);
    await deliver(
      {
        event: "message_created",
        id: convId * 10 + 7,
        content: "e sobre a segunda peça?",
        message_type: "incoming",
        private: false,
        conversation: convPayload(convId, { createdAt, firstReplyAt }),
      },
      `${convId}-late-inbound`,
    );

    const row = await stored(convId);
    expect(row?.chatwootCreatedAt?.getTime()).toBe(createdAt * 1000);
    expect(row?.chatwootFirstReplyAt?.getTime()).toBe(firstReplyAt.getTime());
  });

  test("a delivery refused as stale still teaches the pair", async () => {
    const convId = 9813;
    const createdAt = Math.floor(Date.now() / 1000) - 7_200;
    const firstReplyAt = new Date((createdAt + 12) * 1000);
    // The newer event lands first and carries no SLA fields (a status change on an old Chatwoot,
    // or a payload degraded to no conversation body).
    await deliver(
      {
        event: "conversation_updated",
        ...convPayload(convId, {}, { last_activity_at: createdAt + 900 }),
      },
      `${convId}-newer`,
    );
    expect((await stored(convId))?.chatwootFirstReplyAt).toBeNull();

    // Then the older one, which `decideConversationWrites` refuses for the STATE it carries. The
    // readings are not state this side maintains, so they are recorded anyway.
    await deliver(
      {
        event: "message_created",
        id: convId * 10,
        content: "já respondo",
        message_type: "outgoing",
        private: false,
        sender: { id: 31, name: "Ana", type: "user" },
        conversation: convPayload(
          convId,
          { createdAt, firstReplyAt },
          { last_activity_at: createdAt + 12 },
        ),
      },
      `${convId}-older`,
    );

    const row = await stored(convId);
    expect(row?.chatwootCreatedAt?.getTime()).toBe(createdAt * 1000);
    expect(row?.chatwootFirstReplyAt?.getTime()).toBe(firstReplyAt.getTime());
  });

  test("a payload that says nothing about the SLA does not wipe it", async () => {
    const convId = 9814;
    const createdAt = Math.floor(Date.now() / 1000) - 1_800;
    const firstReplyAt = new Date((createdAt + 30) * 1000);
    await deliver(
      {
        event: "message_created",
        id: convId * 10,
        content: "oi",
        message_type: "outgoing",
        private: false,
        sender: { id: 31, name: "Ana", type: "user" },
        conversation: convPayload(convId, { createdAt, firstReplyAt }),
      },
      `${convId}-reply`,
    );
    await deliver(
      {
        event: "conversation_updated",
        ...convPayload(
          convId,
          { createdAt, firstReplyAt: null },
          { last_activity_at: createdAt + 3_000, status: "resolved" },
        ),
      },
      `${convId}-cleared`,
    );

    expect((await stored(convId))?.chatwootFirstReplyAt?.getTime()).toBe(
      firstReplyAt.getTime(),
    );
  });
});

describe.skipIf(!dbUp)("the first-response KPI", () => {
  let tenantId: bigint;
  let instanceId: bigint;
  const deliver = makeDeliver(() => ({ tenantId, instanceId }));

  // One attendance, delivered the way production delivers it: a message event carrying the pair.
  async function attendance(
    convId: number,
    createdAt: number,
    answeredAfter: number | null,
  ) {
    await deliver(
      {
        event: "message_created",
        id: convId * 10,
        content: "ok",
        message_type: answeredAfter === null ? "incoming" : "outgoing",
        private: false,
        ...(answeredAfter === null
          ? {}
          : { sender: { id: 31, name: "Ana", type: "user" } }),
        conversation: convPayload(convId, {
          createdAt,
          firstReplyAt:
            answeredAfter === null
              ? null
              : new Date((createdAt + answeredAfter) * 1000),
        }),
      },
      `agg-${convId}`,
    );
  }

  // The sample both tests below read, seeded in setup rather than by the first of them. A test that
  // inherits its fixtures from the test above it passes only in file order: run this one by name and
  // the sample is empty, so the assertions fail while the service is behaving correctly.
  //
  // 10s, 60s and one conversation opened at the end of a Friday: the mean of the three is 20 minutes
  // and describes none of them, which is the whole argument for the median.
  beforeAll(async () => {
    ({ tenantId, instanceId } = await seedTenant(`sla-kpi-${process.pid}`));
    const base = Math.floor(Date.now() / 1000) - 86_400;
    await attendance(9901, base, 10);
    await attendance(9902, base, 60);
    await attendance(9903, base, 3_600);
    // Nobody has answered this one yet: it has no response time, and must not be counted as zero.
    await attendance(9904, base, null);
  });
  afterAll(async () => {
    await dropTenant(tenantId);
  });

  test("reports the median attendance and the size of its sample", async () => {
    const kpis = await getKpis(
      { tenantId, userId: null, role: "TENANT_ADMIN" } satisfies TenantContext,
      {},
      appDb,
    );
    expect(kpis.firstResponseSampled).toBe(3);
    expect(kpis.firstResponseSeconds).toBe(60);
    // The premise: four conversations served entirely by humans, and the KPI answers anyway.
    expect(kpis.totalConversations).toBe(4);
    expect(kpis.involved).toBe(0);
  });

  test("refuses a reply dated before the conversation that carries it", async () => {
    const base = Math.floor(Date.now() / 1000) - 86_400;
    await attendance(9905, base, -30);

    const kpis = await getKpis(
      { tenantId, userId: null, role: "TENANT_ADMIN" } satisfies TenantContext,
      {},
      appDb,
    );
    // Still three: the skewed row is dropped rather than contributing a negative duration.
    expect(kpis.firstResponseSampled).toBe(3);
    expect(kpis.firstResponseSeconds).toBe(60);
  });
});
