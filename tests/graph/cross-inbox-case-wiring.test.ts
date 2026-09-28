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
import { CONTACT_AUTH_DEFAULTS } from "@/modules/contact-auth/settings";
import {
  CROSS_INBOX_CASE_DEFAULTS,
  type CrossInboxCaseConfig,
} from "@/modules/cross-inbox-case/settings";
import { HANDOFF_DEFAULTS } from "@/modules/handoff/settings";
import { SEND_IMAGE_DEFAULTS } from "@/modules/images/settings";
import { KANBAN_DEFAULTS } from "@/modules/kanban/settings";
import { SIGNATURE_DEFAULTS } from "@/modules/signature/service";

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
    // Review round 4: the playground builds with instance 0, which matched no picked account.
    expect(await seenFor(picked, 0n, 0)).toMatchObject({
      config: picked,
      contactId: 55,
    });
  });

  test("the opening is signed with the agent's signature, and left alone without one", async () => {
    // Review round 5: the opening reaches the customer, and Chatwoot does not sign API sends.
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
        promptVars: { primeiro_nome: "Ana" },
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
    expect(cic.interpolate?.("Olá, {{primeiro_nome}} {{mensagem}}")).toBe(
      "Olá, Ana {{mensagem}}",
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

// Review rounds 1 and 2: the opening message reaches the customer from inside the tool, so the
// screening every reply passes has to be handed to it by the two runtimes that own the gate, and a
// `handoff` verdict has to take the transfer those runtimes take for their own trips. Read off the
// source because the binding is a closure over a gate built later in the same function.
describe("both runtimes bind the output gate for it", () => {
  const binding = (src: string) => {
    const at = src.indexOf("screenCustomerText: async (text) => {");
    expect(at).toBeGreaterThan(-1);
    return src.slice(at, src.indexOf("\n        },\n", at) + 1 || at + 900);
  };
  test("the reactive turn screens with its gate and transfers through its own hand-over", async () => {
    const b = binding(await Bun.file("src/graph/runtime.ts").text());
    expect(b).toContain('await runGuardrail("output", text)');
    expect(b).toContain('if (!guardrailTripped(d)) return "send";');
    expect(b).toContain('() => handOverForGuardrail("output")');
    expect(b).toContain("handoffState.customerMessage = d.reply;");
    // Review round 5: a transfer that did not land stops the opening instead of reading as a drop.
    expect(b).toContain('if (handed === "failed") return "failed";');
  });
  test("the proactive turn screens with its gate and transfers through the guardrail hand-off", async () => {
    const b = binding(await Bun.file("src/graph/nudge.ts").text());
    expect(b).toContain("await screenOutput(text)");
    expect(b).toContain('if (!guardrailTripped(d)) return "send";');
    expect(b).toContain("applyGuardrailHandoff({");
    expect(b).toContain('return handed ? "handed" : "failed";');
    // Review round 7: a policy with no line is a silent transfer here too.
    expect(b).toContain("handoffState.declinedToSpeak = d.reply === null;");
    expect(b).toContain("handoffState.completed = handed;");
    // Review round 4: asked after the screening and before the transfer, since inside `ownTransfer`
    // the in-flight mark hides the turn's own change from the ownership reads.
    const fence = b.indexOf('if (!(await toolFence())) return "drop";');
    expect(fence).toBeGreaterThan(b.indexOf("await screenOutput(text)"));
    expect(fence).toBeLessThan(b.indexOf("await ownTransfer("));
  });
});

// Review round 3: a transfer the output check asks for, made from inside a tool call, has to wear the
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

  test("both runtimes wrap the guardrail transfer in it", async () => {
    for (const f of ["src/graph/runtime.ts", "src/graph/nudge.ts"]) {
      const src = await Bun.file(f).text();
      const at = src.indexOf("screenCustomerText: async (text) => {");
      expect(src.slice(at, at + 900)).toContain("await ownTransfer(");
    }
  });
});

// Review round 8: a nudge that may only write notes (a person owns the conversation) must not get a
// tool that sends to the customer from inside the call. Read off the source, since the toolset is
// built from a config the nudge derives in the middle of a long function.
describe("a note-only nudge does not get the tool", () => {
  test("the destination is cleared unless this nudge may message the customer", async () => {
    const src = await Bun.file("src/graph/nudge.ts").text();
    const at = src.indexOf(
      "const nudgeCfg: AgentConfig = withFollowupSilenceChannel(",
    );
    expect(at).toBeGreaterThan(src.indexOf("const canMessagePre ="));
    const b = src.slice(at, at + 400);
    expect(b).toContain("canMessagePre\n      ? cfg");
    expect(b).toContain("targetInboxId: null");
  });
});
