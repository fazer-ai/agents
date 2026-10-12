import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { chatwootThreadId } from "@/graph/checkpointer";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { ChatwootApiError } from "@/modules/chatwoot/client";
import { CROSS_INBOX_CASE_CARRIED_ATTRIBUTE } from "@/modules/cross-inbox-case/carry-attachments-settings";
import {
  armCaseCarry,
  CASE_CARRY_DELAY_MS,
  caseCarryDedupeKey,
  caseCarryHandler,
} from "@/modules/cross-inbox-case/carry-job";
import {
  type ClaimedJob,
  retireJobsByDedupeKey,
} from "@/modules/scheduler/service";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";
import { burnSchedulerJobId } from "../utils/scheduler";

// The files that reach the origin after the case opened: the job the tool and the webhook arm, which
// walks the origin again and carries what the case does not have, unless the conversation stopped
// being the agent's to act on.

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
  } catch (err) {
    dbProbeFailed(err);
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const ORIGIN_INBOX = 3;
const CASE_INBOX = 9;
const CONTACT = 5;
const CASE = 202;
const KEY = "case_conversation_id";

let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;
let agentId = 0n;
let contactDbId = 0n;
let phantomJobId = 0n;

const CARRY_ON = {
  crossInboxCase: {
    targetInboxId: CASE_INBOX,
    carryAttachments: { mode: "conversation", fileTypes: ["image", "file"] },
  },
};

interface Msg {
  id: number;
  createdAt: number;
  files?: number[];
  messageType?: number;
  private?: boolean;
  senderType?: string;
}

const fromContact = (id: number, files: number[]): Msg => ({
  id,
  createdAt: id,
  files,
});

function fakeChatwoot(opts: {
  messages: Msg[];
  carried?: string;
  originAttrs?: Record<string, unknown>;
  caseStatus?: string;
  caseInbox?: number;
  // How many uploads fail before one is accepted.
  uploadFailures?: number;
}) {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const caseAttrs: Record<string, unknown> = opts.carried
    ? { [CROSS_INBOX_CASE_CARRIED_ATTRIBUTE]: opts.carried }
    : {};
  const originAttrs: Record<string, unknown> = { ...(opts.originAttrs ?? {}) };
  let failures = opts.uploadFailures ?? 0;
  const client = {
    conversationUrl: (id: number) =>
      `https://chat.example.com/app/accounts/1/conversations/${id}`,
    isInstanceUrl: (url: string) => url.startsWith("https://chat.example.com/"),
    getConversation: async (id: number) => {
      calls.push({ fn: "getConversation", args: [id] });
      if (id === CASE) {
        return {
          id,
          inbox_id: opts.caseInbox ?? CASE_INBOX,
          status: opts.caseStatus ?? "open",
          created_at: 1,
          custom_attributes: { ...caseAttrs },
        };
      }
      return {
        id,
        inbox_id: ORIGIN_INBOX,
        status: "open",
        custom_attributes: { ...originAttrs },
      };
    },
    getMessages: async (id: number) => {
      calls.push({ fn: "getMessages", args: [id] });
      return {
        payload: opts.messages.map((m) => ({
          id: m.id,
          created_at: m.createdAt,
          message_type: m.messageType ?? 0,
          private: m.private ?? false,
          sender_type: m.senderType ?? "contact",
          sender_id: CONTACT,
          attachments: (m.files ?? []).map((f) => ({
            id: f,
            file_type: "image",
            data_url: `https://chat.example.com/rails/active_storage/foto-${f}.jpg`,
            file_size: 8,
          })),
        })),
      };
    },
    downloadAttachment: async (url: string) => {
      calls.push({ fn: "downloadAttachment", args: [url] });
      return { bytes: new Uint8Array(8).buffer, contentType: "image/jpeg" };
    },
    sendFilesAsAdmin: async (...args: unknown[]) => {
      calls.push({ fn: "sendFilesAsAdmin", args });
      if (failures > 0) {
        failures -= 1;
        throw new ChatwootApiError(500, "POST");
      }
      return {};
    },
    sendMessageAsAdmin: async (...args: unknown[]) => {
      calls.push({ fn: "sendMessageAsAdmin", args });
      return {};
    },
    setConversationCustomAttributes: async (
      id: number,
      attrs: Record<string, unknown>,
      opts?: { asAdmin?: boolean },
    ) => {
      calls.push({
        fn: "setConversationCustomAttributes",
        args: [id, attrs, opts],
      });
      if (id === CASE) Object.assign(caseAttrs, attrs);
      else Object.assign(originAttrs, attrs);
    },
  } as unknown as ChatwootClient;
  const named = (fn: string) => calls.filter((c) => c.fn === fn);
  const uploaded = () =>
    named("sendFilesAsAdmin").map((c) =>
      ((c.args[1] ?? []) as Array<{ fileName: string }>).map((f) => f.fileName),
    );
  return {
    client,
    calls,
    caseAttrs,
    originAttrs,
    named,
    uploaded,
    deps: { makeClient: async () => client },
  };
}

function jobFor(
  originConversationId: number,
  over: { attempts?: number; armedAtMessageId?: number | null } = {},
): ClaimedJob {
  return {
    id: phantomJobId,
    tenantId,
    kind: "CASE_CARRY",
    payload: {
      instanceId: String(instanceId),
      originConversationId,
      caseId: CASE,
      armedAtMessageId:
        over.armedAtMessageId === undefined ? 9002 : over.armedAtMessageId,
    },
    attempts: over.attempts ?? 0,
    claimSeq: 0,
  };
}

async function seed(
  convId: number,
  over: { assigneeType?: string | null; resetAtMessageId?: number } = {},
) {
  const data = {
    status: "open",
    inboxId: inboxDbId,
    contactId: contactDbId,
    assigneeType: over.assigneeType ?? null,
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
      threadId: chatwootThreadId(tenantId, instanceId, convId),
      ...data,
    },
    update: data,
  });
}

