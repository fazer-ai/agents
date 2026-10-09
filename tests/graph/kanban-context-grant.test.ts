import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { type AgentConfig, buildToolset } from "@/graph/prepare";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { __resetChatwootVocabCache } from "@/modules/chatwoot/vocab";
import { CONTACT_AUTH_DEFAULTS } from "@/modules/contact-auth/settings";
import { CROSS_INBOX_CASE_DEFAULTS } from "@/modules/cross-inbox-case/settings";
import { HANDOFF_DEFAULTS } from "@/modules/handoff/settings";
import { SEND_IMAGE_DEFAULTS } from "@/modules/images/settings";
import { KANBAN_DEFAULTS } from "@/modules/kanban/settings";
import { clearFlowLog } from "../utils/flowlog";

// The card snapshot (`kanban` on the native tools' ctx) is what update_kanban_task reads as
// `<current_card>` and what opens the `task` scope of set_custom_attribute and set_labels. The two
// card tools get it granted alone; the two scope tools get it on an account that defines card
// attributes, and an account without them pays no read for them.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let app: PrismaClient | undefined;
let su: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    await su.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

function config(nativeToolsAllow: string[] | undefined): AgentConfig {
  return {
    agentId: 1n,
    contactDbId: null,
    conversationDbId: null,
    contactVoiceReply: null,
    documentSelections: [],
    handoffConfig: HANDOFF_DEFAULTS,
    kanbanConfig: KANBAN_DEFAULTS,
    contactAuth: CONTACT_AUTH_DEFAULTS,
    sendImageConfig: SEND_IMAGE_DEFAULTS,
    crossInboxCaseConfig: CROSS_INBOX_CASE_DEFAULTS,
    chatwootContactId: null,
    httpToolContext: {},
    codeToolDefs: [],
    httpToolDefs: [],
    integrationSelections: [],
    mcpSelections: [],
    nativeToolsAllow,
    ragConfig: undefined,
    timezone: "America/Sao_Paulo",
    toolGuidance: {},
    toolPreconditions: {},
    transferWithSummary: true,
    protectedLabels: [],
    allowedLabels: [],
    outsideAllowedLabels: "accept",
  } as unknown as AgentConfig;
}

describe.skipIf(!dbUp)("which granted tools resolve the card", () => {
  let tenantId = 0n;
  beforeAll(async () => {
    tenantId = (
      await (su as PrismaClient).tenant.create({
        data: { name: "Card 219", slug: `card-219-${process.pid}` },
      })
    ).id;
  });
  afterAll(async () => {
    await clearFlowLog(su as PrismaClient, { tenantId });
    await su?.tenant.delete({ where: { id: tenantId } });
    await su?.$disconnect();
    await app?.$disconnect();
  });

  async function cardSeen(allow: string[] | undefined, taskDefs = true) {
    __resetChatwootVocabCache();
    let reads = 0;
    let seen: Record<string, unknown> | undefined;
    // A conversation with a linked card and no board: the snapshot comes from this one read, and
    // anything else the client is asked for (labels, vocabulary) fails, which the prep tolerates.
    const client = new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "kanbanTaskForConversation"
            ? async () => {
                reads += 1;
                return {
                  id: 41,
                  board_id: null,
                  board_step_id: null,
                  title: "Conversa #9",
                  custom_attributes: { faturamento_mensal: "15 mil" },
                  labels: [],
                };
              }
            : prop === "listLabels"
              ? async () => []
              : prop === "listCustomAttributeDefinitions"
                ? async () =>
                    taskDefs
                      ? [
                          {
                            key: "faturamento_mensal",
                            displayName: "Faturamento mensal",
                            model: "task_attribute",
                            displayType: "text",
                            values: [],
                          },
                        ]
                      : []
                : prop === "then"
                  ? undefined
                  : async () => {
                      throw new Error(`not stubbed: ${String(prop)}`);
                    },
      },
    ) as unknown as ChatwootClient;
    await buildToolset(
      config(allow),
      {
        tenantId,
        instanceId: 1n,
        base: app as PrismaClient,
        client,
        conversationId: 9,
        threadId: `t-219-${process.pid}`,
      },
      {
        flow: {
          tenantId,
          turnId: `card-219-${process.pid}-${String(allow)}`,
          source: "inbox",
          base: app as PrismaClient,
        },
        buildNativeTools: (native) => {
          seen = native as unknown as Record<string, unknown>;
          return [];
        },
      },
    );
    const kanban = seen?.kanban as { taskId?: number } | undefined;
    return { taskId: kanban?.taskId, reads };
  }

  for (const tool of [
    "kanban_move_card",
    "update_kanban_task",
    "set_custom_attribute",
    "set_labels",
  ]) {
    test(`${tool} granted alone resolves the card`, async () => {
      expect((await cardSeen([tool])).taskId).toBe(41);
    });
  }

  for (const tool of ["kanban_move_card", "update_kanban_task"]) {
    test(`${tool} resolves the card on an account with no card attributes`, async () => {
      expect((await cardSeen([tool], false)).taskId).toBe(41);
    });
  }

  for (const tool of ["set_custom_attribute", "set_labels"]) {
    test(`${tool} on an account with no card attributes does not read the card`, async () => {
      const r = await cardSeen([tool], false);
      expect(r.taskId).toBeUndefined();
      expect(r.reads).toBe(0);
    });
  }

  test("every tool granted (no allowlist) resolves the card", async () => {
    expect((await cardSeen(undefined)).taskId).toBe(41);
  });

  test("an agent granted no card tool does not read the conversation for it", async () => {
    const r = await cardSeen(["calculator", "handoff_to_human"]);
    expect(r.taskId).toBeUndefined();
    expect(r.reads).toBe(0);
  });
});
