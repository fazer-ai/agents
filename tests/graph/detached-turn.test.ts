import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  isValidDetachedThread,
  newDetachedThreadId,
  resolveDetachedThread,
} from "@/graph/detached-thread";
import { buildDetachedToolset } from "@/graph/detached-turn";
import type { AgentConfig } from "@/graph/prepare";
import {
  CLIENT_CHANNEL_NATIVES,
  PLAYGROUND_NATIVES,
} from "@/graph/tools/channel-natives";
import { CONTACT_AUTH_DEFAULTS } from "@/modules/contact-auth/settings";
import { CROSS_INBOX_CASE_DEFAULTS } from "@/modules/cross-inbox-case/settings";
import { HANDOFF_DEFAULTS } from "@/modules/handoff/settings";
import { SEND_IMAGE_DEFAULTS } from "@/modules/images/settings";
import { KANBAN_DEFAULTS } from "@/modules/kanban/settings";
import { dbProbeFailed } from "@/tests/db-gate";

describe("detached thread fence", () => {
  const client = newDetachedThreadId("client", 7n, 3n);

  test("a channel honors only its own threads, for its tenant and agent", () => {
    expect(isValidDetachedThread("client", client, 7n, 3n)).toBe(true);
    expect(isValidDetachedThread("client", client, 8n, 3n)).toBe(false);
    expect(isValidDetachedThread("client", client, 7n, 4n)).toBe(false);
    expect(isValidDetachedThread("playground", client, 7n, 3n)).toBe(false);
    const playground = newDetachedThreadId("playground", 7n, 3n);
    expect(isValidDetachedThread("client", playground, 7n, 3n)).toBe(false);
    // A real conversation's thread, and one with a segment smuggled in after the agent.
    expect(isValidDetachedThread("client", "7:1:42", 7n, 3n)).toBe(false);
    expect(isValidDetachedThread("client", `${client}:x`, 7n, 3n)).toBe(false);
  });

  test("a foreign id starts a fresh thread instead of reading the other one", () => {
    const playground = newDetachedThreadId("playground", 7n, 3n);
    const resolved = resolveDetachedThread("client", playground, 7n, 3n);
    expect(resolved).not.toBe(playground);
    expect(resolved.startsWith("7:client:3:")).toBe(true);
    expect(resolveDetachedThread("client", client, 7n, 3n)).toBe(client);
  });
});

const appUrl = process.env.TEST_APP_DATABASE_URL;
let app: PrismaClient | undefined;
let dbUp = false;
if (appUrl) {
  try {
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}

function config(): AgentConfig {
  return {
    agentId: 1n,
    contactDbId: null,
    conversationDbId: null,
    contactVoiceReply: null,
    documentSelections: [
      {
        templateId: 1n,
        name: "Recibo",
        slug: "recibo",
        description: null,
        fields: [],
      },
    ],
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
    nativeToolsAllow: undefined,
    ragConfig: undefined,
    timezone: "America/Sao_Paulo",
    toolGuidance: {},
    toolPreconditions: {},
    transferWithSummary: true,
  } as unknown as AgentConfig;
}

describe.skipIf(!dbUp)("detached toolset", () => {
  afterAll(async () => {
    await app?.$disconnect();
  });

  const build = (
    natives: typeof PLAYGROUND_NATIVES | typeof CLIENT_CHANNEL_NATIVES,
    documents: "simulated" | "omitted",
  ) =>
    buildDetachedToolset(config(), {
      ctx: { tenantId: 1n } as never,
      threadId: "1:client:1:t",
      base: app as PrismaClient,
      flow: undefined,
      replyChoice: undefined,
      natives,
      documents,
    }).then((tools) => tools.map((t) => t.name));

  test("the playground keeps its document tool, simulated", async () => {
    expect(await build(PLAYGROUND_NATIVES, "simulated")).toContain(
      "send_recibo",
    );
  });

  test("the client channel is offered no document tool and no conversation native", async () => {
    const names = await build(CLIENT_CHANNEL_NATIVES, "omitted");
    expect(names).not.toContain("send_recibo");
    expect(names.sort()).toEqual(["calculator", "get_current_time"]);
  });
});
