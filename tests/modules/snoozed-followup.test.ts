import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BindToolsInput } from "@langchain/core/language_models/chat_models";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { contactInboxThreadId } from "@/graph/checkpointer";
import { HUMAN_HANDBACK_NOTE } from "@/graph/markers";
import { buildThreadStateGraph, THREAD_STATE_NODE } from "@/graph/thread-state";
import { HANDOFF_DONE_PREFIX } from "@/graph/tools/catalog";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { ChatwootMessageRow } from "@/modules/chatwoot/messages";
import { isSnoozedForAPerson } from "@/modules/chatwoot/normalize";
import {
  findSnoozedAnchor,
  snoozedDedupeKey,
  snoozedFollowUpHandler,
  snoozedLadderPosition,
  someoneSpokeAfter,
  sweepSnoozedFollowUps,
} from "@/modules/followups/snoozed";
import {
  pickSnoozedCadence,
  readSnoozedFollowUpConfig,
} from "@/modules/followups/snoozed-settings";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";
import { burnSchedulerJobId } from "../utils/scheduler";
import {
  guardrailModel,
  SideEffectModel,
  ToolRecordingModel,
} from "../utils/scripted-models";

// The snoozed ladder: a person snoozed a conversation "until next reply" and the
// customer never answered. The pure half first, then the handler against a stubbed Chatwoot.

function row(
  over: Partial<ChatwootMessageRow> & { id: number },
): ChatwootMessageRow {
  return {
    content: "",
    createdAt: new Date(over.id * 1000),
    messageType: "outgoing",
    private: false,
    attachmentTypes: [],
    transcribedText: null,
    imageDescription: null,
    extractedText: null,
    attachmentName: null,
    visuals: [],
    location: null,
    inReplyTo: null,
    isReaction: false,
    emailSubject: null,
    activityType: null,
    senderType: "user",
    senderId: 7,
    externalSenderName: null,
    imported: false,
    ...over,
  } as ChatwootMessageRow;
}

// An official-API inbox: the paired-phone marker is not trusted there.
const CLOUD = { whatsappProvider: "whatsapp_cloud" };
const anchorOf = (rows: ChatwootMessageRow[]) => findSnoozedAnchor(rows, CLOUD);
const spoke = (rows: ChatwootMessageRow[], baselineId: number) =>
  someoneSpokeAfter(rows, baselineId, CLOUD);

describe("snoozed ladder: what the live read decides", () => {
  test("a person's public message is the anchor; a note and the bot's own message are not", () => {
    const a = anchorOf([
      row({ id: 10, messageType: "incoming", senderType: "contact" }),
      row({ id: 11 }),
      row({ id: 12, private: true }),
      row({ id: 13, senderType: "agent_bot" }),
      row({ id: 14, messageType: "activity", senderType: null }),
    ]);
    expect(a?.messageId).toBe(11);
    expect(a?.customerSpokeAfter).toBe(false);
    expect(a?.newestMessageId).toBe(14);
  });

  test("the customer writing after the person's message is seen", () => {
    const a = anchorOf([
      row({ id: 11 }),
      row({ id: 12, messageType: "incoming", senderType: "contact" }),
    ]);
    expect(a?.customerSpokeAfter).toBe(true);
  });

  test("a user row the platform sent is not a person asking, nor a person answering", () => {
    const a = anchorOf([row({ id: 11 }), row({ id: 12, platformSent: true })]);
    expect(a?.messageId).toBe(11);
    expect(spoke([row({ id: 21, platformSent: true })], 20)).toBe(false);
  });

  test("no person's message on the page: no anchor", () => {
    expect(
      anchorOf([
        row({ id: 1, messageType: "incoming", senderType: "contact" }),
        row({ id: 2, senderType: "agent_bot" }),
      ]),
    ).toBeUndefined();
  });

  test("only a person or the customer speaking after the baseline counts", () => {
    expect(
      spoke(
        [
          row({ id: 21, senderType: "agent_bot" }),
          row({ id: 22, messageType: "activity", senderType: null }),
          row({ id: 23, private: true }),
        ],
        20,
      ),
    ).toBe(false);
    expect(spoke([row({ id: 21 })], 20)).toBe(true);
    expect(
      spoke(
        [row({ id: 21, messageType: "incoming", senderType: "contact" })],
        20,
      ),
    ).toBe(true);
    expect(spoke([row({ id: 19 })], 20)).toBe(false);
  });

  test("a voice note's request reaches the reminder through its transcription", () => {
    const a = anchorOf([
      row({
        id: 11,
        content: "",
        attachmentTypes: ["audio"],
        transcribedText: "me manda o número do pedido",
      }),
    ]);
    expect(a?.text).toContain("me manda o número do pedido");
    expect(a?.text).toContain("<atendente enviou um arquivo do tipo 'audio'>");
  });

  test("an operator's emoji reaction is neither a request nor an answer", () => {
    const a = anchorOf([
      row({ id: 11 }),
      row({ id: 12, messageType: "incoming", senderType: "contact" }),
      row({ id: 13, isReaction: true, content: "👍" }),
    ]);
    expect(a?.messageId).toBe(11);
    expect(a?.customerSpokeAfter).toBe(true);
    expect(spoke([row({ id: 21, isReaction: true })], 20)).toBe(false);
  });

  test("a reply typed on the paired phone counts where the provider reserves echo ids, only there", () => {
    const phone = (id: number) =>
      row({
        id,
        senderType: null,
        senderId: null,
        externalSenderName: "WhatsApp",
      });
    const baileys = { whatsappProvider: "baileys" };
    const a = findSnoozedAnchor([row({ id: 11 }), phone(12)], baileys);
    expect(a?.messageId).toBe(12);
    expect(someoneSpokeAfter([phone(21)], 20, baileys)).toBe(true);
    // An unreserved provider's echo of our own reply wears the same marker.
    expect(
      findSnoozedAnchor([row({ id: 11 }), phone(12)], {
        whatsappProvider: "zapi",
      })?.messageId,
    ).toBe(11);
    expect(spoke([phone(21)], 20)).toBe(false);
    // Old history the importer wrote with a new id is not a reply to anything live.
    expect(
      someoneSpokeAfter([{ ...phone(21), imported: true }], 20, baileys),
    ).toBe(false);
  });

  test("step 0 counts from the person's message, later steps from the previous step", () => {
    const at = new Date("2026-10-09T10:00:00Z");
    const p0 = snoozedLadderPosition({
      anchor: { messageId: 5, at },
      stored: { anchorId: null, step: null, at: null },
      delaysMin: [60, 120],
    });
    expect(p0).toEqual({
      stepIndex: 0,
      dueAt: new Date("2026-10-09T11:00:00Z"),
    });
    const ranAt = new Date("2026-10-09T11:05:00Z");
    const p1 = snoozedLadderPosition({
      anchor: { messageId: 5, at },
      stored: { anchorId: 5, step: 1, at: ranAt },
      delaysMin: [60, 120],
    });
    expect(p1).toEqual({
      stepIndex: 1,
      dueAt: new Date("2026-10-09T13:05:00Z"),
    });
    expect(
      snoozedLadderPosition({
        anchor: { messageId: 5, at },
        stored: { anchorId: 5, step: 2, at: ranAt },
        delaysMin: [60, 120],
      }),
    ).toEqual({ done: true });
  });

  test("a new message from the person starts the ladder over", () => {
    const at = new Date("2026-10-09T12:00:00Z");
    expect(
      snoozedLadderPosition({
        anchor: { messageId: 9, at },
        stored: { anchorId: 5, step: 2, at: new Date("2026-10-09T11:05:00Z") },
        delaysMin: [60, 120],
      }),
    ).toEqual({ stepIndex: 0, dueAt: new Date("2026-10-09T13:00:00Z") });
  });

  test("only a snooze with no end date, held by a person, is this ladder's", () => {
    const base = {
      status: "snoozed",
      assigneeType: "User",
      snoozedUntil: null,
    };
    expect(isSnoozedForAPerson(base)).toBe(true);
    expect(isSnoozedForAPerson({ ...base, snoozedUntil: new Date() })).toBe(
      false,
    );
    // An end date the read could not see is not a yes.
    expect(isSnoozedForAPerson({ ...base, snoozedUntil: undefined })).toBe(
      false,
    );
    expect(isSnoozedForAPerson({ ...base, assigneeType: "AgentBot" })).toBe(
      false,
    );
    expect(isSnoozedForAPerson({ ...base, assigneeType: null })).toBe(false);
    expect(isSnoozedForAPerson({ ...base, status: "open" })).toBe(false);
  });
});

