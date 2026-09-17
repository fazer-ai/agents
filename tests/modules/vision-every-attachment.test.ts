import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogCount } from "../utils/flowlog";

// ISSUE #691: THE EAGER VISION PASS READ ONE ATTACHMENT AND THE OTHERS WERE NEVER OPENED.
//
// `firstVisualAttachment` did what its name said, so a customer who attaches the receipt, the ID
// and a screenshot in one e-mail had one of the three described, and the reply asked for what was
// in the other two. On the mailbox this was measured against, 50.6% of the conversations that
// arrive with an attachment carry more than one, so it was half the traffic — and NOTHING reported
// it: the flow log wrote one `vision` line per turn with `status: ok`, because from the pipeline's
// point of view nothing had been skipped.
//
// Asked where it is CONSUMED, not where it is defined: the fixture drives the real receiver
// (`processChatwootDelivery`), so counting lines measures the call site. A unit test on
// `visualAttachments` would pass with the webhook still taking `[0]`.
//
// Deterministic and offline by construction, exactly like `eager-media-flow-context.test.ts`: the
// agent's vision is enabled with NO credentialRef, so the service takes its `no_credential` skip —
// which emits the stage line — before it loads a Chatwoot client or reaches a provider. ONE LINE
// PER ATTEMPT is what makes the count the measurement. And debounce is on, so the delivery arms
// a job instead of running a turn: the eager pass runs ahead of that gate, and no model is asked for.
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

const CHATWOOT_INBOX_ID = 4711;
const CONV_ID = 9911;
const AGENT_BOT_ID = 79;

let tenantId: bigint;
let instanceId: bigint;
let inboxDbId: bigint;

function anexo(id: number, nome: string) {
  return {
    id,
    file_type: "image",
    data_url: `https://chat.multi.example/blobs/${nome}`,
  };
}

// A client that refuses the one call this path must never reach: with no credential the service
// skips before it would download anything.
const clienteQueRecusa = (async () =>
  ({
    downloadAttachment: async () => {
      throw new Error("the file must not be downloaded: no credential");
    },
    sendMessage: async () => ({}),
    sendPrivateNote: async () => ({}),
  }) as unknown as ChatwootClient) as never;

describe.skipIf(!dbUp)("the eager vision pass", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "Multi", slug: `multi-anexo-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 7,
      baseUrl: "https://chat.multi.example",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "x",
        enabled: true,
        mode: "production",
        // No credentialRef: the vision service skips on it, and the skip is what emits the line.
        settings: {
          vision: { enabled: true, provider: "openai" },
          // Debounce ON so the delivery arms a job instead of running a turn: the eager pass runs
          // ahead of the gate for a production agent, and the answer is not the subject here.
          debounce: { enabled: true },
        },
      },
      select: { id: true },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: CHATWOOT_INBOX_ID,
        name: "E-mail",
        agentId: agent.id,
      },
      select: { id: true },
    });
    inboxDbId = inbox.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "execution_logs",
        "scheduler_jobs",
        "chatwoot_webhook_deliveries",
        "conversations",
        "inboxes",
        "agents",
        "chatwoot_instances",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  // Each case gets its own conversation: two cases sharing one would let a line written by the
  // first be counted by the second, which is the whole measurement here.
  async function entregar(convId: number, anexos: ReturnType<typeof anexo>[]) {
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: inboxDbId,
        chatwootConversationId: convId,
        status: "pending",
        threadId: `${tenantId}:${instanceId}:${convId}`,
        lastEventAt: new Date(Date.now() - 60_000),
      },
      select: { id: true },
    });
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: 6000 + convId,
      content: "",
      message_type: "incoming",
      private: false,
      attachments: anexos,
      conversation: {
        id: convId,
        inbox_id: CHATWOOT_INBOX_ID,
        status: "pending",
        contact_inbox: { id: 70_000 + convId },
        meta: {
          assignee_type: null,
          assignee: null,
          sender: { id: 31, name: "Cliente" },
        },
        channel: "Channel::Email",
        last_activity_at: Math.floor(Date.now() / 1000),
      },
    });
    if (!n) throw new Error("unreachable: the fixture is a valid event");
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `multi-anexo-${process.pid}-${convId}`,
        event: "message_created",
        status: "PENDING",
      },
      select: { id: true },
    });
    await processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: delivery.id,
      agentBotId: AGENT_BOT_ID,
      normalized: n,
      base: appDb,
      deps: {
        makeClient: clienteQueRecusa,
        makeModel: () => {
          throw new Error(
            "debounce is on: this delivery must arm a job, not a turn",
          );
        },
      },
    });
    return n;
  }

  async function linhasDeVisao(convId: number): Promise<number> {
    return await flowLogCount(suDb, {
      where: {
        tenantId,
        threadId: `${tenantId}:${instanceId}:${convId}`,
        stage: "vision",
      },
    });
  }

  // Measured as a RATIO against the one-attachment message, never as an absolute count: the eager
  // pass has more than one call site per delivery (it runs ahead of the gate and again after it,
  // idempotent on a text already stashed — and nothing is stashed when the service skips). How many
  // times the pass runs is not what this issue is about; how many attachments each pass opens is.
  test("every attachment is analyzed, not only the first", async () => {
    await clearFlowLog(suDb, { tenantId });
    await entregar(CONV_ID + 9, [anexo(401, "unico.png")]);
    const umSo = await linhasDeVisao(CONV_ID + 9);
    expect(umSo).toBeGreaterThan(0);

    await entregar(CONV_ID, [
      anexo(101, "pedido.png"),
      anexo(102, "comprovante.jpg"),
      anexo(103, "documento.png"),
    ]);
    // Three files, three times the work. Before the fix this was `umSo`, whatever N was.
    expect(await linhasDeVisao(CONV_ID)).toBe(3 * umSo);
  });

  // The album. The cap is the point here, and so is saying so: a model told nothing answers as if
  // the message had those files fewer, which is the failure this issue is about.
  test("beyond the cap, the overflow is named to the model instead of dropped", async () => {
    await clearFlowLog(suDb, { tenantId });
    const muitos = Array.from({ length: 11 }, (_, i) =>
      anexo(200 + i, `foto-${i + 1}.jpg`),
    );
    const n = await entregar(CONV_ID + 1, muitos);

    // Exactly the cap, and exactly ONE pass: the notice is stashed on the event, so the second call
    // site finds text already there and takes its idempotence path. That is the intended shape — the
    // overflow is written once, not once per pass — and pinning it here is what would catch a notice
    // that starts accumulating.
    expect(await linhasDeVisao(CONV_ID + 1)).toBe(8);
    expect(n.message?.extractedText).toContain("3 anexo(s)");
    expect(n.message?.extractedText).toContain("reenvie o que falta");
  });

  // A message within the cap must not carry the notice: it would tell the model files are missing
  // when none are, and the model would ask the customer to resend what it already read.
  test("within the cap there is no overflow notice", async () => {
    await clearFlowLog(suDb, { tenantId });
    const n = await entregar(CONV_ID + 2, [anexo(301, "unico.png")]);

    expect(await linhasDeVisao(CONV_ID + 2)).toBeGreaterThan(0);
    expect(n.message?.extractedText ?? "").not.toContain("não foram lidos");
  });
});
