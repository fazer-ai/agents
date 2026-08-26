import { beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ResolvedModelConfig } from "@/graph/models";
import { runAgentTurn } from "@/graph/runtime";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { DEBUG_MAX_STRING, emitFlowEvent } from "@/modules/flowlog/service";
import { seedChatwootInstance } from "../utils/chatwoot";
import { UsageReportingModel } from "../utils/scripted-models";

// Issue #58 END TO END, at the effect the operator complained about: "I cannot see the whole prompt
// on the Logs page." The unit tests next door prove the reader and the ceiling; this one runs a real
// turn and reads the row, because that is the only place the complaint lives.
//
// The agent's own prompt is deliberately longer than the 2,000-character cut, with a marker in its
// last sentence. Whether that marker is IN THE ROW is the whole assertion, and it is the same
// question three times: with the mode off, with it armed, and with a window that has closed.

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

const BOT = 41;
const INBOX = 27;
// The sentence the operator wrote LAST, past the cut. Nonsense on purpose: finding it in a row is
// evidence about this prompt and never a coincidence of wording.
const TAIL = "REGRA-FINAL-XILOFONTE-7788";
const HEAD = "REGRA-INICIAL-ZEBRAFINA";
const RULE =
  "Nunca invente informações sobre procedimentos, valores ou disponibilidade da clínica; se não souber, diga que vai verificar. ";
// ~2.6k characters: past the 2,000 cut, so the tail only survives when the mode is armed.
const LONG_PROMPT = `${HEAD}. ${RULE.repeat(20)} ${TAIL}.`;
// The customer's own name, to keep the PII invariant honest under a raised ceiling.
const NAME = "Quixotesca Zebrafina";

let tenantId = 0n;
let instanceId = 0n;
let agentId = 0n;
let contactId = 0n;

const incoming = (convId: number): NormalizedChatwootEvent => ({
  event: "message_created",
  conversationId: convId,
  inboxId: INBOX,
  status: "pending",
  assigneeType: null,
  assigneeId: null,
  assigneeName: null,
  contactInboxId: null,
  message: {
    id: 1,
    content: "bom dia",
    messageType: "incoming",
    private: false,
  },
});

function stub() {
  return async () =>
    ({
      sendMessage: async () => ({}),
      sendPrivateNote: async () => ({}),
    }) as unknown as ChatwootClient;
}

async function seedConv(convId: number) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: "pending",
      assigneeType: null,
      contactId,
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(),
    },
  });
}

// Arms, disarms or expires the mode by writing the instant the window ends — the only stored form
// there is. `null` is off; a past instant is a window that CLOSED, which is what proves the expiry
// needs nothing to run.
async function setWindow(endsAt: Date | null) {
  const agent = await suDb.agent.findUniqueOrThrow({
    where: { id: agentId },
    select: { settings: true },
  });
  await suDb.agent.update({
    where: { id: agentId },
    data: {
      settings: {
        ...(agent.settings as Record<string, unknown>),
        observability: { fullDetailUntil: endsAt?.toISOString() ?? null },
      },
    },
  });
}

// The emit is fire-and-forget, so the row lands shortly after the turn returns.
async function generateRow(convId: number) {
  const threadId = `${tenantId}:${instanceId}:${convId}`;
  for (let i = 0; i < 200; i++) {
    const row = await suDb.executionLog.findFirst({
      where: { tenantId, threadId, stage: "generate" },
      select: { detail: true },
    });
    if (row) return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`turn ${convId} never produced a generate line`);
}

async function runTurn(convId: number) {
  await seedConv(convId);
  const model = new UsageReportingModel(["Bom dia! Como posso ajudar?"]);
  const outcome = await runAgentTurn({
    tenantId,
    instanceId,
    agentBotId: BOT,
    event: incoming(convId),
    base: appDb,
    deps: {
      makeModel: (_cfg: ResolvedModelConfig): BaseChatModel =>
        model as unknown as BaseChatModel,
      makeClient: stub(),
      checkpointer: new MemorySaver(),
    },
  });
  expect(outcome).toBe("posted");
  const row = await generateRow(convId);
  return String(
    (row.detail as Record<string, unknown> | null)?.systemPrompt ?? "",
  );
}