async function setAgent(over: {
  settings?: Record<string, unknown>;
  enabled?: boolean;
}) {
  await suDb.agent.update({
    where: { id: agentId },
    data: {
      settings: (over.settings ?? CARRY_ON) as never,
      enabled: over.enabled ?? true,
    },
  });
}

const files = () => fakeChatwoot({ messages: [fromContact(9001, [7001])] });

async function carryLines(convId: number) {
  const conv = await suDb.conversation.findFirstOrThrow({
    where: { tenantId, chatwootConversationId: convId },
    select: { id: true },
  });
  const rows = await flowLogRows(suDb, {
    where: { tenantId, conversationId: conv.id, stage: "tool" },
    select: { level: true, detail: true, errorMessage: true },
  });
  return rows.filter(
    (r) => (r.detail as Record<string, unknown> | null)?.phase === "case_carry",
  );
}

describe.skipIf(!dbUp)("the late carry into the case", () => {
  beforeAll(async () => {
    phantomJobId = await burnSchedulerJobId(suDb);
    const t = await suDb.tenant.create({
      data: { name: "CARRY", slug: `case-carry-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 1,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Gi",
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings: CARRY_ON,
      },
    });
    agentId = agent.id;
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: ORIGIN_INBOX,
        name: "WhatsApp",
        agentId,
        channelType: "Channel::Whatsapp",
      },
    });
    inboxDbId = inbox.id;
    const contact = await suDb.contact.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootContactId: CONTACT,
      },
    });
    contactDbId = contact.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "execution_logs",
        "scheduler_jobs",
        "conversations",
        "contacts",
        "inboxes",
        "agents",
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

  test("a file sent after the case opened reaches it, and the one already there is not posted again", async () => {
    await setAgent({});
    await seed(101);
    const f = fakeChatwoot({
      messages: [fromContact(9001, [7001]), fromContact(9002, [7002])],
      carried: "9001:7001",
      originAttrs: { [KEY]: CASE },
    });
    const r = await caseCarryHandler(jobFor(101), appDb, f.deps);
    expect(r).toEqual({ outcome: "done" });
    expect(f.uploaded()).toEqual([["foto-7002.jpg"]]);
    expect(f.named("downloadAttachment")).toHaveLength(1);
    expect(f.caseAttrs[CROSS_INBOX_CASE_CARRIED_ATTRIBUTE]).toBe(
      "9001:7001,9002:7002",
    );
    // The origin already named the case: nothing written back.
    expect(f.named("setConversationCustomAttributes")).toHaveLength(1);
    const lines = await carryLines(101);
    expect(lines.at(-1)?.detail).toMatchObject({ caseId: CASE, carried: 1 });
  });

  test("run again with nothing new, it posts nothing", async () => {
    await setAgent({});
    await seed(102);
    const f = fakeChatwoot({
      messages: [fromContact(9001, [7001]), fromContact(9002, [7002])],
      carried: "9001:7001,9002:7002",
      originAttrs: { [KEY]: CASE },
    });
    await caseCarryHandler(jobFor(102), appDb, f.deps);
    expect(f.named("sendFilesAsAdmin")).toHaveLength(0);
    expect(f.named("downloadAttachment")).toHaveLength(0);
  });

  test("the origin's case number is written back when the opening turn never wrote it", async () => {
    await setAgent({});
    await seed(103);
    const f = fakeChatwoot({ messages: [fromContact(9001, [7001])] });
    await caseCarryHandler(
      jobFor(103, { armedAtMessageId: 9000 }),
      appDb,
      f.deps,
    );
    expect(f.originAttrs[KEY]).toBe(CASE);
    // The bot token is not loaded here, and the origin may be in an inbox the bot does not serve.
    expect(
      f.named("setConversationCustomAttributes").find((c) => c.args[0] === 103)
        ?.args[2],
    ).toMatchObject({ asAdmin: true });
    expect(f.uploaded()).toEqual([["foto-7001.jpg"]]);
  });

  test("an origin that names another case leaves this one alone", async () => {
    await setAgent({});
    await seed(104);
    const f = fakeChatwoot({
      messages: [fromContact(9001, [7001])],
      originAttrs: { [KEY]: 999 },
    });
    expect(await caseCarryHandler(jobFor(104), appDb, f.deps)).toEqual({
      outcome: "done",
    });
    expect(f.named("downloadAttachment")).toHaveLength(0);
  });

  test("files a person, a note or a bot left on the origin are not downloaded", async () => {
    await setAgent({});
    await seed(105);
    const f = fakeChatwoot({
      messages: [
        {
          id: 9005,
          createdAt: 9005,
          files: [7005],
          messageType: 1,
          senderType: "user",
        },
        {
          id: 9006,
          createdAt: 9006,
          files: [7006],
          messageType: 1,
          private: true,
          senderType: "user",
        },
        {
          id: 9007,
          createdAt: 9007,
          files: [7007],
          messageType: 1,
          senderType: "agent_bot",
        },
      ],
      originAttrs: { [KEY]: CASE },
    });
    await caseCarryHandler(jobFor(105), appDb, f.deps);
    expect(f.named("downloadAttachment")).toHaveLength(0);
    expect(f.named("sendFilesAsAdmin")).toHaveLength(0);
  });

  test("an upload that fails is tried again with a line naming the case and the file, and nothing is marked", async () => {
    await setAgent({});
    await seed(106);
    const f = fakeChatwoot({
      messages: [fromContact(9001, [7001]), fromContact(9002, [7002])],
      carried: "9001:7001",
      originAttrs: { [KEY]: CASE },
      uploadFailures: 1,
    });
    const first = await caseCarryHandler(jobFor(106), appDb, f.deps);
    expect(first.outcome).toBe("fail");
    // No note saying the file could not be copied while another attempt is coming.
    expect(f.named("sendMessageAsAdmin")).toHaveLength(0);
    expect(f.caseAttrs[CROSS_INBOX_CASE_CARRIED_ATTRIBUTE]).toBe("9001:7001");
    const lines = await carryLines(106);
    const warn = lines.find((l) => l.level === "warn");
    expect(warn?.detail).toMatchObject({
      caseId: CASE,
      failedAttachments: [7002],
      retry: true,
    });
    expect(warn?.errorMessage).toContain("7002");
    const second = await caseCarryHandler(
      jobFor(106, { attempts: 1 }),
      appDb,
      f.deps,
    );
    expect(second).toEqual({ outcome: "done" });
    expect(f.uploaded()).toEqual([["foto-7002.jpg"], ["foto-7002.jpg"]]);
    expect(f.caseAttrs[CROSS_INBOX_CASE_CARRIED_ATTRIBUTE]).toBe(
      "9001:7001,9002:7002",
    );
  });

  test("the fourth attempt that fails is still retried, with no note", async () => {
    await setAgent({});
    await seed(109);
    const f = fakeChatwoot({
      messages: [fromContact(9002, [7002])],
      originAttrs: { [KEY]: CASE },
      uploadFailures: 1,
    });
    const r = await caseCarryHandler(
      jobFor(109, { attempts: 3 }),
      appDb,
      f.deps,
    );
    expect(r.outcome).toBe("fail");
    expect(f.named("sendMessageAsAdmin")).toHaveLength(0);
  });

  test("the last attempt that fails leaves the note on the case and ends", async () => {
    await setAgent({});
    await seed(107);
    const f = fakeChatwoot({
      messages: [fromContact(9002, [7002])],
      originAttrs: { [KEY]: CASE },
      uploadFailures: 1,
    });
    const r = await caseCarryHandler(
      jobFor(107, { attempts: 4 }),
      appDb,
      f.deps,
    );
    expect(r).toEqual({ outcome: "done" });
    expect(f.named("sendMessageAsAdmin")).toHaveLength(1);
  });

  test("a closed case gets nothing, and nothing is opened", async () => {
    await setAgent({});
    await seed(108);
    const f = fakeChatwoot({
      messages: [fromContact(9002, [7002])],
      originAttrs: { [KEY]: CASE },
      caseStatus: "resolved",
    });
    await caseCarryHandler(jobFor(108), appDb, f.deps);
    expect(f.named("downloadAttachment")).toHaveLength(0);
    expect(f.named("sendFilesAsAdmin")).toHaveLength(0);
  });

  describe("what stops it", () => {
    const quiet = (f: ReturnType<typeof fakeChatwoot>) => {
      expect(f.named("downloadAttachment")).toHaveLength(0);
      expect(f.named("sendFilesAsAdmin")).toHaveLength(0);
      expect(f.named("sendMessageAsAdmin")).toHaveLength(0);
      expect(f.named("setConversationCustomAttributes")).toHaveLength(0);
    };
    test("a /reset after the arming", async () => {
      await setAgent({});
      await seed(111, { resetAtMessageId: 9003 });
      const f = files();
      await caseCarryHandler(jobFor(111), appDb, f.deps);
      quiet(f);
      expect((await carryLines(111)).at(-1)?.detail).toMatchObject({
        stoodDown: "reset",
      });
    });

    test("the agent switched off", async () => {
      await setAgent({ enabled: false });
      await seed(112);
      const f = files();
      await caseCarryHandler(jobFor(112), appDb, f.deps);
      quiet(f);
    });

    test("a person holding the origin", async () => {
      await setAgent({});
      await seed(113, { assigneeType: "User" });
      const f = files();
      await caseCarryHandler(jobFor(113), appDb, f.deps);
      quiet(f);
    });

    test("the files block switched off", async () => {
      await setAgent({
        settings: {
          crossInboxCase: {
            targetInboxId: CASE_INBOX,
            carryAttachments: { mode: "off" },
          },
        },
      });
      await seed(114);
      const f = files();
      await caseCarryHandler(jobFor(114), appDb, f.deps);
      quiet(f);
    });
  });

  describe("arming", () => {
    const rowOf = (convId: number) =>
      suDb.schedulerJob.findFirst({
        where: {
          tenantId,
          kind: "CASE_CARRY",
          dedupeKey: caseCarryDedupeKey(
            chatwootThreadId(tenantId, instanceId, convId),
          ),
        },
      });
    const arm = (convId: number, armedAtMessageId = 9002) =>
      armCaseCarry({
        tenantId,
        instanceId,
        originConversationId: convId,
        caseId: CASE,
        armedAtMessageId,
        base: appDb,
      });

    test("arms one row per origin, a few seconds out, naming the case and the message", async () => {
      await setAgent({});
      await seed(121);
      const before = Date.now();
      expect(await arm(121)).toBe("armed");
      const row = await rowOf(121);
      expect(row?.status).toBe("PENDING");
      expect(row?.payload).toMatchObject({
        originConversationId: 121,
        caseId: CASE,
        armedAtMessageId: 9002,
      });
      const at = row?.runAt.getTime() ?? 0;
      expect(at).toBeGreaterThanOrEqual(before + CASE_CARRY_DELAY_MS - 50);
      expect(await arm(121, 9004)).toBe("armed");
      expect(
        await suDb.schedulerJob.count({
          where: { tenantId, kind: "CASE_CARRY", dedupeKey: row?.dedupeKey },
        }),
      ).toBe(1);
    });

    test("nothing is armed under a reset, a switched-off agent, a person, or the block off", async () => {
      await setAgent({});
      await seed(122, { resetAtMessageId: 9002 });
      expect(await arm(122)).toBe("reset");
      await seed(123, { assigneeType: "User" });
      expect(await arm(123)).toBe("taken_over");
      await setAgent({ enabled: false });
      await seed(124);
      expect(await arm(124)).toBe("agent_off");
      await setAgent({ settings: {} });
      await seed(125);
      expect(await arm(125)).toBe("carry_off");
      for (const c of [122, 123, 124, 125]) expect(await rowOf(c)).toBeNull();
    });

    test("the row a /reset retires stands down when it runs", async () => {
      await setAgent({});
      await seed(126);
      await arm(126);
      const row = await rowOf(126);
      if (!row) throw new Error("no row");
      const claimed: ClaimedJob = {
        id: row.id,
        tenantId,
        kind: "CASE_CARRY",
        payload: row.payload as Record<string, unknown>,
        attempts: 0,
        claimSeq: row.claimSeq,
      };
      await retireJobsByDedupeKey(tenantId, "CASE_CARRY", row.dedupeKey, appDb);
      expect((await rowOf(126))?.status).toBe("DONE");
      const f = files();
      await caseCarryHandler(claimed, appDb, f.deps);
      expect(f.named("downloadAttachment")).toHaveLength(0);
      expect(f.named("sendFilesAsAdmin")).toHaveLength(0);
    });
  });
});
