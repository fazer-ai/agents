import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ResolvedModelConfig } from "@/graph/models";
import { runAgentTurn } from "@/graph/runtime";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { seedChatwootInstance } from "../utils/chatwoot";
import { UsageReportingModel } from "../utils/scripted-models";

// `docs/logs.md` promises that `execution_logs.detail` carries allowlisted ids, counts and enums and
// NEVER message text or PII. The column is served by the Logs page and by `GET /v1/logs`, so the
// promise is what makes those two exportable. Nothing checked it, and the turn path was writing two
// things it forbids (issue #141).
//
// This file is the check, and it is deliberately written as an INVARIANT over the whole turn rather
// than as an assertion per stage: a new `detail:` added anywhere in the pipeline has to pass it
// without anyone remembering this file exists. Every marker below is a nonsense word seeded into one
// specific customer-authored place, so finding it in a row is evidence about that place and never a
// coincidence of wording.

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
let instanceId = 0n;
let contactId = 0n;

// One marker per customer-authored channel into the resolved prompt. They are distinct so a failure
// names WHICH channel leaked, instead of only that something did.
const NAME = "Zebrafina Quixotesca"; // → {{nome_contato}}, interpolated into the prompt body
const PHONE = "+5511987650001"; // → {{telefone_contato}}
const ATTR = "processo-xilofonte-7788"; // → the attribute context block appended to the prompt
const ASKED = "meu processo e o xilofonte-7788"; // → the customer's own message this turn

const BOT = 31;
const INBOX = 17;
const GUARD_MODEL = "guard-model";

const incoming = (
  convId: number,
  content = ASKED,
): NormalizedChatwootEvent => ({
  event: "message_created",
  conversationId: convId,
  inboxId: INBOX,
  status: "pending",
  assigneeType: null,
  assigneeId: null,
  assigneeName: null,
  contactInboxId: null,
  message: { id: 1, content, messageType: "incoming", private: false },
});

function stub(sent: Array<[number, string]> = []) {
  const client = {
    sendMessage: async (c: number, content: string) => {
      sent.push([c, content]);
      return {};
    },
    sendPrivateNote: async () => ({}),
  } as unknown as ChatwootClient;
  return async () => client;
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
      customAttributes: { numero_processo: ATTR },
    },
  });
}

// The emits are fire-and-forget, so the rows land shortly AFTER the turn returns, and they do not
// land in one go: `guardrail` is written after `generate`, since the reply has to exist before it
// can be screened. Waiting on `generate` alone therefore reads a turn that is still being written,
// which fails the assertions that inspect the later line and, worse, would let the PII invariant
// pass by simply not having seen the offending row yet. So the caller names every stage this turn
// is expected to produce, and nothing is read until all of them are there.
async function turnRows(convId: number, stages: readonly string[]) {
  const threadId = `${tenantId}:${instanceId}:${convId}`;
  for (let i = 0; i < 200; i++) {
    const rows = await suDb.executionLog.findMany({
      where: { tenantId, threadId },
      select: { stage: true, detail: true, errorMessage: true },
    });
    if (stages.every((s) => rows.some((r) => r.stage === s))) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `turn ${convId} never produced all of [${stages.join(", ")}]`,
  );
}

// The assertion itself: every marker, against every row of the turn, naming the stage that carries
// it. `detail` and `errorMessage` are checked together because they are one promise: the operator
// exports the row, not the column.
function expectNoMarkers(
  rows: Array<{
    stage: string;
    detail: unknown;
    errorMessage: string | null;
  }>,
  markers: string[],
) {
  expect(rows.length).toBeGreaterThan(0);
  const offenders: string[] = [];
  for (const row of rows) {
    const serialized = `${JSON.stringify(row.detail ?? null)} ${row.errorMessage ?? ""}`;
    for (const marker of markers) {
      if (serialized.includes(marker)) {
        offenders.push(`${row.stage}: ${marker}`);
      }
    }
  }
  expect(offenders).toEqual([]);
}

