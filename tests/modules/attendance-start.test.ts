import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
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

// Where the current attendance of a contact's thread starts, read off the thread with compaction's
// own cut: the `attendance` scope of carrying a customer's files into a case.

const said = (conversation: number, at: string | null, text = "oi") =>
  new HumanMessage({
    content: text,
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
});

describe("attendanceStartedAt", () => {
  test("reads the contact-inbox's thread, not another one", async () => {
    const saver = new MemorySaver();
    const graph = buildThreadStateGraph(saver);
    await graph.invoke(
      {
        messages: [
          said(4, "2026-09-01T10:00:00Z"),
          said(7, "2026-10-05T10:00:00Z"),
        ],
      },
      { configurable: { thread_id: contactInboxThreadId(1n, 2n, 301) } },
    );
    await graph.invoke(
      { messages: [said(9, "2026-10-06T10:00:00Z")] },
      { configurable: { thread_id: contactInboxThreadId(1n, 2n, 999) } },
    );
    const at = await attendanceStartedAt(saver, {
      tenantId: 1n,
      instanceId: 2n,
      contactInboxId: 301,
    });
    expect(at?.toISOString()).toBe("2026-10-05T10:00:00.000Z");
    expect(
      await attendanceStartedAt(saver, {
        tenantId: 1n,
        instanceId: 2n,
        contactInboxId: 303,
      }),
    ).toBeNull();
  });
});