describe("snoozed ladder: configuration", () => {
  test("off by default", () => {
    expect(readSnoozedFollowUpConfig({}).enabled).toBe(false);
    expect(readSnoozedFollowUpConfig({ snoozedFollowUp: {} })).toEqual({
      enabled: false,
      cadences: [],
      signature: false,
    });
  });

  test("the first cadence whose label the conversation has wins; else the default", () => {
    const cfg = readSnoozedFollowUpConfig({
      snoozedFollowUp: {
        enabled: true,
        cadences: [
          { label: null, steps: [{ delayValue: 24, delayUnit: "hours" }] },
          { label: "Followup-Fast", steps: [{ delayValue: 1 }] },
          {
            label: "followup-slow",
            steps: [{ delayValue: 3, delayUnit: "days" }],
          },
        ],
      },
    });
    expect(pickSnoozedCadence(cfg, ["followup-fast"])?.label).toBe(
      "Followup-Fast",
    );
    expect(
      pickSnoozedCadence(cfg, ["followup-slow", "followup-fast"])?.label,
    ).toBe("Followup-Fast");
    expect(pickSnoozedCadence(cfg, ["outra"])?.label).toBeNull();
    expect(pickSnoozedCadence(cfg, [])?.label).toBeNull();
  });

  test("no default and no matching label: nothing to chase", () => {
    const cfg = readSnoozedFollowUpConfig({
      snoozedFollowUp: {
        enabled: true,
        cadences: [{ label: "x", steps: [{ delayValue: 1 }] }],
      },
    });
    expect(pickSnoozedCadence(cfg, ["y"])).toBeNull();
  });

  test("a cadence without steps is dropped, and resolve stays on the last step only", () => {
    const cfg = readSnoozedFollowUpConfig({
      snoozedFollowUp: {
        enabled: true,
        cadences: [
          { label: "vazia", steps: [] },
          {
            label: null,
            steps: [
              { delayValue: 1, resolve: true },
              { delayValue: 1, resolve: true },
            ],
          },
        ],
      },
    });
    expect(cfg.cadences).toHaveLength(1);
    expect(cfg.cadences[0]?.steps[0]?.resolve).toBeUndefined();
    expect(cfg.cadences[0]?.steps[1]?.resolve).toBe(true);
  });
});

// Records every message the model is handed, whatever its role: where the nudge puts its directive is
// not this file's business, only that the person's words are in it.
class AllMessagesModel extends BaseChatModel {
  constructor(
    private readonly reply: string,
    private readonly seen: string[],
  ) {
    super({});
  }
  _llmType() {
    return "fake-all-messages";
  }
  override bindTools(_tools: BindToolsInput[]) {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages.map((m) => String(m.content)).join("\n"));
    return {
      generations: [{ text: this.reply, message: new AIMessage(this.reply) }],
    };
  }
}

// ── the handler, against the database and a stubbed Chatwoot ─────────────────────────────────────

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

let phantomJobId = 0n;
let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;
let whatsappInboxDbId = 0n;
let agentId = 0n;
const PERSON = 7;
const REPLY = "Oi! Ainda precisamos do número do pedido para seguir.";

const STEPS = [
  { delayValue: 2, delayUnit: "minutes", instructions: "lembre o pedido" },
  { delayValue: 2, delayUnit: "minutes", instructions: "lembre de novo" },
  {
    delayValue: 2,
    delayUnit: "minutes",
    instructions: "",
    resolve: true,
    assignLabels: ["sem-retorno"],
  },
];

function threadOf(convId: number) {
  return `${tenantId}:${instanceId}:${convId}`;
}

function jobFor(
  convId: number,
  extra: Record<string, unknown> = {},
): ClaimedJob {
  return {
    id: phantomJobId,
    tenantId,
    kind: "SNOOZED_FOLLOWUP",
    payload: { threadId: threadOf(convId), ...extra },
    attempts: 0,
    claimSeq: 0,
  };
}

