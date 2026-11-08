import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { mergeBehaviorSettings } from "@/modules/agents/behavior-settings";
import { BEHAVIOR_PATCH_SHAPE } from "@/modules/agents/settings-schema";
import { createChatwootClient } from "@/modules/chatwoot/client";
import { CHATWOOT_ACTIVITY_NOTE_KEY } from "@/modules/chatwoot/constants";
import { parseChatwootMessages } from "@/modules/chatwoot/messages";
import { readConversationNotesConfig } from "@/modules/conversation-notes/settings";
import {
  postToolsUsedNote,
  TOOLS_USED_NOTE_MAX_NAMES,
  toolsUsedNoteText,
} from "@/modules/conversation-notes/tools-used";
import type { FlowContext } from "@/modules/flowlog/service";
import { notesFromRows } from "@/modules/observe/job";

const flow = {
  tenantId: 1n,
  turnId: "t",
  source: "inbox",
  conversationId: null,
  agentId: null,
  inboxId: null,
  threadId: "1:1:1",
} as unknown as FlowContext;

describe("readConversationNotesConfig", () => {
  test("off unless the bag says true", () => {
    expect(readConversationNotesConfig(undefined).toolsUsed).toBe(false);
    expect(readConversationNotesConfig({}).toolsUsed).toBe(false);
    expect(
      readConversationNotesConfig({ conversationNotes: {} }).toolsUsed,
    ).toBe(false);
    for (const v of ["true", 1, null, "yes"]) {
      expect(
        readConversationNotesConfig({ conversationNotes: { toolsUsed: v } })
          .toolsUsed,
      ).toBe(false);
    }
    expect(
      readConversationNotesConfig({ conversationNotes: { toolsUsed: true } })
        .toolsUsed,
    ).toBe(true);
  });
});

describe("the conversationNotes block on the write path", () => {
  const schema = z.object(BEHAVIOR_PATCH_SHAPE);

  test("refuses a value that is not a boolean", () => {
    for (const v of ["true", 1, null]) {
      expect(
        schema.safeParse({ conversationNotes: { toolsUsed: v } }).success,
      ).toBe(false);
    }
    expect(
      schema.safeParse({ conversationNotes: { toolsUsed: true } }).success,
    ).toBe(true);
  });

  test("a patch writes the block and leaves the others as stored", () => {
    const stored = { takeover: { onHumanReply: false } };
    const next = mergeBehaviorSettings(stored, {
      conversationNotes: { toolsUsed: true },
    });
    expect(next.conversationNotes).toEqual({
      toolsUsed: true,
      errors: "off",
    });
    expect(next.takeover).toEqual({ onHumanReply: false });
    const off = mergeBehaviorSettings(next, {
      conversationNotes: { toolsUsed: false },
    });
    expect(readConversationNotesConfig(off).toolsUsed).toBe(false);
  });
});

describe("toolsUsedNoteText", () => {
  test("nothing to say for a turn that called no tool", () => {
    expect(toolsUsedNoteText([])).toBeNull();
  });

  test("names in the order of the first call, with a count past one", () => {
    expect(
      toolsUsedNoteText([
        { name: "consultar_agenda", calls: 2 },
        { name: "criar_agendamento", calls: 1 },
      ]),
    ).toBe(
      "Ferramentas usadas pelo agente neste turno: consultar_agenda (2x), criar_agendamento.",
    );
  });

  test("past the cap, the rest is counted instead of listed", () => {
    const many = Array.from(
      { length: TOOLS_USED_NOTE_MAX_NAMES + 3 },
      (_, i) => ({ name: `t${i}`, calls: 1 }),
    );
    const text = toolsUsedNoteText(many) as string;
    expect(text).toContain(`t${TOOLS_USED_NOTE_MAX_NAMES - 1}`);
    expect(text).not.toContain(`t${TOOLS_USED_NOTE_MAX_NAMES},`);
    expect(text.endsWith("e mais 3.")).toBe(true);
  });
});

function fetchStub() {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(init?.body as string));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 1 }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}

const clientOf = (fetchImpl: typeof fetch) =>
  createChatwootClient(
    {
      baseUrl: "https://chat.example.com",
      accountId: 5,
      adminToken: "ADMIN_TOK",
      botToken: "BOT_TOK",
    },
    { fetchImpl, assertSafe: async (u: string) => new URL(u) },
  );

describe("the note on the wire", () => {
  test("a private note with the activity mark, and the names alone", async () => {
    const { bodies, fetchImpl } = fetchStub();
    const client = await clientOf(fetchImpl);
    const outcome = await postToolsUsedNote({
      client,
      conversationId: 42,
      called: [{ name: "consultar_agenda", calls: 1 }],
      flow,
    });
    expect(outcome).toBe("posted");
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as {
      private: boolean;
      content: string;
      content_attributes: Record<string, unknown>;
    };
    expect(body.private).toBe(true);
    expect(body.content).toBe(
      "Ferramentas usadas pelo agente neste turno: consultar_agenda.",
    );
    expect(body.content_attributes[CHATWOOT_ACTIVITY_NOTE_KEY]).toBe("tools");
  });

  test("the mark never rides on a public message", async () => {
    const { bodies, fetchImpl } = fetchStub();
    const client = await clientOf(fetchImpl);
    await client.sendMessage(42, "oi", { activity: "tools" });
    expect(
      (bodies[0] as { content_attributes: Record<string, unknown> })
        .content_attributes[CHATWOOT_ACTIVITY_NOTE_KEY],
    ).toBeUndefined();
  });

  test("a Chatwoot that refuses the note does not throw out of the turn", async () => {
    const client = {
      sendPrivateNote: async () => {
        throw new Error("HTTP 500");
      },
    };
    expect(
      await postToolsUsedNote({
        client,
        conversationId: 42,
        called: [{ name: "x", calls: 1 }],
        flow,
      }),
    ).toBe("failed");
  });

  test("no tool, no request", async () => {
    const { bodies, fetchImpl } = fetchStub();
    const client = await clientOf(fetchImpl);
    expect(
      await postToolsUsedNote({ client, conversationId: 42, called: [], flow }),
    ).toBe("nothing");
    expect(bodies).toHaveLength(0);
  });
});

describe("reading the note back", () => {
  const page = [
    {
      id: 10,
      content: "Cliente pediu segunda via",
      message_type: 1,
      private: true,
      content_attributes: {},
    },
    {
      id: 11,
      content: "Ferramentas usadas pelo agente neste turno: consultar_agenda.",
      message_type: 1,
      private: true,
      content_attributes: { [CHATWOOT_ACTIVITY_NOTE_KEY]: "tools" },
    },
    {
      id: 12,
      content: "ok",
      message_type: 1,
      private: false,
      content_attributes: { [CHATWOOT_ACTIVITY_NOTE_KEY]: "tools" },
    },
    {
      id: 13,
      content: "nota de outra automação",
      message_type: 1,
      private: true,
      content_attributes: { [CHATWOOT_ACTIVITY_NOTE_KEY]: "something-else" },
    },
  ];

  test("only a private row carrying a known kind is ours", () => {
    const rows = parseChatwootMessages(page);
    expect(rows.map((r) => r.activityNote)).toEqual([
      undefined,
      "tools",
      undefined,
      undefined,
    ]);
  });

  test("the monitoring agent's notes block leaves the activity note out", () => {
    const notes = notesFromRows(parseChatwootMessages(page), 10);
    expect(notes).toContain("Cliente pediu segunda via");
    expect(notes).toContain("nota de outra automação");
    expect(notes.some((n) => n.includes("consultar_agenda"))).toBe(false);
  });
});
