import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { contactInboxThreadId } from "@/graph/checkpointer";
import { conversationStamp, sentAtStamp } from "@/graph/markers";
import { type AgentConfig, buildToolset } from "@/graph/prepare";
import { buildThreadStateGraph } from "@/graph/thread-state";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { CONTACT_AUTH_DEFAULTS } from "@/modules/contact-auth/settings";
import { CROSS_INBOX_CASE_DEFAULTS } from "@/modules/cross-inbox-case/settings";
import { HANDOFF_DEFAULTS } from "@/modules/handoff/settings";
import { SEND_IMAGE_DEFAULTS } from "@/modules/images/settings";
import { KANBAN_DEFAULTS } from "@/modules/kanban/settings";

// The `attendance` scope of carrying files reaches the case tool through the toolset the runtime
// builds: read off the saver the turn's graph runs on, with the agent's debounce ceiling beside it.

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

function config(): AgentConfig {
  return {
    agentId: 1n,
    contactDbId: null,
    conversationDbId: null,
    contactInboxId: 301,
    contactVoiceReply: null,
    documentSelections: [],
    handoffConfig: HANDOFF_DEFAULTS,
    kanbanConfig: KANBAN_DEFAULTS,
    contactAuth: CONTACT_AUTH_DEFAULTS,
    sendImageConfig: SEND_IMAGE_DEFAULTS,
    crossInboxCaseConfig: {
      ...CROSS_INBOX_CASE_DEFAULTS,
      targetInboxId: 40,
      carryAttachments: {
        mode: "attendance",
        fileTypes: ["file"],
        maxFiles: 10,
      },
    },
    burstSeconds: 45,
    chatwootContactId: 5,
    httpToolContext: {},
    codeToolDefs: [],
    httpToolDefs: [],
    integrationSelections: [],
    mcpSelections: [],
    nativeToolsAllow: undefined,
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

describe.skipIf(!dbUp)("carrying files reaches the case tool", () => {
  let tenantId = 0n;
  beforeAll(async () => {
    tenantId = (
      await (su as PrismaClient).tenant.create({
        data: { name: "Anexos", slug: `carry-wiring-${process.pid}` },
      })
    ).id;
  });
  afterAll(async () => {
    await su?.tenant.delete({ where: { id: tenantId } });
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("the attendance is read off the turn's own saver, with the debounce ceiling", async () => {
    const saver = new MemorySaver();
    await buildThreadStateGraph(saver).invoke(
      {
        messages: [
          new HumanMessage({
            content: "oi",
            additional_kwargs: {
              ...conversationStamp(77),
              ...sentAtStamp(new Date("2026-10-06T09:00:00Z")),
            },
          }),
        ],
      },
      {
        configurable: {
          thread_id: contactInboxThreadId(tenantId, 1n, 301),
        },
      },
    );
    let seen: Record<string, unknown> | undefined;
    await buildToolset(
      config(),
      {
        tenantId,
        instanceId: 1n,
        base: app as PrismaClient,
        checkpointer: saver,
        client: {} as unknown as ChatwootClient,
        conversationId: 77,
        threadId: `t-${process.pid}`,
      },
      {
        buildNativeTools: (native) => {
          seen = native as unknown as Record<string, unknown>;
          return [];
        },
      },
    );
    const cic = seen?.crossInboxCase as {
      attendanceStartedAt?: () => Promise<Date | null>;
      burstSeconds?: number;
    };
    expect(cic.burstSeconds).toBe(45);
    expect((await cic.attendanceStartedAt?.())?.toISOString()).toBe(
      "2026-10-06T09:00:00.000Z",
    );
  });
});