describe.skipIf(!dbUp)("the log debug mode, on a real turn", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "LOGDEBUG", slug: `logdebug-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 41,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const llmKey = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "llm-key",
        secret: encryptJson("sk-llm"),
      },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        // The contact variable is in the prompt so the PII invariant has something to catch: the
        // raised ceiling must not turn the audit's mask off.
        systemPrompt: `Você atende {{nome_contato}}. ${LONG_PROMPT}`,
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${llmKey.id}`,
        },
        settings: { split: { enabled: false } },
      },
    });
    agentId = agent.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: BOT,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `logdebug-route-${process.pid}`,
        name: "Atendente",
      },
    });
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX,
        name: "Suporte",
        agentId: agent.id,
      },
    });
    const contact = await suDb.contact.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootContactId: 4101,
        name: NAME,
        phone: "+5511987650041",
      },
      select: { id: true },
    });
    contactId = contact.id;
  });

  // The complaint, reproduced: the operator's last rule is not in the row.
  test("with the mode off, the operator's own prompt stops at the cut", async () => {
    await setWindow(null);
    const prompt = await runTurn(9701);
    expect(prompt).toContain(HEAD);
    expect(prompt).toContain("[truncated]");
    expect(prompt).not.toContain(TAIL);
  });

  // The fix, at the same place: same agent, same prompt, one setting.
  test("with the mode armed, the whole prompt is in the row", async () => {
    await setWindow(new Date(Date.now() + 3_600_000));
    const prompt = await runTurn(9702);
    expect(prompt).toContain(HEAD);
    expect(prompt).toContain(TAIL);
    expect(prompt).not.toContain("[truncated]");
  });

  // A raised SIZE ceiling is not a raised PII ceiling. The audit's mask is what keeps the contact's
  // name out of the column, and lifting the cut must not reach it — the two axes were kept apart on
  // purpose, and this is where that separation is measured rather than asserted in a comment.
  test("the whole prompt still carries no contact value", async () => {
    const prompt = await runTurn(9703);
    expect(prompt).not.toContain(NAME);
    expect(prompt).toContain("nome_contato");
  });

  // The budget, at the emit rather than through hand-passed arguments. A `generate` line carries one
  // string and so never notices it; the line that does is a tool line under both switches, and
  // whether the EMIT asks for a budget at all is exactly what a unit test calling `redactSecretsDeep`
  // directly cannot see.
  test("many long strings in one line stay bounded in total", async () => {
    await setWindow(new Date(Date.now() + 3_600_000));
    const turnId = crypto.randomUUID();
    emitFlowEvent(
      {
        tenantId,
        turnId,
        source: "inbox",
        agentId,
        threadId: `${tenantId}:${instanceId}:9705`,
        base: appDb,
        fullDetail: true,
      },
      {
        stage: "tool",
        status: "ok",
        detail: Object.fromEntries(
          Array.from({ length: 60 }, (_, i) => [`k${i}`, "y".repeat(20_000)]),
        ),
      },
    );
    let row: { detail: unknown } | null = null;
    for (let i = 0; i < 200 && row === null; i++) {
      row = await suDb.executionLog.findFirst({
        where: { tenantId, turnId },
        select: { detail: true },
      });
      if (row === null) await new Promise((r) => setTimeout(r, 20));
    }
    expect(row).not.toBeNull();
    const stored = JSON.stringify(row?.detail ?? null).length;
    // 60 leaves at 20k each is 1.2 MB of input. Without a budget every one of them would fit under
    // the 300k per-string ceiling and the whole 1.2 MB would land in the row.
    expect(stored).toBeGreaterThan(1_000);
    expect(stored).toBeLessThan(DEBUG_MAX_STRING + 60 * 40 + 5_000);
  });

  // The expiry, end to end. Nothing ran: no job, no sweep, no restart. The window simply closed.
  test("a window that has closed cuts the prompt again, with nothing having run", async () => {
    await setWindow(new Date(Date.now() - 1000));
    const prompt = await runTurn(9704);
    expect(prompt).toContain(HEAD);
    expect(prompt).toContain("[truncated]");
    expect(prompt).not.toContain(TAIL);
  });
});
