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
import { HANDOFF_DEFAULTS } from "@/modules/handoff/settings";
import { SEND_IMAGE_DEFAULTS } from "@/modules/images/settings";
import { KANBAN_DEFAULTS } from "@/modules/kanban/settings";

// Issue #638: the list reaches the tool through the toolset the runtime builds, not only through a
// ctx a unit test hands to `buildNativeTools` itself. Asked of `buildToolset` with the native
// builder injected, so what is checked is exactly the object the runtime passes on.

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

function config(): AgentConfig {
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
    protectedLabels: ["agente-off"],
    allowedLabels: ["vip", "suporte"],
    outsideAllowedLabels: "accept",
  } as unknown as AgentConfig;
}

describe.skipIf(!dbUp)("the allowed list reaches set_labels", () => {
  afterAll(async () => {
    await app?.$disconnect();
  });

  test("buildToolset hands the list and its mode to the native tools", async () => {
    let seen: Record<string, unknown> | undefined;
    const ctx: ToolsetCtx = {
      tenantId: 1n,
      instanceId: 1n,
      base: app as PrismaClient,
      client: {} as unknown as ChatwootClient,
      conversationId: 77,
      threadId: `t-${process.pid}`,
    };
    await buildToolset(config(), ctx, {
      buildNativeTools: (native) => {
        seen = native as unknown as Record<string, unknown>;
        return [];
      },
    });
    expect(seen?.allowedLabels).toEqual(["vip", "suporte"]);
    expect(seen?.outsideAllowedLabels).toBe("accept");
    expect(seen?.protectedLabels).toEqual(["agente-off"]);
  });
});
