import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  type AgentConfig,
  buildToolset,
  type ToolsetCtx,
} from "@/graph/prepare";
import { resolveCaseHoldFor } from "@/graph/resolve-labels";
import { ownTransfer } from "@/graph/tools/native";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { composeForChatwoot, markValue } from "@/modules/chatwoot/liquid";
import { CONTACT_AUTH_DEFAULTS } from "@/modules/contact-auth/settings";
import {
  CROSS_INBOX_CASE_DEFAULTS,
  type CrossInboxCaseConfig,
} from "@/modules/cross-inbox-case/settings";
import { HANDOFF_DEFAULTS } from "@/modules/handoff/settings";
import { SEND_IMAGE_DEFAULTS } from "@/modules/images/settings";
import { KANBAN_DEFAULTS } from "@/modules/kanban/settings";
import { SIGNATURE_DEFAULTS } from "@/modules/signature/service";
import { dbProbeFailed } from "@/tests/db-gate";

// The destination config and the origin contact reach `open_case_in_inbox` through the
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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}

function config(
  cic: CrossInboxCaseConfig,
  signature = SIGNATURE_DEFAULTS,
): AgentConfig {
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
    resolveCaseHold: resolveCaseHoldFor(cic),
    chatwootContactId: 55,
    signatureConfig: signature,
    promptVars: {},
    promptOpts: { now: new Date() },
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

async function seenFor(
  cic: CrossInboxCaseConfig,
  instanceId: bigint,
  conversationId = 77,
  signature = SIGNATURE_DEFAULTS,
) {
  let seen: Record<string, unknown> | undefined;
  const ctx: ToolsetCtx = {
    tenantId: 1n,
    instanceId,
    base: app as PrismaClient,
    client: {} as unknown as ChatwootClient,
    conversationId,
    threadId: `t-${process.pid}`,
  };
  await buildToolset(config(cic, signature), ctx, {
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
    expect(await seenFor(picked, 3n)).toMatchObject({
      config: picked,
      contactId: 55,
    });
  });

  test("on another account the tool gets nothing", async () => {
    expect(await seenFor(picked, 4n)).toBeUndefined();
  });

  // The close's check for a contact waiting on a case reads the operator's destination, not the tool's
  // availability: a note-only nudge takes the tool away by clearing its inbox, and resolve_conversation
  // is still there to close, so the hold must survive that.
  test("the case hold survives the tool being taken away, and stays on its account", async () => {
    const seenHold = async (instanceId: bigint) => {
      let seen: Record<string, unknown> | undefined;
      await buildToolset(
        {
          ...config(picked),
          crossInboxCaseConfig: { ...picked, targetInboxId: null },
        },
        {
          tenantId: 1n,
          instanceId,
          base: app as PrismaClient,
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
      return seen?.resolveCaseHold;
    };
    expect(await seenHold(3n)).toEqual({
      targetInboxId: 40,
      caseAttributeKey: picked.caseAttributeKey,
      contactId: 55,
    });
    expect(await seenHold(4n)).toBeNull();
  });

  test("the turn's output screening reaches the tool", async () => {
    let seen: Record<string, unknown> | undefined;
    const screen = async () => "drop" as const;
    await buildToolset(
      config(picked),
      {
        tenantId: 1n,
        instanceId: 3n,
        base: app as PrismaClient,
        client: {} as unknown as ChatwootClient,
        conversationId: 77,
        threadId: `t-${process.pid}`,
        screenCustomerText: screen,
      },
      {
        buildNativeTools: (native) => {
          seen = native as unknown as Record<string, unknown>;
          return [];
        },
      },
    );
    expect(seen?.screenCustomerText).toBe(screen);
  });

  test("the playground, which belongs to no account, keeps the tool to simulate it", async () => {
    // NOTE: the playground builds with instance 0, which matches no picked account.
    expect(await seenFor(picked, 0n, 0)).toMatchObject({
      config: picked,
      contactId: 55,
    });
  });

  test("the opening is signed with the agent's signature, and left alone without one", async () => {
    // The opening reaches the customer, and Chatwoot does not sign API sends.
    const on = (await seenFor(picked, 3n, 77, {
      ...SIGNATURE_DEFAULTS,
      enabled: true,
      text: "Ana, fazer.ai",
      position: "bottom",
    })) as { sign?: (t: string) => string };
    expect(on.sign?.("Abrimos seu caso.")).toBe(
      "Abrimos seu caso.\n\nAna, fazer.ai",
    );
    const off = (await seenFor(picked, 3n)) as { sign?: (t: string) => string };
    expect(off.sign?.("Abrimos seu caso.")).toBe("Abrimos seu caso.");
  });

  // The signer owns the whole opening, so it is the one that escapes the model's part;
  // the operator's signature keeps its Liquid, with or without one configured.
  test("the signer escapes the model's text and leaves the signature's Liquid alone", async () => {
    const on = (await seenFor(picked, 3n, 77, {
      ...SIGNATURE_DEFAULTS,
      enabled: true,
      text: "Att {{contact.name}}",
      position: "bottom",
    })) as { sign?: (t: string) => string };
    expect(on.sign?.("Caso {{foo}}")).toBe(
      "Caso {{ '{{' }}foo}}\n\nAtt {{contact.name}}",
    );
    const off = (await seenFor(picked, 3n)) as { sign?: (t: string) => string };
    expect(off.sign?.("Caso {{foo}}")).toBe("Caso {{ '{{' }}foo}}");
  });

  test("the operator's templates are filled with the prompt's context variables", async () => {
    let seen: Record<string, unknown> | undefined;
    await buildToolset(
      {
        ...config(picked),
        promptVars: { primeiro_nome: "Ana {{contact.email}}" },
      } as AgentConfig,
      {
        tenantId: 1n,
        instanceId: 3n,
        base: app as PrismaClient,
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
      interpolate?: (t: string) => string;
    };
    // The contact's name is a value, not the operator's Liquid: it goes out escaped.
    const filled =
      cic.interpolate?.("Olá, {{primeiro_nome}} {{mensagem}}") ?? "";
    expect(filled).toBe(
      `Olá, ${markValue("Ana {{contact.email}}")} {{mensagem}}`,
    );
    expect(composeForChatwoot(filled)).toBe(
      "Olá, Ana {{ '{{' }}contact.email}} {{mensagem}}",
    );
  });

  test("a config written without the account is honored as-is", async () => {
    const legacy = { ...picked, targetInstanceId: null };
    expect(await seenFor(legacy, 4n)).toMatchObject({
      config: legacy,
      contactId: 55,
    });
  });
});

// A transfer the output check asks for, made from inside a tool call, has to wear the
// turn's own ownership marks, or a sibling call's fence reads its status webhook as a takeover.
describe("ownTransfer", () => {
  test("in flight while it runs, and marked changed only when it changed", async () => {
    const state: {
      customerMessage: string | null;
      completed: boolean;
      ownerChanged?: boolean;
      ownerChangesInFlight?: number;
    } = { customerMessage: null, completed: false };
    let seenInFlight = -1;
    await ownTransfer(
      state,
      async () => {
        seenInFlight = state.ownerChangesInFlight ?? 0;
        return "failed";
      },
      (r) => r === "handed",
    );
    expect(seenInFlight).toBe(1);
    expect(state.ownerChangesInFlight).toBe(0);
    expect(state.ownerChanged).toBeUndefined();
    await ownTransfer(
      state,
      async () => "handed",
      (r) => r === "handed",
    );
    expect(state.ownerChanged).toBe(true);
  });
});