type Msg = {
  id: number;
  message_type: number;
  private?: boolean;
  created_at: number;
  sender?: { type: string; id: number } | null;
  content?: string;
};

function stub(over: {
  status?: string;
  assigneeType?: string | null;
  snoozedUntil?: string | null;
  labels?: string[];
  messages: Msg[];
  // A message that lands while the model runs, seen by the send-time check.
  lateMessage?: Msg;
  // The status every read after the first one sees: the handler's read finds it snoozed, the
  // nudge's own probe finds what changed meanwhile.
  statusLater?: string;
  // The send-time read answers a body that is not a message list.
  degradedAfter?: boolean;
  // The handler's own page read answers a body that is not a message list.
  degradedPage?: boolean;
  // The conversation payload carries no `snoozed_until` key at all.
  omitSnoozedUntil?: boolean;
  // Only the reads after the handler's first one carry no `snoozed_until`.
  omitSnoozedUntilLater?: boolean;
  // Runs inside the send, after every ask that precedes it.
  onSend?: () => Promise<void>;
  model?: (cfg: {
    model: string;
  }) => import("@langchain/core/language_models/chat_models").BaseChatModel;
}) {
  const sent: string[] = [];
  const toggles: string[] = [];
  const labelSets: string[][] = [];
  const notes: string[] = [];
  let currentLabels = over.labels ?? [];
  // Shown only once the model is GENERATING: after every ask that precedes the invoke, so only a
  // check at the send boundary can see it.
  let lateVisible = false;
  let reads = 0;
  const client = {
    getConversation: async (c: number) => {
      const later = reads++ > 0;
      return {
        id: c,
        status:
          later && over.statusLater
            ? over.statusLater
            : (over.status ?? "snoozed"),
        ...(over.omitSnoozedUntil || (later && over.omitSnoozedUntilLater)
          ? {}
          : {
              snoozed_until:
                over.snoozedUntil === undefined ? null : over.snoozedUntil,
            }),
        labels: currentLabels,
        meta:
          over.assigneeType === null
            ? {}
            : {
                assignee_type: over.assigneeType ?? "User",
                assignee: { id: over.assigneeType === "AgentBot" ? 5 : PERSON },
              },
      };
    },
    getMessages: async (
      _c: number,
      opts?: { before?: number; after?: number },
    ) => {
      if (opts?.after !== undefined) {
        if (over.degradedAfter) return { error: "upstream" };
        const late = lateVisible && over.lateMessage ? [over.lateMessage] : [];
        return {
          payload: [...over.messages, ...late].filter(
            (m) => m.id > (opts.after as number),
          ),
        };
      }
      if (over.degradedPage) return { error: "upstream" };
      if (opts?.before !== undefined) return { payload: [] };
      return { payload: over.messages };
    },
    sendMessage: async (_c: number, t: string) => {
      sent.push(t);
      await over.onSend?.();
      return { id: 999 };
    },
    sendPrivateNote: async (_c: number, t: string) => {
      notes.push(t);
      return {};
    },
    getConversationLabels: async () => currentLabels,
    setConversationLabels: async (_c: number, labels: string[]) => {
      currentLabels = labels;
      labelSets.push(labels);
      return {};
    },
    toggleStatus: async (_c: number, status: string) => {
      toggles.push(status);
      return {};
    },
  } as unknown as ChatwootClient;
  return {
    sent,
    toggles,
    labelSets,
    notes,
    deps: {
      makeModel: (cfg: { model: string }) =>
        over.model?.(cfg) ??
        (over.lateMessage
          ? new SideEffectModel(async () => {
              lateVisible = true;
            }, REPLY)
          : new FakeListChatModel({ responses: [REPLY] })),
      makeClient: async () => client,
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
    },
  };
}

const minutesAgo = (m: number) => Math.floor((Date.now() - m * 60_000) / 1000);

async function seed(
  convId: number,
  over: {
    status?: string;
    assigneeType?: string | null;
    anchorId?: number | null;
    step?: number | null;
    at?: Date | null;
    lastEventAt?: Date;
    contactInboxId?: number;
    whatsapp?: boolean;
    lastInboundAt?: Date;
    // Chatwoot's conversation version (epoch seconds), moved by a status or holder change.
    statusAt?: number;
    resetAtMessageId?: number;
  } = {},
) {
  const data = {
    status: over.status ?? "snoozed",
    assigneeType: over.assigneeType === undefined ? "User" : over.assigneeType,
    assigneeId: PERSON,
    lastEventAt: over.lastEventAt ?? new Date(Date.now() - 60_000),
    snoozedFollowUpAnchorId: over.anchorId ?? null,
    snoozedFollowUpStep: over.step ?? null,
    snoozedFollowUpAt: over.at ?? null,
    contactInboxId: over.contactInboxId ?? null,
    inboxId: over.whatsapp ? whatsappInboxDbId : inboxDbId,
    ...(over.lastInboundAt ? { lastInboundAt: over.lastInboundAt } : {}),
    chatwootStatusAt: over.statusAt ?? null,
    resetAtMessageId: over.resetAtMessageId ?? null,
  };
  await suDb.conversation.upsert({
    where: {
      tenantId_chatwootInstanceId_chatwootConversationId: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
      },
    },
    create: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      threadId: threadOf(convId),
      ...data,
    },
    update: data,
  });
}

async function stateOf(convId: number) {
  return suDb.conversation.findFirstOrThrow({
    where: { tenantId, chatwootConversationId: convId },
    select: {
      snoozedFollowUpAnchorId: true,
      snoozedFollowUpStep: true,
      status: true,
    },
  });
}

async function setSettings(settings: Record<string, unknown>) {
  await suDb.agent.update({
    where: { id: agentId },
    data: { settings: settings as never },
  });
}

const LADDER = {
  snoozedFollowUp: {
    enabled: true,
    signature: false,
    cadences: [{ label: null, steps: STEPS }],
  },
  // The bot's own signature is on, so a reminder that carries it would show.
  signature: { enabled: true, text: "Atenciosamente, Gi", frequency: "all" },
};

