import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { contactInboxThreadId } from "@/graph/checkpointer";
import {
  conversationStamp,
  memoryHeadMessage,
  sentAtStamp,
} from "@/graph/markers";
import { buildThreadStateGraph } from "@/graph/thread-state";
import {
  attendanceStartedAt,
  openAttendanceStart,
} from "@/modules/memory/attendance-start";
import { seedChatwootInstance } from "../utils/chatwoot";

// Where the current attendance of a contact's thread starts, read off the thread with compaction's
// own cut: the `attendance` scope of carrying a customer's files into a case.

const said = (conversation: number, at: string | null, id?: string) =>
  new HumanMessage({
    content: "oi",
    ...(id ? { id } : {}),
    additional_kwargs: {
      ...conversationStamp(conversation),
      ...sentAtStamp(at === null ? null : new Date(at)),
    },
  });

describe("openAttendanceStart", () => {
  test("the first instant of the conversation's last run, past an earlier run of the same one", () => {
    const at = openAttendanceStart([
      said(7, "2026-10-01T10:00:00Z"),
      new AIMessage("olá"),
      said(8, "2026-10-02T10:00:00Z"),
      said(7, "2026-10-05T10:00:00Z"),
      new AIMessage("olá de novo"),
      said(7, "2026-10-05T10:03:00Z"),
    ]);
    expect(at?.toISOString()).toBe("2026-10-05T10:00:00.000Z");
  });

  test("after a resolve folded everything into the head, the reopened turns are the attendance", () => {
    const at = openAttendanceStart([
      memoryHeadMessage("resumo"),
      said(7, "2026-10-06T09:00:00Z"),
    ]);
    expect(at?.toISOString()).toBe("2026-10-06T09:00:00.000Z");
  });

  test("a turn with no instant does not move the start; none at all means no boundary", () => {
    expect(
      openAttendanceStart([
        said(7, null),
        said(7, "2026-10-05T10:00:00Z"),
      ])?.toISOString(),
    ).toBe("2026-10-05T10:00:00.000Z");
    expect(openAttendanceStart([said(7, null)])).toBeNull();
    expect(openAttendanceStart([])).toBeNull();
  });
  test("a summary still waiting for its rewrite ends the attendance it covers", () => {
    const thread = [
      said(7, "2026-10-01T10:00:00Z"),
      said(7, "2026-10-01T10:05:00Z", "cut-here"),
      new AIMessage("resolvido"),
      said(7, "2026-10-06T09:00:00Z"),
    ];
    expect(openAttendanceStart(thread)?.toISOString()).toBe(
      "2026-10-01T10:00:00.000Z",
    );
    expect(openAttendanceStart(thread, "cut-here")?.toISOString()).toBe(
      "2026-10-06T09:00:00.000Z",
    );
    expect(openAttendanceStart(thread, "gone")?.toISOString()).toBe(
      "2026-10-01T10:00:00.000Z",
    );
  });
});

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
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

describe.skipIf(!dbUp)("attendanceStartedAt", () => {
  let tenantId = 0n;
  let instanceId = 0n;
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: {
        name: "Attendance start",
        slug: `attendance-start-${process.pid}`,
      },
    });
    tenantId = t.id;
    instanceId = (await seedChatwootInstance(suDb, { tenantId, accountId: 1 }))
      .id;
  });
  afterAll(async () => {
    if (!dbUp) return;
    await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  });

  test("reads the contact-inbox's thread and its pending cut, not another one's", async () => {
    const saver = new MemorySaver();
    const graph = buildThreadStateGraph(saver);
    await graph.invoke(
      {
        messages: [
          said(7, "2026-10-01T10:00:00Z", "m1"),
          said(7, "2026-10-01T10:05:00Z", "m2"),
          said(7, "2026-10-06T09:00:00Z", "m3"),
        ],
      },
      {
        configurable: {
          thread_id: contactInboxThreadId(tenantId, instanceId, 301),
        },
      },
    );
    await graph.invoke(
      { messages: [said(9, "2026-10-06T10:00:00Z")] },
      {
        configurable: {
          thread_id: contactInboxThreadId(tenantId, instanceId, 999),
        },
      },
    );
    await suDb.attendanceSummary.createMany({
      data: [
        {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId: 301,
          conversationId: 7,
          lastMessageId: "folded-long-ago",
          summary: "resumo",
          messageCount: 2,
          attendanceAt: null,
        },
        {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId: 301,
          conversationId: 7,
          lastMessageId: "m2",
          summary: "resumo",
          messageCount: 2,
          attendanceAt: null,
        },
        {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId: 999,
          conversationId: 9,
          lastMessageId: "x",
          summary: "resumo",
          messageCount: 1,
          attendanceAt: null,
        },
      ],
    });
    const deps = { checkpointer: saver, base: appDb };
    const at = await attendanceStartedAt(deps, {
      tenantId,
      instanceId,
      contactInboxId: 301,
    });
    expect(at?.toISOString()).toBe("2026-10-06T09:00:00.000Z");
    expect(
      await attendanceStartedAt(deps, {
        tenantId,
        instanceId,
        contactInboxId: 303,
      }),
    ).toBeNull();
  });
});
