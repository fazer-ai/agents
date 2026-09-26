import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  type AgentConfig,
  buildToolset,
  type ToolsetCtx,
} from "@/graph/prepare";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { CONTACT_AUTH_DEFAULTS } from "@/modules/contact-auth/settings";
import {
  CROSS_INBOX_CASE_DEFAULTS,
  type CrossInboxCaseConfig,
} from "@/modules/cross-inbox-case/settings";
import { HANDOFF_DEFAULTS } from "@/modules/handoff/settings";
import { SEND_IMAGE_DEFAULTS } from "@/modules/images/settings";
import { KANBAN_DEFAULTS } from "@/modules/kanban/settings";

// Issue #700: the destination config and the origin contact reach `open_case_in_inbox` through the
// toolset the runtime builds, and an inbox picked in one Chatwoot account never reaches a
// conversation of another, where its id names a different inbox or none.

const appUrl = process.env.TEST_APP_DATABASE_URL;
let dbUp = false;
let app: PrismaClient | undefined;
if (appUrl) {
  try {
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

function config(cic: CrossInboxCaseConfig): AgentConfig {
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
    crossInboxCaseConfig: cic,
    chatwootContactId: 55,
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

async function seenFor(cic: CrossInboxCaseConfig, instanceId: bigint) {
  let seen: Record<string, unknown> | undefined;
  const ctx: ToolsetCtx = {
    tenantId: 1n,
    instanceId,
    base: app as PrismaClient,
    client: {} as unknown as ChatwootClient,
    conversationId: 77,
    threadId: `t-${process.pid}`,
  };
  await buildToolset(config(cic), ctx, {
    buildNativeTools: (native) => {
      seen = native as unknown as Record<string, unknown>;
      return [];
    },
  });
  return seen?.crossInboxCase;
}

describe.skipIf(!dbUp)("open_case_in_inbox wiring", () => {
  afterAll(async () => {
    await app?.$disconnect();
  });

  const picked = {
    ...CROSS_INBOX_CASE_DEFAULTS,
    targetInboxId: 40,
    targetInstanceId: 3,
  };

  test("the config and the contact reach the tool on the account the inbox was picked from", async () => {
    expect(await seenFor(picked, 3n)).toEqual({
      config: picked,
      contactId: 55,
    });
  });

  test("on another account the tool gets nothing", async () => {
    expect(await seenFor(picked, 4n)).toBeUndefined();
  });

  test("a config written without the account is honored as-is", async () => {
    const legacy = { ...picked, targetInstanceId: null };
    expect(await seenFor(legacy, 4n)).toEqual({
      config: legacy,
      contactId: 55,
    });
  });
});