describe.skipIf(!dbUp)("snoozed ladder: the handler", () => {
  beforeAll(async () => {
    phantomJobId = await burnSchedulerJobId(suDb);
    const t = await suDb.tenant.create({
      data: { name: "SNZ", slug: `snz-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 5,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const llmKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é prestativa.",
        snoozedFollowUpArmedAt: new Date(Date.now() - 30 * 86_400_000),
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${llmKey.id}`,
        },
        settings: LADDER,
      },
    });
    agentId = agent.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: 5,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `snz-route-${process.pid}`,
        name: "Atendente",
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 77,
        name: "E-mail",
        agentId,
        channelType: "Channel::Email",
      },
    });
    inboxDbId = inbox.id;
    const wa = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 78,
        name: "WhatsApp",
        agentId,
        // Official WhatsApp, so the 24h window applies.
        channelType: "Channel::Whatsapp",
        provider: "whatsapp_cloud",
      },
    });
    whatsappInboxDbId = wa.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "scheduler_jobs",
        "llm_usage",
        "conversations",
        "inboxes",
        "chatwoot_agent_bots",
        "agents",
        "business_hours",
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

  const personAsked = (id: number, minutes: number): Msg => ({
    id,
    message_type: 1,
    created_at: minutesAgo(minutes),
    sender: { type: "user", id: PERSON },
    content: "Pode me mandar o número do pedido?",
  });

  test("step 1 goes out once due, unsigned, and the conversation is left as it was", async () => {
    await setSettings(LADDER);
    await seed(2001);
    const s = stub({ messages: [personAsked(100, 3)] });
    const r = await snoozedFollowUpHandler(jobFor(2001), appDb, s.deps);
    expect(s.sent).toEqual([REPLY]);
    // No status change: still snoozed, still the person's.
    expect(s.toggles).toEqual([]);
    expect(r.outcome).toBe("reschedule");
    const st = await stateOf(2001);
    expect(st.snoozedFollowUpAnchorId).toBe(100);
    expect(st.snoozedFollowUpStep).toBe(1);
  });

  test("the flow line records the snoozed origin, so the console badges it apart", async () => {
    await setSettings(LADDER);
    await seed(2043);
    const s = stub({ messages: [personAsked(360, 3)] });
    await snoozedFollowUpHandler(jobFor(2043), appDb, s.deps);
    expect(s.sent).toEqual([REPLY]);
    let origin: unknown = null;
    for (let i = 0; i < 30 && origin === null; i++) {
      const rows = await flowLogRows(suDb, {
        where: { tenantId, stage: "generate", threadId: threadOf(2043) },
        select: { detail: true },
      });
      const hit = rows
        .map((r) => r.detail as Record<string, unknown> | null)
        .find((d) => typeof d?.outcome === "string");
      if (hit) origin = hit.origin;
      else await new Promise((r) => setTimeout(r, 100));
    }
    expect(origin).toBe("snoozed");
  });

  test("not yet due: rescheduled to the due instant, nothing sent", async () => {
    await setSettings(LADDER);
    await seed(2002);
    const s = stub({ messages: [personAsked(110, 1)] });
    const r = await snoozedFollowUpHandler(jobFor(2002), appDb, s.deps);
    expect(s.sent).toEqual([]);
    expect(r.outcome).toBe("reschedule");
    if (r.outcome === "reschedule") {
      const due = (minutesAgo(1) + 120) * 1000;
      expect(Math.abs(r.runAt.getTime() - due)).toBeLessThan(2_000);
    }
  });

  test("the last step labels and resolves, and the ladder then ends", async () => {
    await setSettings(LADDER);
    await seed(2003, {
      anchorId: 120,
      step: 2,
      at: new Date(Date.now() - 3 * 60_000),
    });
    const s = stub({ messages: [personAsked(120, 10)] });
    const r = await snoozedFollowUpHandler(jobFor(2003), appDb, s.deps);
    // The closing step has no instructions: no model, no message, only its post-actions.
    expect(s.sent).toEqual([]);
    expect(s.labelSets.at(-1)).toContain("sem-retorno");
    expect(s.toggles).toEqual(["resolved"]);
    expect(r).toEqual({ outcome: "done" });
  });

  test("a snooze with an end date is not chased", async () => {
    await setSettings(LADDER);
    await seed(2004);
    const s = stub({
      snoozedUntil: new Date(Date.now() + 3_600_000).toISOString(),
      messages: [personAsked(130, 10)],
    });
    const r = await snoozedFollowUpHandler(jobFor(2004), appDb, s.deps);
    expect(r).toEqual({ outcome: "done" });
    expect(s.sent).toEqual([]);
  });

  test("a conversation the bot holds, or nobody holds, is not chased", async () => {
    await setSettings(LADDER);
    for (const [conv, holder] of [
      [2005, "AgentBot"],
      [2006, null],
    ] as const) {
      await seed(conv);
      const s = stub({
        assigneeType: holder,
        messages: [personAsked(140, 10)],
      });
      const r = await snoozedFollowUpHandler(jobFor(conv), appDb, s.deps);
      expect(r).toEqual({ outcome: "done" });
      expect(s.sent).toEqual([]);
    }
  });

  test("the customer having written after the person: no reminder", async () => {
    await setSettings(LADDER);
    await seed(2007);
    const s = stub({
      messages: [
        personAsked(150, 10),
        {
          id: 151,
          message_type: 0,
          created_at: minutesAgo(5),
          sender: { type: "contact", id: 1 },
        },
      ],
    });
    const r = await snoozedFollowUpHandler(jobFor(2007), appDb, s.deps);
    expect(r).toEqual({ outcome: "done" });
    expect(s.sent).toEqual([]);
  });

  test("a person writing while the model runs stops the reminder", async () => {
    await setSettings(LADDER);
    await seed(2008);
    const s = stub({
      messages: [personAsked(160, 10)],
      lateMessage: {
        id: 161,
        message_type: 1,
        created_at: minutesAgo(0),
        sender: { type: "user", id: PERSON },
      },
    });
    await snoozedFollowUpHandler(jobFor(2008), appDb, s.deps);
    expect(s.sent).toEqual([]);
  });

  test("a person's message older than the switch-on is not chased", async () => {
    await suDb.agent.update({
      where: { id: agentId },
      data: { snoozedFollowUpArmedAt: new Date(Date.now() - 5 * 60_000) },
    });
    try {
      await setSettings(LADDER);
      await seed(2009);
      const s = stub({ messages: [personAsked(170, 10)] });
      const r = await snoozedFollowUpHandler(jobFor(2009), appDb, s.deps);
      expect(r).toEqual({ outcome: "done" });
      expect(s.sent).toEqual([]);
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: {
          snoozedFollowUpArmedAt: new Date(Date.now() - 30 * 86_400_000),
        },
      });
    }
  });

  test("the ladder switched off: nothing", async () => {
    await setSettings({
      snoozedFollowUp: { ...LADDER.snoozedFollowUp, enabled: false },
    });
    await seed(2010);
    const s = stub({ messages: [personAsked(180, 10)] });
    const r = await snoozedFollowUpHandler(jobFor(2010), appDb, s.deps);
    expect(r).toEqual({ outcome: "done" });
    expect(s.sent).toEqual([]);
    await setSettings(LADDER);
  });

  test("the sweep nominates a snoozed conversation a person holds, once", async () => {
    await setSettings(LADDER);
    await seed(2011);
    await seed(2012, { status: "pending", assigneeType: null });
    await seed(2013, { status: "snoozed", assigneeType: "AgentBot" });
    await sweepSnoozedFollowUps(appDb, tenantId, [agentId]);
    await sweepSnoozedFollowUps(appDb, tenantId, [agentId]);
    const jobs = await suDb.schedulerJob.findMany({
      where: { tenantId, kind: "SNOOZED_FOLLOWUP" },
      select: { dedupeKey: true },
    });
    const keys = jobs.map((j) => j.dedupeKey);
    expect(keys).toContain(snoozedDedupeKey(threadOf(2011)));
    expect(keys).not.toContain(snoozedDedupeKey(threadOf(2012)));
    expect(keys).not.toContain(snoozedDedupeKey(threadOf(2013)));
    expect(
      keys.filter((k) => k === snoozedDedupeKey(threadOf(2011))),
    ).toHaveLength(1);
  });

  test("the sweep leaves an agent with the ladder off alone", async () => {
    await seed(2014);
    await sweepSnoozedFollowUps(appDb, tenantId, []);
    const n = await suDb.schedulerJob.count({
      where: {
        tenantId,
        kind: "SNOOZED_FOLLOWUP",
        dedupeKey: snoozedDedupeKey(threadOf(2014)),
      },
    });
    expect(n).toBe(0);
  });
  test("the reminder is written with no tool bound, so it cannot act over the person", async () => {
    await setSettings(LADDER);
    await seed(2015);
    const model = new ToolRecordingModel(REPLY);
    const s = stub({ messages: [personAsked(190, 3)], model: () => model });
    await snoozedFollowUpHandler(jobFor(2015), appDb, s.deps);
    expect(s.sent).toEqual([REPLY]);
    expect(model.boundToolNames ?? []).toEqual([]);
  });

  test("the cadence named by the conversation's label sets the pace", async () => {
    const fastAndSlow = {
      ...LADDER,
      snoozedFollowUp: {
        ...LADDER.snoozedFollowUp,
        cadences: [
          { label: null, steps: STEPS },
          {
            label: "adiar-rapido",
            steps: [{ delayValue: 1, delayUnit: "minutes", instructions: "x" }],
          },
        ],
      },
    };
    await setSettings(fastAndSlow);
    try {
      // 90 s after the person's message: due on the 1-minute cadence, not on the 2-minute default.
      await seed(2016);
      const plain = stub({ messages: [personAsked(200, 1.5)] });
      await snoozedFollowUpHandler(jobFor(2016), appDb, plain.deps);
      expect(plain.sent).toEqual([]);
      await seed(2017);
      const fast = stub({
        labels: ["adiar-rapido"],
        messages: [personAsked(210, 1.5)],
      });
      await snoozedFollowUpHandler(jobFor(2017), appDb, fast.deps);
      expect(fast.sent).toEqual([REPLY]);
    } finally {
      await setSettings(LADDER);
    }
  });

  test("the sweep leaves a parked job's time alone while the conversation has not moved", async () => {
    await setSettings(LADDER);
    await seed(2018, { lastEventAt: new Date(Date.now() - 10 * 60_000) });
    await sweepSnoozedFollowUps(appDb, tenantId, [agentId]);
    const later = new Date(Date.now() + 3_600_000);
    await suDb.schedulerJob.updateMany({
      where: { tenantId, dedupeKey: snoozedDedupeKey(threadOf(2018)) },
      data: { runAt: later },
    });
    await sweepSnoozedFollowUps(appDb, tenantId, [agentId]);
    const job = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, dedupeKey: snoozedDedupeKey(threadOf(2018)) },
      select: { runAt: true },
    });
    expect(job.runAt.getTime()).toBe(later.getTime());
    // The conversation moved after the job was parked: the sweep asks the handler to look again.
    await seed(2018, { lastEventAt: new Date(Date.now() + 1_000) });
    await sweepSnoozedFollowUps(appDb, tenantId, [agentId]);
    const again = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, dedupeKey: snoozedDedupeKey(threadOf(2018)) },
      select: { runAt: true },
    });
    expect(again.runAt.getTime()).toBeLessThan(later.getTime());
  });
  test("a guardrail that would hand the reminder over drops it, and the person keeps the conversation", async () => {
    const key = await suDb.vaultEntry.findFirstOrThrow({
      where: { tenantId, name: "llm-key" },
      select: { id: true },
    });
    await setSettings({
      ...LADDER,
      handoff: { mode: "route" },
      guardrails: {
        credentialRef: `vault:${key.id}`,
        enabled: true,
        provider: "openai",
        model: "guard-sentinel-snoozed",
        input: { enabled: false },
        output: {
          enabled: true,
          action: "handoff",
          handoffMessage: "ENCAMINHADO",
          checks: {
            toxicity: true,
            unsafeContent: false,
            competitorMentions: false,
            promptAdherence: false,
          },
        },
      },
    });
    try {
      await seed(2019);
      const s = stub({
        messages: [personAsked(220, 3)],
        model: (cfg) =>
          cfg.model === "guard-sentinel-snoozed"
            ? guardrailModel(async () => ({
                content: JSON.stringify({
                  violated: true,
                  categories: ["toxicity"],
                  rationale: "x",
                }),
              }))
            : new FakeListChatModel({ responses: [REPLY] }),
      });
      await snoozedFollowUpHandler(jobFor(2019), appDb, s.deps);
      // Neither the refused text nor the hand-over line, and no transfer.
      expect(s.sent).toEqual([]);
      expect(s.toggles).toEqual([]);
      expect((await stateOf(2019)).snoozedFollowUpStep).toBe(1);
    } finally {
      await setSettings(LADDER);
    }
  });
  test("unsnoozed between the handler's read and the send: the nudge's own probe stops it", async () => {
    await setSettings(LADDER);
    await seed(2020);
    const s = stub({ messages: [personAsked(230, 3)], statusLater: "open" });
    await snoozedFollowUpHandler(jobFor(2020), appDb, s.deps);
    expect(s.sent).toEqual([]);
  });
  test("an event during a run that then completed is still swept: the watermark is the run's start", async () => {
    await setSettings(LADDER);
    const started = new Date(Date.now() - 60_000);
    // The person wrote 30 s into a run that completed afterwards.
    await seed(2021, { lastEventAt: new Date(Date.now() - 30_000) });
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "SNOOZED_FOLLOWUP",
        dedupeKey: snoozedDedupeKey(threadOf(2021)),
        runAt: started,
        claimedAt: started,
        status: "DONE",
        payload: { threadId: threadOf(2021) },
      },
    });
    await sweepSnoozedFollowUps(appDb, tenantId, [agentId]);
    const job = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, dedupeKey: snoozedDedupeKey(threadOf(2021)) },
      select: { status: true },
    });
    expect(job.status).toBe("PENDING");
  });

  // Both places the note is written: the thread keyed by conversation, and the one keyed by contact
  // inbox, which is a separate block.
  for (const [conv, contactInbox] of [
    [2022, null],
    [2023, 88_023],
  ] as const) {
    test(`a reminder after a past hand-over records no hand-back (contact inbox ${contactInbox})`, async () => {
      await setSettings(LADDER);
      await seed(
        conv,
        contactInbox === null ? {} : { contactInboxId: contactInbox },
      );
      const checkpointer = new MemorySaver();
      const graphThread =
        contactInbox === null
          ? threadOf(conv)
          : contactInboxThreadId(tenantId, instanceId, contactInbox);
      await buildThreadStateGraph(checkpointer).updateState(
        { configurable: { thread_id: graphThread } },
        {
          messages: [
            new ToolMessage({
              content: `${HANDOFF_DONE_PREFIX} (status set to open).`,
              tool_call_id: "h1",
              name: "handoff_to_human",
            }),
          ],
        },
        THREAD_STATE_NODE,
      );
      const s = stub({ messages: [personAsked(conv * 10, 3)] });
      await snoozedFollowUpHandler(jobFor(conv), appDb, {
        ...s.deps,
        checkpointer,
      });
      expect(s.sent).toEqual([REPLY]);
      const cp = await checkpointer.get({
        configurable: { thread_id: graphThread },
      });
      const messages = ((cp?.channel_values as { messages?: BaseMessage[] })
        ?.messages ?? []) as BaseMessage[];
      expect(
        messages.some((m) => String(m.content) === HUMAN_HANDBACK_NOTE),
      ).toBe(false);
    });
  }
  test("a reminder the closed WhatsApp window kept from the customer ends the ladder, unresolved", async () => {
    await setSettings(LADDER);
    await seed(2024, {
      whatsapp: true,
      lastInboundAt: new Date(Date.now() - 3 * 86_400_000),
    });
    const s = stub({ messages: [personAsked(250, 3)] });
    const r = await snoozedFollowUpHandler(jobFor(2024), appDb, s.deps);
    expect(s.sent).toEqual([]);
    expect(r).toEqual({ outcome: "done" });
    // The step is not spent: nothing reached the customer, and a later closing step must not run.
    // The ladder is spent on this message of the person: no later closing step runs.
    expect((await stateOf(2024)).snoozedFollowUpStep).toBe(STEPS.length);
    expect(s.notes).toHaveLength(1);
    // The note is an event the sweep re-arms on; the re-armed run writes nothing more.
    const again = stub({ messages: [personAsked(250, 3)] });
    await snoozedFollowUpHandler(jobFor(2024), appDb, again.deps);
    expect(again.notes).toEqual([]);
    expect(again.sent).toEqual([]);
  });

  test("a degraded message page is a failed read, not silence", async () => {
    await setSettings(LADDER);
    await seed(2025);
    const s = stub({ messages: [personAsked(260, 3)], degradedAfter: true });
    const r = await snoozedFollowUpHandler(jobFor(2025), appDb, s.deps);
    expect(s.sent).toEqual([]);
    // Tried again, not dropped.
    expect(r.outcome).toBe("reschedule");
  });

  test("an unreadable conversation, or a snooze whose end date is missing, is tried again", async () => {
    await setSettings(LADDER);
    await seed(2034);
    const garbled = stub({ messages: [personAsked(290, 3)] });
    const client = await garbled.deps.makeClient();
    (
      client as unknown as { getConversation: () => Promise<unknown> }
    ).getConversation = async () => "<html>bad gateway</html>";
    const r1 = await snoozedFollowUpHandler(jobFor(2034), appDb, {
      ...garbled.deps,
      makeClient: async () => client,
    });
    expect(r1.outcome).toBe("reschedule");
    const noEnd = stub({
      messages: [personAsked(290, 3)],
      omitSnoozedUntil: true,
    });
    const r2 = await snoozedFollowUpHandler(jobFor(2034), appDb, noEnd.deps);
    expect(r2.outcome).toBe("reschedule");
    expect([...garbled.sent, ...noEnd.sent]).toEqual([]);
  });

  test("the end date going missing between the handler's read and the send is tried again", async () => {
    await setSettings(LADDER);
    await seed(2035);
    const s = stub({
      messages: [personAsked(300, 3)],
      omitSnoozedUntilLater: true,
    });
    const r = await snoozedFollowUpHandler(jobFor(2035), appDb, s.deps);
    expect(s.sent).toEqual([]);
    expect(r.outcome).toBe("reschedule");
  });

  test("a degraded page on the handler's own read is tried again, not taken as no anchor", async () => {
    await setSettings(LADDER);
    await seed(2027);
    const s = stub({ messages: [personAsked(280, 3)], degradedPage: true });
    const r = await snoozedFollowUpHandler(jobFor(2027), appDb, s.deps);
    expect(s.sent).toEqual([]);
    expect(r.outcome).toBe("reschedule");
  });

  test("the person's request reaches the model with the reminder", async () => {
    await setSettings(LADDER);
    await seed(2026);
    const seen: string[] = [];
    const long = `${"Contexto do atendimento. ".repeat(40)}Pode me mandar a foto do documento?`;
    const s = stub({
      messages: [{ ...personAsked(270, 3), content: long }],
      model: () => new AllMessagesModel(REPLY, seen),
    });
    await snoozedFollowUpHandler(jobFor(2026), appDb, s.deps);
    expect(s.sent).toEqual([REPLY]);
    // Framed as a reminder that is due, not as an event a model may judge a duplicate of the last one.
    expect(seen.join("\n")).toContain("never a reason to stay silent");
    // Whole, even past the summary's cap: the ask at the end of a long message reaches the model.
    expect(seen.join("\n")).toContain("Pode me mandar a foto do documento?");
  });
  async function finishedJob(
    conv: number,
    status: "DONE" | "DEAD",
    claimedAt: Date,
  ) {
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "SNOOZED_FOLLOWUP",
        dedupeKey: snoozedDedupeKey(threadOf(conv)),
        runAt: claimedAt,
        claimedAt,
        status,
        attempts: status === "DEAD" ? 5 : 0,
        payload: { threadId: threadOf(conv) },
      },
    });
  }

  test("a status or holder change after the last run re-arms, though no message moved", async () => {
    await setSettings(LADDER);
    // The run started after the agent's last edit, so only the conversation can re-arm it.
    const claimed = new Date(Date.now() + 1_000);
    // The last message is older than the run; the snooze changed (dated to indefinite) after it.
    await seed(2028, {
      lastEventAt: new Date(Date.now() - 10 * 60_000),
      statusAt: (Date.now() + 30_000) / 1000,
    });
    await finishedJob(2028, "DONE", claimed);
    // And one whose status moved BEFORE the run: left alone.
    await seed(2029, {
      lastEventAt: new Date(Date.now() - 10 * 60_000),
      statusAt: (Date.now() - 5 * 60_000) / 1000,
    });
    await finishedJob(2029, "DONE", claimed);
    await sweepSnoozedFollowUps(appDb, tenantId, [agentId]);
    const statusOf = async (conv: number) =>
      (
        await suDb.schedulerJob.findFirstOrThrow({
          where: { tenantId, dedupeKey: snoozedDedupeKey(threadOf(conv)) },
          select: { status: true },
        })
      ).status;
    expect(await statusOf(2028)).toBe("PENDING");
    expect(await statusOf(2029)).toBe("DONE");
  });

  test("the status version is compared in UTC whatever the session's zone", async () => {
    // The same status-only move as above, swept over a connection whose session zone is not UTC.
    const url = new URL(process.env.TEST_APP_DATABASE_URL as string);
    url.searchParams.set("options", "-c TimeZone=America/Sao_Paulo");
    const tzApp = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url.toString() }),
    });
    try {
      await setSettings(LADDER);
      await seed(2031, {
        lastEventAt: new Date(Date.now() - 10 * 60_000),
        statusAt: (Date.now() + 30_000) / 1000,
      });
      await finishedJob(2031, "DONE", new Date(Date.now() + 1_000));
      await sweepSnoozedFollowUps(tzApp, tenantId, [agentId]);
      const job = await suDb.schedulerJob.findFirstOrThrow({
        where: { tenantId, dedupeKey: snoozedDedupeKey(threadOf(2031)) },
        select: { status: true },
      });
      expect(job.status).toBe("PENDING");
    } finally {
      await tzApp.$disconnect();
    }
  });

  test("an edit of the agent after the last run re-arms: the cadence may now apply", async () => {
    await setSettings(LADDER);
    await seed(2032, { lastEventAt: new Date(Date.now() - 10 * 60_000) });
    await finishedJob(2032, "DONE", new Date(Date.now() - 60_000));
    await sweepSnoozedFollowUps(appDb, tenantId, [agentId]);
    // setSettings above bumped the agent's updated_at after the job's run: re-armed.
    const job = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, dedupeKey: snoozedDedupeKey(threadOf(2032)) },
      select: { status: true },
    });
    expect(job.status).toBe("PENDING");
  });

  test("an edit of the agent's schedule after the last run re-arms", async () => {
    await setSettings(LADDER);
    const hours = await suDb.businessHours.create({
      data: { tenantId, name: "Comercial" },
    });
    await suDb.agent.update({
      where: { id: agentId },
      data: { followUpHoursId: hours.id },
    });
    try {
      await seed(2033, { lastEventAt: new Date(Date.now() - 10 * 60_000) });
      // The run started after the agent's edit; then the schedule changed.
      await finishedJob(2033, "DONE", new Date(Date.now() + 1_000));
      await sweepSnoozedFollowUps(appDb, tenantId, [agentId]);
      const before = await suDb.schedulerJob.findFirstOrThrow({
        where: { tenantId, dedupeKey: snoozedDedupeKey(threadOf(2033)) },
        select: { status: true },
      });
      expect(before.status).toBe("DONE");
      await suDb.businessHours.update({
        where: { id: hours.id },
        data: { name: "Comercial 2", updatedAt: new Date(Date.now() + 5_000) },
      });
      await sweepSnoozedFollowUps(appDb, tenantId, [agentId]);
      const after = await suDb.schedulerJob.findFirstOrThrow({
        where: { tenantId, dedupeKey: snoozedDedupeKey(threadOf(2033)) },
        select: { status: true },
      });
      expect(after.status).toBe("PENDING");
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { followUpHoursId: null },
      });
    }
  });

  test("a new message of the person starts the refusal budget over", async () => {
    await setSettings(LADDER);
    const agent = await suDb.agent.findUniqueOrThrow({
      where: { id: agentId },
      select: { modelConfig: true },
    });
    // A credential that does not resolve: the nudge refuses with a repairable `agent-unavailable`.
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        modelConfig: {
          ...(agent.modelConfig as Record<string, unknown>),
          credentialRef: "vault:999999999",
        },
      },
    });
    try {
      await seed(2036);
      const s = stub({ messages: [personAsked(310, 3)] });
      // Seven refusals spent on an EARLIER message of the person.
      const r = await snoozedFollowUpHandler(
        jobFor(2036, { nudgeRetries: 7, nudgeRetriesAnchorId: 305 }),
        appDb,
        s.deps,
      );
      expect(r.outcome).toBe("reschedule");
      if (r.outcome === "reschedule") {
        expect(r.payload).toMatchObject({
          nudgeRetries: 1,
          nudgeRetriesAnchorId: 310,
        });
      }
      // The same seven on THIS message: the budget is spent.
      const spent = await snoozedFollowUpHandler(
        jobFor(2036, { nudgeRetries: 7, nudgeRetriesAnchorId: 310 }),
        appDb,
        s.deps,
      );
      expect(spent).toEqual({ outcome: "done" });
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { modelConfig: agent.modelConfig as never },
      });
    }
  });

  test("a new responder bound to the inbox after the last run re-arms", async () => {
    await setSettings(LADDER);
    await seed(2037, { lastEventAt: new Date(Date.now() - 10 * 60_000) });
    await finishedJob(2037, "DONE", new Date(Date.now() + 1_000));
    await sweepSnoozedFollowUps(appDb, tenantId, [agentId]);
    const statusOf = async () =>
      (
        await suDb.schedulerJob.findFirstOrThrow({
          where: { tenantId, dedupeKey: snoozedDedupeKey(threadOf(2037)) },
          select: { status: true },
        })
      ).status;
    expect(await statusOf()).toBe("DONE");
    await suDb.inbox.update({
      where: { id: inboxDbId },
      data: { responderBoundAt: new Date(Date.now() + 5_000) },
    });
    try {
      await sweepSnoozedFollowUps(appDb, tenantId, [agentId]);
      expect(await statusOf()).toBe("PENDING");
    } finally {
      await suDb.inbox.update({
        where: { id: inboxDbId },
        data: { responderBoundAt: null },
      });
    }
  });

  test("a message of the person at or below a /reset is not chased, whatever re-armed the job", async () => {
    await setSettings(LADDER);
    await seed(2038, { resetAtMessageId: 320 });
    const s = stub({ messages: [personAsked(320, 3)] });
    const r = await snoozedFollowUpHandler(jobFor(2038), appDb, s.deps);
    expect(r).toEqual({ outcome: "done" });
    expect(s.sent).toEqual([]);
    // A message after the command is a new request, and is chased.
    await seed(2039, { resetAtMessageId: 320 });
    const after = stub({ messages: [personAsked(321, 3)] });
    await snoozedFollowUpHandler(jobFor(2039), appDb, after.deps);
    expect(after.sent).toEqual([REPLY]);
  });

  test("a step retired while it sent does not record its progress", async () => {
    await setSettings(LADDER);
    await seed(2040);
    const row = await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "SNOOZED_FOLLOWUP",
        dedupeKey: snoozedDedupeKey(threadOf(2040)),
        runAt: new Date(),
        status: "CLAIMED",
        claimSeq: 1,
        payload: { threadId: threadOf(2040) },
      },
    });
    const s = stub({
      messages: [personAsked(330, 3)],
      // The /reset lands while the reminder is on the wire.
      onSend: async () => {
        await suDb.schedulerJob.update({
          where: { id: row.id },
          data: { claimSeq: 2, status: "DONE" },
        });
      },
    });
    await snoozedFollowUpHandler(
      { ...jobFor(2040), id: row.id, claimSeq: 1 },
      appDb,
      s.deps,
    );
    expect(s.sent).toEqual([REPLY]);
    expect((await stateOf(2040)).snoozedFollowUpStep).toBeNull();
  });

  test("the step's time is stored in UTC whatever the session's zone", async () => {
    const url = new URL(process.env.TEST_APP_DATABASE_URL as string);
    url.searchParams.set("options", "-c TimeZone=Asia/Tokyo");
    const tzApp = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url.toString() }),
    });
    try {
      await setSettings(LADDER);
      await seed(2042);
      const s = stub({ messages: [personAsked(350, 3)] });
      await snoozedFollowUpHandler(jobFor(2042), tzApp, s.deps);
      expect(s.sent).toEqual([REPLY]);
      const row = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: 2042 },
        select: { snoozedFollowUpAt: true },
      });
      // Within a minute of now, not nine hours off.
      expect(
        Math.abs((row.snoozedFollowUpAt as Date).getTime() - Date.now()),
      ).toBeLessThan(60_000);
    } finally {
      await tzApp.$disconnect();
    }
  });

  test("a waiting row re-armed by an unrelated event keeps its refusal budget", async () => {
    await setSettings(LADDER);
    await seed(2041, { lastEventAt: new Date(Date.now() + 5_000) });
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "SNOOZED_FOLLOWUP",
        dedupeKey: snoozedDedupeKey(threadOf(2041)),
        runAt: new Date(Date.now() + 900_000),
        status: "PENDING",
        payload: {
          threadId: threadOf(2041),
          nudgeRetries: 3,
          nudgeRetriesAnchorId: 340,
        },
      },
    });
    await sweepSnoozedFollowUps(appDb, tenantId, [agentId]);
    const job = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, dedupeKey: snoozedDedupeKey(threadOf(2041)) },
      select: { payload: true, runAt: true },
    });
    // Re-armed (due now), with the budget it had.
    expect(job.runAt.getTime()).toBeLessThan(Date.now() + 60_000);
    expect(job.payload).toMatchObject({
      threadId: threadOf(2041),
      nudgeRetries: 3,
      nudgeRetriesAnchorId: 340,
    });
  });

  test("a finished row re-armed by a new event gets a fresh failure budget", async () => {
    await setSettings(LADDER);
    await seed(2030, { lastEventAt: new Date(Date.now() - 10_000) });
    await finishedJob(2030, "DEAD", new Date(Date.now() - 60_000));
    await sweepSnoozedFollowUps(appDb, tenantId, [agentId]);
    const job = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, dedupeKey: snoozedDedupeKey(threadOf(2030)) },
      select: { status: true, attempts: true },
    });
    expect(job).toEqual({ status: "PENDING", attempts: 0 });
  });
});
