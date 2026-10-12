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
  caseCarryOriginKey,
} from "@/modules/cross-inbox-case/carry-job";
import {
  type ClaimedJob,
  retireJobsByDedupeKey,
} from "@/modules/scheduler/service";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";
import { until } from "../utils/poll";
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
const OTHER_CASE = 303;
// A case older than CASE, which an opening of CASE may have replaced.
const OLD_CASE = 201;

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
  // Per case, over `caseStatus`.
  caseStatusOf?: Record<number, string>;
  // The team closes the case while its files come down.
  closeOnDownload?: boolean;
  // The origin's holder, as Chatwoot answers it.
  originAssignee?: string;
  // How many case reads answer before every later one fails.
  caseReadsBeforeFailure?: number;
  // Every case read after the first download fails.
  caseReadFailsAfterDownload?: boolean;
  // Cases Chatwoot answers 404 for.
  deleted?: number[];
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
  let closed = false;
  let downloaded = false;
  let caseReads = 0;
  const client = {
    conversationUrl: (id: number) =>
      `https://chat.example.com/app/accounts/1/conversations/${id}`,
    isInstanceUrl: (url: string) => url.startsWith("https://chat.example.com/"),
    getConversation: async (id: number) => {
      calls.push({ fn: "getConversation", args: [id] });
      if (opts.deleted?.includes(id)) throw new ChatwootApiError(404, "GET");
      if (id === CASE && opts.caseReadsBeforeFailure !== undefined) {
        caseReads += 1;
        if (caseReads > opts.caseReadsBeforeFailure)
          throw new ChatwootApiError(502, "GET");
      }
      if (
        id !== 0 &&
        id >= 200 &&
        opts.caseReadFailsAfterDownload &&
        downloaded
      )
        throw new ChatwootApiError(502, "GET");
      if (id === CASE || id === OTHER_CASE || id === OLD_CASE) {
        return {
          id,
          inbox_id: opts.caseInbox ?? CASE_INBOX,
          status: closed
            ? "resolved"
            : (opts.caseStatusOf?.[id] ?? opts.caseStatus ?? "open"),
          created_at: 1,
          custom_attributes: { ...caseAttrs },
        };
      }
      return {
        id,
        inbox_id: ORIGIN_INBOX,
        status: "open",
        meta: { assignee_type: opts.originAssignee ?? null },
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
      if (opts.closeOnDownload) closed = true;
      downloaded = true;
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
      if (id === CASE || id === OTHER_CASE || id === OLD_CASE)
        Object.assign(caseAttrs, attrs);
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
  over: {
    attempts?: number;
    armedAtMessageId?: number | null;
    caseId?: number;
    byTool?: boolean;
  } = {},
): ClaimedJob {
  return {
    id: phantomJobId,
    tenantId,
    kind: "CASE_CARRY",
    payload: {
      instanceId: String(instanceId),
      originConversationId,
      caseId: over.caseId ?? CASE,
      armedAtMessageId:
        over.armedAtMessageId === undefined ? 9002 : over.armedAtMessageId,
      ...(over.byTool ? { byTool: true } : {}),
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
  mode?: string;
}) {
  await suDb.agent.update({
    where: { id: agentId },
    data: {
      settings: (over.settings ?? CARRY_ON) as never,
      enabled: over.enabled ?? true,
      mode: over.mode ?? "production",
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
      jobFor(103, { armedAtMessageId: 9000, byTool: true }),
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

  test("an arm for a case the origin has since left stands down: the case it names has its own row", async () => {
    await setAgent({});
    await seed(104);
    const f = fakeChatwoot({
      messages: [fromContact(9001, [7001])],
      originAttrs: { [KEY]: OTHER_CASE },
    });
    expect(await caseCarryHandler(jobFor(104), appDb, f.deps)).toEqual({
      outcome: "done",
    });
    expect(f.named("sendFilesAsAdmin")).toHaveLength(0);
    expect((await carryLines(104)).at(-1)?.detail).toMatchObject({
      caseId: CASE,
      stoodDown: "superseded",
    });
  });

  test("the case the origin left is not restored when the newer one closed before the run", async () => {
    await setAgent({});
    await seed(105);
    const f = fakeChatwoot({
      messages: [fromContact(9001, [7001])],
      originAttrs: { [KEY]: OTHER_CASE },
      caseStatusOf: { [OTHER_CASE]: "resolved" },
    });
    await caseCarryHandler(jobFor(105), appDb, f.deps);
    expect(f.named("sendFilesAsAdmin")).toHaveLength(0);
    expect(f.originAttrs[KEY]).toBe(OTHER_CASE);
  });

  test("a failed write of the origin's case number is retried, after the files went", async () => {
    await setAgent({});
    await seed(110);
    const f = fakeChatwoot({ messages: [fromContact(9001, [7001])] });
    const failing = {
      ...f.client,
      setConversationCustomAttributes: async (
        id: number,
        attrs: Record<string, unknown>,
        opts?: unknown,
      ) => {
        if (id === 110) throw new ChatwootApiError(500, "POST");
        return (
          f.client as unknown as {
            setConversationCustomAttributes: (
              i: number,
              a: Record<string, unknown>,
              o?: unknown,
            ) => Promise<unknown>;
          }
        ).setConversationCustomAttributes(id, attrs, opts);
      },
    } as unknown as ChatwootClient;
    const r = await caseCarryHandler(jobFor(110, { byTool: true }), appDb, {
      makeClient: async () => failing,
    });
    expect(r.outcome).toBe("fail");
    expect(f.uploaded()).toEqual([["foto-7001.jpg"]]);
    const warn = (await carryLines(110)).find((l) => l.level === "warn");
    expect(warn?.detail).toMatchObject({
      caseId: CASE,
      originAttribute: "not_written",
    });
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

  test("an opening withdrawn before relinking the origin to its replacement case is recovered", async () => {
    await setAgent({});
    await seed(115);
    // The origin still names the closed case this opening replaced.
    const f = fakeChatwoot({
      messages: [fromContact(9001, [7001])],
      originAttrs: { [KEY]: OLD_CASE },
      caseStatusOf: { [OLD_CASE]: "resolved" },
    });
    await caseCarryHandler(jobFor(115, { byTool: true }), appDb, f.deps);
    expect(f.named("sendFilesAsAdmin").map((c) => c.args[0])).toEqual([CASE]);
    expect(f.originAttrs[KEY]).toBe(CASE);
  });

  test("an origin naming a deleted case falls back to the replacement the tool armed", async () => {
    await setAgent({});
    await seed(117);
    const f = fakeChatwoot({
      messages: [fromContact(9001, [7001])],
      originAttrs: { [KEY]: OLD_CASE },
      deleted: [OLD_CASE],
    });
    expect(
      await caseCarryHandler(jobFor(117, { byTool: true }), appDb, f.deps),
    ).toEqual({
      outcome: "done",
    });
    expect(f.named("sendFilesAsAdmin").map((c) => c.args[0])).toEqual([CASE]);
    expect(f.originAttrs[KEY]).toBe(CASE);
  });

  test("a case that cannot be read right before the upload gets nothing, and the run is retried", async () => {
    await setAgent({});
    await seed(120);
    const f = fakeChatwoot({
      messages: [fromContact(9002, [7002])],
      originAttrs: { [KEY]: CASE },
      caseReadFailsAfterDownload: true,
    });
    const r = await caseCarryHandler(jobFor(120), appDb, f.deps);
    expect(r.outcome).toBe("fail");
    expect(f.named("sendFilesAsAdmin")).toHaveLength(0);
  });

  test("an origin link left unwritten because the case could not be read is retried", async () => {
    await setAgent({});
    await seed(129);
    const f = fakeChatwoot({
      messages: [fromContact(9001, [7001])],
      carried: "9001:7001",
      caseReadsBeforeFailure: 1,
    });
    const r = await caseCarryHandler(
      jobFor(129, { byTool: true }),
      appDb,
      f.deps,
    );
    expect(r.outcome).toBe("fail");
    expect(f.originAttrs[KEY]).toBeUndefined();
  });

  test("a case unreadable before the upload on the last attempt ends with a warn line naming the files", async () => {
    await setAgent({});
    await seed(131);
    const f = fakeChatwoot({
      messages: [fromContact(9002, [7002])],
      originAttrs: { [KEY]: CASE },
      caseReadFailsAfterDownload: true,
    });
    const r = await caseCarryHandler(
      jobFor(131, { attempts: 4 }),
      appDb,
      f.deps,
    );
    expect(r).toEqual({ outcome: "done" });
    expect(f.named("sendFilesAsAdmin")).toHaveLength(0);
    const warn = (await carryLines(131)).find((l) => l.level === "warn");
    expect(warn?.detail).toMatchObject({
      caseId: CASE,
      unread: "case",
      notCarried: [7002],
      retry: false,
    });
  });

  test("a case the team closes while its files come down gets no upload", async () => {
    await setAgent({});
    await seed(116);
    const f = fakeChatwoot({
      messages: [fromContact(9002, [7002])],
      originAttrs: { [KEY]: CASE },
      closeOnDownload: true,
    });
    await caseCarryHandler(jobFor(116), appDb, f.deps);
    expect(f.named("downloadAttachment")).toHaveLength(1);
    expect(f.named("sendFilesAsAdmin")).toHaveLength(0);
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

    test("a test agent on a conversation nobody activated, here or on its redirect sibling", async () => {
      await setAgent({ mode: "test" });
      await seed(118);
      const f = files();
      await caseCarryHandler(jobFor(118), appDb, f.deps);
      quiet(f);
    });

    test("a test agent whose redirect episode was activated on the sibling still carries", async () => {
      const WIDGET = 4;
      await setAgent({
        mode: "test",
        settings: {
          ...CARRY_ON,
          channelRedirect: {
            enabled: true,
            entryInboxId: ORIGIN_INBOX,
            widgetInboxId: WIDGET,
          },
        },
      });
      const widget = await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: WIDGET,
          name: "Site",
          agentId,
          channelType: "Channel::WebWidget",
        },
      });
      await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: 1190,
          threadId: chatwootThreadId(tenantId, instanceId, 1190),
          status: "open",
          inboxId: widget.id,
          contactId: contactDbId,
          testActivatedAt: new Date(),
        },
      });
      await seed(119);
      const f = fakeChatwoot({
        messages: [fromContact(9001, [7001])],
        originAttrs: { [KEY]: CASE },
      });
      await caseCarryHandler(jobFor(119), appDb, f.deps);
      expect(f.named("sendFilesAsAdmin")).toHaveLength(1);
      await setAgent({});
    });

    test("a person holding the origin per Chatwoot, before the mirror heard of it", async () => {
      await setAgent({});
      await seed(127);
      const f = fakeChatwoot({
        messages: [fromContact(9001, [7001])],
        originAssignee: "User",
      });
      await caseCarryHandler(jobFor(127), appDb, f.deps);
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
    const rowOf = (convId: number, caseId = CASE) =>
      suDb.schedulerJob.findFirst({
        where: {
          tenantId,
          kind: "CASE_CARRY",
          dedupeKey: caseCarryDedupeKey(
            chatwootThreadId(tenantId, instanceId, convId),
            caseId,
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
        owedSince: new Date(),
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

    test("a later arm keeps the earlier instant a waiting row still owes files from", async () => {
      await setAgent({});
      await seed(128);
      const early = new Date(Date.now() - 600_000);
      await armCaseCarry({
        tenantId,
        instanceId,
        originConversationId: 128,
        caseId: CASE,
        armedAtMessageId: 9001,
        owedSince: early,
        base: appDb,
      });
      await armCaseCarry({
        tenantId,
        instanceId,
        originConversationId: 128,
        caseId: CASE,
        armedAtMessageId: 9002,
        owedSince: new Date(),
        base: appDb,
      });
      expect((await rowOf(128))?.payload).toMatchObject({
        armedAtMessageId: 9002,
        owedSince: Math.floor(early.getTime() / 1000),
      });
    });

    test("two files arming at once still keep the earlier owed instant", async () => {
      await setAgent({});
      await seed(130);
      const early = new Date(Date.now() - 600_000);
      const arm = (owedSince: Date, armedAtMessageId: number) =>
        armCaseCarry({
          tenantId,
          instanceId,
          originConversationId: 130,
          caseId: CASE,
          armedAtMessageId,
          owedSince,
          base: appDb,
        });
      await Promise.all([
        arm(new Date(), 9003),
        arm(early, 9002),
        arm(new Date(), 9004),
      ]);
      expect(
        (await rowOf(130))?.payload as { owedSince?: number },
      ).toMatchObject({ owedSince: Math.floor(early.getTime() / 1000) });
    });

    test("an arm that read the origin before a /reset does not replace the arm that came after it", async () => {
      await setAgent({});
      await seed(141);
      const thread = chatwootThreadId(tenantId, instanceId, 141);
      const key = caseCarryDedupeKey(thread, CASE);
      // Arms of one origin take one lock, whatever their case.
      const lockKey = caseCarryOriginKey(thread);
      let stale: Promise<unknown> = Promise.resolve();
      // The lock held while the stale arm (9002) waits for it, having read the origin with no reset:
      // in the meantime the reset (9003) lands and a file after it (9004) arms the row.
      await suDb.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;
          stale = arm(141, 9002);
          // The stale arm has read the origin and waits on this key's lock.
          await until("the stale arm waiting on the lock", async () => {
            const [w] = await suDb.$queryRaw<{ n: bigint }[]>`
              SELECT count(*)::bigint AS n FROM pg_locks
              WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
                AND objid::bigint = (hashtext(${lockKey})::bigint & 4294967295)
                AND classid::bigint = ((hashtext(${lockKey})::bigint >> 32) & 4294967295)`;
            return Number(w?.n ?? 0) > 0;
          });
          await tx.conversation.updateMany({
            where: { tenantId, chatwootConversationId: 141 },
            data: { resetAtMessageId: 9003 },
          });
          await tx.schedulerJob.create({
            data: {
              tenantId,
              kind: "CASE_CARRY",
              dedupeKey: key,
              status: "PENDING",
              runAt: new Date(Date.now() + CASE_CARRY_DELAY_MS),
              payload: {
                instanceId: String(instanceId),
                originConversationId: 141,
                caseId: CASE,
                armedAtMessageId: 9004,
                owedSince: null,
              },
            },
          });
        },
        { timeout: 10_000 },
      );
      expect(await stale).toBe("reset");
      expect((await rowOf(141))?.payload).toMatchObject({
        armedAtMessageId: 9004,
      });
    });

    test("an arm that lands out of order keeps the newer arming message", async () => {
      await setAgent({});
      await seed(142);
      await arm(142, 9005);
      await arm(142, 9004);
      expect((await rowOf(142))?.payload).toMatchObject({
        armedAtMessageId: 9005,
      });
    });

    const armFor = (
      convId: number,
      caseId: number,
      armedAtMessageId: number,
      over: { owedSince?: Date; byTool?: boolean } = {},
    ) =>
      armCaseCarry({
        tenantId,
        instanceId,
        originConversationId: convId,
        caseId,
        armedAtMessageId,
        owedSince: over.owedSince ?? new Date(),
        byTool: over.byTool,
        base: appDb,
      });

    test("a late webhook naming the closed case does not take the replacement the tool armed", async () => {
      await setAgent({});
      await seed(143);
      // The opening of CASE, withdrawn before it wrote the origin's case number, armed its recovery; a
      // file's webhook a moment later still names the closed case CASE replaced.
      await armFor(143, CASE, 9003, { byTool: true });
      await armFor(143, OLD_CASE, 9004);
      const row = await rowOf(143);
      expect(row?.payload).toMatchObject({ caseId: CASE, byTool: true });
      if (!row) throw new Error("no row");
      const f = fakeChatwoot({
        messages: [fromContact(9001, [7001])],
        originAttrs: { [KEY]: OLD_CASE },
        caseStatusOf: { [OLD_CASE]: "resolved" },
      });
      await caseCarryHandler(
        {
          id: row.id,
          tenantId,
          kind: "CASE_CARRY",
          payload: row.payload as Record<string, unknown>,
          attempts: 0,
          claimSeq: row.claimSeq,
        },
        appDb,
        f.deps,
      );
      expect(f.named("sendFilesAsAdmin").map((c) => c.args[0])).toEqual([CASE]);
      expect(f.originAttrs[KEY]).toBe(CASE);
    });

    test("an older arm for another case does not pair its case with the newer arming message", async () => {
      await setAgent({});
      await seed(144);
      await armFor(144, CASE, 9005, { byTool: true });
      await armFor(144, OLD_CASE, 9004);
      expect((await rowOf(144))?.payload).toMatchObject({
        caseId: CASE,
        armedAtMessageId: 9005,
      });
      expect((await rowOf(144, OLD_CASE))?.payload).toMatchObject({
        caseId: OLD_CASE,
        armedAtMessageId: 9004,
      });
    });

    test("an arm for another case owes files from its own instant, never the earlier case's", async () => {
      await setAgent({});
      await seed(145);
      const early = new Date(Date.now() - 600_000);
      const late = new Date();
      await armFor(145, CASE, 9002, { owedSince: early });
      await armFor(145, OTHER_CASE, 9003, { owedSince: late, byTool: true });
      expect((await rowOf(145, OTHER_CASE))?.payload).toMatchObject({
        caseId: OTHER_CASE,
        owedSince: Math.floor(late.getTime() / 1000),
      });
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