describe.skipIf(!dbUp)(
  "execution_logs.detail never carries customer text",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "LOGPII", slug: `logpii-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 31,
        baseUrl: "https://chat.example.com",
        adminToken: encryptJson("ADMIN"),
      });
      instanceId = inst.id;
      const llmKey = await suDb.vaultEntry.create({
        data: { tenantId, name: "llm-key", secret: encryptJson("sk-llm") },
        select: { id: true },
      });
      const guardKey = await suDb.vaultEntry.create({
        data: { tenantId, name: "guard-key", secret: encryptJson("sk-guard") },
        select: { id: true },
      });
      // The agent is configured the way an operator who wants a personal greeting configures it: the
      // contact variables in the prompt body, and one conversation attribute exposed as context.
      const agent = await suDb.agent.create({
        data: {
          tenantId,
          name: "Atendente",
          systemPrompt:
            "Você atende {{nome_contato}} no telefone {{telefone_contato}}. Seja breve.",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: `vault:${llmKey.id}`,
          },
          settings: {
            split: { enabled: false },
            attributeContext: { conversation: ["numero_processo"] },
            guardrails: {
              enabled: true,
              provider: "openai",
              model: GUARD_MODEL,
              credentialRef: `vault:${guardKey.id}`,
              input: { enabled: false },
              output: {
                enabled: true,
                action: "template",
                checks: {
                  toxicity: true,
                  unsafeContent: false,
                  competitorMentions: false,
                  promptAdherence: false,
                },
                templateMessage: "TEMPLATE-OUT",
              },
            },
          },
        },
      });
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: agent.id,
          chatwootAgentBotId: BOT,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `logpii-route-${process.pid}`,
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
          name: NAME,
          phone: PHONE,
          chatwootContactId: 31,
        },
      });
      contactId = contact.id;
    });

    afterAll(async () => {
      if (tenantId) {
        for (const table of [
          "execution_logs",
          "llm_usage",
          "conversations",
          "inboxes",
          "chatwoot_agent_bots",
          "agents",
          "contacts",
          "vault_entries",
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

    // The `generate` line records the system prompt the agent received this turn, so the operator can
    // inspect it (docs item 15). What it recorded was the RESOLVED prompt: `{{nome_contato}}` already
    // replaced by the contact's real name, and the attribute-context block (whose own source calls
    // its values "ultimately customer-authored") appended to the end.
    test("the recorded system prompt carries no contact value and no attribute value", async () => {
      await seedConv(9601);
      const sent: Array<[number, string]> = [];
      const model = new UsageReportingModel(["Já verifico para você."]);
      const outcome = await runAgentTurn({
        tenantId,
        instanceId,
        agentBotId: BOT,
        event: incoming(9601),
        base: appDb,
        deps: {
          makeModel: (cfg: ResolvedModelConfig): BaseChatModel =>
            cfg.model === GUARD_MODEL
              ? ({
                  invoke: async () => ({
                    content: JSON.stringify({
                      violated: false,
                      categories: [],
                      rationale: "",
                      suggestedReply: null,
                    }),
                  }),
                } as unknown as BaseChatModel)
              : (model as unknown as BaseChatModel),
          makeClient: stub(sent),
          checkpointer: new MemorySaver(),
        },
      });
      expect(outcome).toBe("posted");
      const rows = await turnRows(9601, ["generate"]);
      expectNoMarkers(rows, [NAME, PHONE, ATTR, ASKED]);
    });

    // The prompt still has to be inspectable, which is the whole reason the field exists: an operator
    // debugging "why did it answer that" needs to see the rules the agent was given and which
    // variables were in play. Only the VALUES go.
    test("the recorded system prompt keeps the operator's own text and names the variables", async () => {
      const rows = await turnRows(9601, ["generate"]);
      const generate = rows.find((r) => r.stage === "generate");
      const prompt = String(
        (generate?.detail as Record<string, unknown> | null)?.systemPrompt ??
          "",
      );
      expect(prompt).toContain("Seja breve.");
      expect(prompt).toContain("nome_contato");
      expect(prompt).toContain("telefone_contato");
      // The attribute block was built this turn, and the row says so, without a value.
      expect(prompt).toContain("numero_processo");
    });

    // The guardrail's `rationale` is one model-written sentence explaining what in the message violated
    // the policy, so it quotes the message by construction. It was written to `detail` verbatim.
    test("a guardrail verdict records its categories and action, never its rationale", async () => {
      await seedConv(9602);
      const sent: Array<[number, string]> = [];
      const model = new UsageReportingModel(["Resposta qualquer."]);
      const outcome = await runAgentTurn({
        tenantId,
        instanceId,
        agentBotId: BOT,
        event: incoming(9602),
        base: appDb,
        deps: {
          makeModel: (cfg: ResolvedModelConfig): BaseChatModel =>
            cfg.model === GUARD_MODEL
              ? ({
                  invoke: async () => ({
                    content: JSON.stringify({
                      violated: true,
                      categories: ["toxicity"],
                      // A rationale in the shape the prompt asks for: one sentence, quoting the
                      // customer back.
                      rationale: `O cliente disse "${ASKED}" e a resposta repetiu o dado.`,
                      suggestedReply: null,
                    }),
                  }),
                } as unknown as BaseChatModel)
              : (model as unknown as BaseChatModel),
          makeClient: stub(sent),
          checkpointer: new MemorySaver(),
        },
      });
      expect(outcome).toBe("posted");
      expect(sent).toEqual([[9602, "TEMPLATE-OUT"]]);
      const rows = await turnRows(9602, ["generate", "guardrail"]);
      expectNoMarkers(rows, [NAME, PHONE, ATTR, ASKED]);
      // What the operator still gets on that line: what the guardrail DID.
      const guard = rows.find((r) => r.stage === "guardrail");
      const detail = guard?.detail as Record<string, unknown> | null;
      expect(detail?.direction).toBe("output");
      expect(detail?.action).toBe("template");
      expect(detail?.categories).toEqual(["toxicity"]);
    });

    // `categories` is the other field the model fills in, and it is model-written too: the prompt
    // asks for policy keys, nothing holds the model to that, and a model answering in prose ("o
    // cliente citou o processo ...") wrote that straight into a column the docs describe as enums.
    // Dropping `rationale` alone would have left the same door open one field over.
    test("a category outside the policy vocabulary is dropped, not logged", async () => {
      await seedConv(9603);
      const sent: Array<[number, string]> = [];
      const model = new UsageReportingModel(["Resposta qualquer."]);
      const outcome = await runAgentTurn({
        tenantId,
        instanceId,
        agentBotId: BOT,
        event: incoming(9603),
        base: appDb,
        deps: {
          makeModel: (cfg: ResolvedModelConfig): BaseChatModel =>
            cfg.model === GUARD_MODEL
              ? ({
                  invoke: async () => ({
                    content: JSON.stringify({
                      violated: true,
                      categories: ["toxicity", `o cliente disse ${ASKED}`],
                      rationale: "",
                      suggestedReply: null,
                    }),
                  }),
                } as unknown as BaseChatModel)
              : (model as unknown as BaseChatModel),
          makeClient: stub(sent),
          checkpointer: new MemorySaver(),
        },
      });
      expect(outcome).toBe("posted");
      const rows = await turnRows(9603, ["generate", "guardrail"]);
      expectNoMarkers(rows, [NAME, PHONE, ATTR, ASKED]);
      // The violation still stands and the key that WAS a key survives. The stranger is gone from
      // the row but not from the operator's view: it is counted, so a violation of something this
      // column cannot name (the operator's own customPolicy has no key at all) still reads as one.
      const guard = rows.find((r) => r.stage === "guardrail");
      const detail = guard?.detail as Record<string, unknown> | null;
      expect(detail?.categories).toEqual(["toxicity"]);
      expect(detail?.categoriesUnnamed).toBe(1);
    });
  },
);
