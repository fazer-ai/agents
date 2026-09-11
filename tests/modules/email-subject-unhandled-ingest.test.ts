import { beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { seedChatwootInstance } from "../utils/chatwoot";

// Issue #598, the path the holdout scenario s10 named. Besides the turn and the debounce flush there
// is a THIRD place that builds what the agent reads: `ingestUnhandledMessage`, which folds into the
// contact's memory the message no turn ever covered — the one that arrived outside business hours,
// and the one a colleague had already taken. It drops whatever "renders to nothing", and an email
// whose whole request is its subject rendered to nothing.
//
// The customer who writes at 22:00 therefore disappeared from the thread, and in the morning the
// agent answered a conversation in which, as far as it could see, nobody had asked anything. Same
// defect as the issue, one path over, which is why the fix is not another field passed by hand: this
// call site now asks `incomingRenderable`, the ONE mapping from a normalized event to what the agent
// would read, so the next marker added to the renderer cannot reach two of the three readers.

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

const CHATWOOT_INBOX_ID = 4811;
const CONV_ID = 9841;
const AGENT_BOT_ID = 88;
const SUBJECT = "Perdi o acesso ao e-mail e ao telefone cadastrados";

let tenantId: bigint;
let instanceId: bigint;

// An inbound email on a conversation a HUMAN owns: `act` is false, so no turn will ever run on it
// and this fold is the only memory of it there will ever be.
function inboundEmail(
  messageId: number,
  opts: { content: string; subject?: string },
) {
  return normalizeChatwootEvent({
    event: "message_created",
    id: messageId,
    content: opts.content,
    message_type: "incoming",
    private: false,
    content_attributes: opts.subject
      ? { email: { subject: opts.subject, from: ["cliente@exemplo.com"] } }
      : {},
    conversation: {
      id: CONV_ID,
      inbox_id: CHATWOOT_INBOX_ID,
      status: "open",
      contact_inbox: { id: 70_000 + CONV_ID },
      meta: {
        assignee_type: "user",
        assignee: { id: 5, name: "Atendente humana" },
        sender: { id: 21, name: "Cliente" },
      },
      channel: "Channel::Email",
      last_activity_at: Math.floor(Date.now() / 1000),
    },
  });
}

async function deliver(n: NonNullable<ReturnType<typeof inboundEmail>>) {
  const row = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      deliveryId: `email-subject-${process.pid}-${crypto.randomUUID()}`,
      event: "message_created",
      status: "PENDING",
    },
    select: { id: true },
  });
  await processChatwootDelivery({
    tenantId,
    instanceId,
    deliveryRowId: row.id,
    agentBotId: AGENT_BOT_ID,
    normalized: n,
    base: appDb,
    deps: {
      sleep: async () => {},
      makeClient: (async () =>
        ({
          sendMessage: async () => ({}),
          sendPrivateNote: async () => ({}),
        }) as unknown as ChatwootClient) as never,
      makeModel: () => {
        throw new Error("a conversa é de um humano: nenhum turno pode rodar");
      },
    },
  });
}

const armedText = async (messageId: number) => {
  const row = await suDb.schedulerJob.findFirst({
    where: {
      tenantId,
      kind: "INGEST_MESSAGE",
      payload: { path: ["messageId"], equals: messageId },
    },
    select: { payloadSecret: true },
  });
  return row?.payloadSecret ? decryptJson<string>(row.payloadSecret) : null;
};

describe.skipIf(!dbUp)("the email nobody answered still reaches memory", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "Assunto", slug: `email-subject-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 4,
      baseUrl: "https://chat.assunto.example",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Gi",
        systemPrompt: "x",
        enabled: true,
        mode: "production",
        settings: {},
      },
      select: { id: true },
    });
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: CHATWOOT_INBOX_ID,
        name: "sac@",
        agentId: agent.id,
      },
    });
  });

  test("a body-less email is folded in as its subject, not dropped", async () => {
    const n = inboundEmail(6101, { content: "", subject: SUBJECT });
    if (!n) throw new Error("unreachable: the fixture is a valid event");

    await deliver(n);

    expect(await armedText(6101)).toBe(`<assunto>${SUBJECT}</assunto>`);
  });

  test("the text folded in is the text a turn would have read", async () => {
    // Item 2 of the scenario, and the reason this call site asks the shared mapping instead of
    // spelling the shape a third time: memory and the turn must not describe the same message
    // differently.
    const n = inboundEmail(6102, {
      content: "Enviado do meu iPhone",
      subject: SUBJECT,
    });
    if (!n) throw new Error("unreachable: the fixture is a valid event");

    await deliver(n);

    expect(await armedText(6102)).toBe(
      `<assunto>${SUBJECT}</assunto>\nEnviado do meu iPhone`,
    );
  });

  test("a message with nothing in it is still folded in as nothing", async () => {
    // The other side of the coin: coherence is not bought by turning every blank message into one.
    const n = inboundEmail(6103, { content: "" });
    if (!n) throw new Error("unreachable: the fixture is a valid event");

    await deliver(n);

    expect(await armedText(6103)).toBeNull();
  });
});
