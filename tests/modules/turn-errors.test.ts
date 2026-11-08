import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { mergeBehaviorSettings } from "@/modules/agents/behavior-settings";
import { BEHAVIOR_PATCH_SHAPE } from "@/modules/agents/settings-schema";
import { createChatwootClient } from "@/modules/chatwoot/client";
import {
  CHATWOOT_ACTIVITY_NOTE_KEY,
  CHATWOOT_ERRORS_KEY_KEY,
} from "@/modules/chatwoot/constants";
import { parseChatwootMessages } from "@/modules/chatwoot/messages";
import { readConversationNotesConfig } from "@/modules/conversation-notes/settings";
import {
  errorReason,
  postTurnErrors,
  TURN_ERRORS_MAX_TOOLS,
  TurnErrors,
  turnErrorsKey,
  turnErrorsText,
} from "@/modules/conversation-notes/turn-errors";
import type { FlowContext } from "@/modules/flowlog/service";
import type { GuardrailReport } from "@/modules/guardrails/gate";
import { notesFromRows } from "@/modules/observe/job";

const flow = {
  tenantId: 1n,
  turnId: "turn-abc",
  source: "inbox",
  conversationId: null,
  agentId: null,
  inboxId: null,
  threadId: "1:1:1",
} as unknown as FlowContext;

const failing = (name: string, cause = "HTTP 500", recovered = false) => ({
  name,
  failed: 1,
  recovered,
  cause,
});

describe("the errors format in the settings", () => {
  test("off unless the bag names one of the three", () => {
    expect(readConversationNotesConfig(undefined).errors).toBe("off");
    for (const v of [true, "email", 1, null]) {
      expect(
        readConversationNotesConfig({ conversationNotes: { errors: v } })
          .errors,
      ).toBe("off");
    }
    expect(
      readConversationNotesConfig({ conversationNotes: { errors: "note" } })
        .errors,
    ).toBe("note");
    expect(
      readConversationNotesConfig({
        conversationNotes: { errors: "activity" },
      }),
    ).toEqual({ toolsUsed: "off", errors: "activity" });
  });

  test("the write path refuses a value off the list", () => {
    const schema = z.looseObject(BEHAVIOR_PATCH_SHAPE);
    expect(
      schema.safeParse({ conversationNotes: { errors: "email" } }).success,
    ).toBe(false);
    for (const v of ["off", "activity", "note"])
      expect(
        schema.safeParse({ conversationNotes: { errors: v } }).success,
      ).toBe(true);
  });
});

describe("the two notes are set apart", () => {
  test("a patch of one leaves the other as stored, the old switch included", () => {
    const stored = { conversationNotes: { toolsUsed: true, errors: "note" } };
    expect(
      readConversationNotesConfig(
        mergeBehaviorSettings(stored, {
          conversationNotes: { errors: "activity" },
        }),
      ),
    ).toEqual({ toolsUsed: "note", errors: "activity" });
    expect(
      readConversationNotesConfig(
        mergeBehaviorSettings(stored, {
          conversationNotes: { toolsUsed: "activity" },
        }),
      ),
    ).toEqual({ toolsUsed: "activity", errors: "note" });
  });
});

describe("errorReason", () => {
  test("reads a cause into a closed list, never quoting it", () => {
    expect(errorReason("HTTP 500")).toBe("HTTP 500");
    expect(errorReason("upstream said status 503")).toBe("erro");
    expect(errorReason("The operation timed out")).toBe("tempo esgotado");
    expect(errorReason("fetch failed: ECONNREFUSED 10.0.0.5:8080")).toBe(
      "sem conexão",
    );
    expect(errorReason("401 Unauthorized")).toBe("credencial recusada");
    // A number the engine did not put first may be the customer's, and is never copied.
    for (const cause of [
      "invalid security code: 123",
      "pedido 404 não encontrado",
      "valor HTTP 500 informado",
    ])
      expect(errorReason(cause)).toBe("erro");
    expect(
      errorReason(
        "cliente Ana Souza cpf 123.456.789-09 em /srv/app/x.ts token abc",
      ),
    ).toBe("erro");
  });
});

describe("what one turn survived", () => {
  test("tools in order, then the fallback, then the guardrail", () => {
    const t = new TurnErrors();
    t.fallbackAnswered({ reason: "HTTP 503 from provider", failure: "server" });
    t.guardrail({
      direction: "output",
      outcome: "replaced",
      action: "template",
    } as GuardrailReport);
    const items = t.items([
      failing("consultar_pedido"),
      failing("consultar_estoque", "timeout", true),
    ]);
    expect(items.map((i) => i.kind)).toEqual([
      "tool",
      "tool",
      "fallback",
      "guardrail",
    ]);
  });

  test("only a screening that held the reply counts", () => {
    const t = new TurnErrors();
    for (const outcome of ["clean", "observed", "unavailable"] as const)
      t.guardrail({ direction: "output", outcome } as GuardrailReport);
    expect(t.items([])).toEqual([]);
    t.guardrail({
      direction: "input",
      outcome: "suppressed",
      action: "silent",
    } as GuardrailReport);
    expect(t.items([])).toHaveLength(1);
  });

  test("an empty-response retry is said, unless the fallback already answered", () => {
    const t = new TurnErrors();
    t.modelRetried();
    expect(t.items([]).map((i) => i.kind)).toEqual(["retry"]);
    t.fallbackAnswered({ reason: "x", failure: "timeout" });
    expect(t.items([]).map((i) => i.kind)).toEqual(["fallback"]);
  });
});

describe("turnErrorsText", () => {
  test("nothing to say for a clean turn", () => {
    expect(turnErrorsText([], "t", 7n)).toBeNull();
  });

  test("names, reason, whether it recovered, and the turn's Logs link", () => {
    const t = new TurnErrors();
    t.fallbackAnswered({ reason: "HTTP 503", failure: "server" });
    const text = turnErrorsText(
      t.items([
        { ...failing("consultar_pedido"), failed: 2 },
        failing("consultar_estoque", "timeout", true),
      ]),
      "turn-abc",
      7n,
    ) as string;
    expect(text).toContain(
      "Ferramenta consultar_pedido: falhou 2x (HTTP 500). Não se recuperou",
    );
    expect(text).toContain(
      "Ferramenta consultar_estoque: falhou (tempo esgotado). Se recuperou",
    );
    expect(text).toContain(
      "Modelo principal: falhou (HTTP 503). Se recuperou: o modelo de fallback respondeu.",
    );
    expect(text).toMatch(
      /Detalhes do turno: \S+\/logs\?turnId=turn-abc&switchTenant=7$/,
    );
  });

  test("the error's own text never reaches the message", () => {
    const text = turnErrorsText(
      new TurnErrors().items([
        failing(
          "consultar_pedido",
          "Ana Souza 123.456.789-09 10.0.0.5 /srv/app tok_123",
        ),
      ]),
      "t",
      7n,
    ) as string;
    for (const leak of [
      "Ana Souza",
      "123.456",
      "10.0.0.5",
      "/srv/app",
      "tok_123",
    ])
      expect(text).not.toContain(leak);
  });

  test("past the cap, the rest of the tools is counted", () => {
    const tools = Array.from({ length: TURN_ERRORS_MAX_TOOLS + 3 }, (_, i) =>
      failing(`t${i}`),
    );
    const text = turnErrorsText(
      new TurnErrors().items(tools),
      "t",
      7n,
    ) as string;
    expect(text).toContain(`t${TURN_ERRORS_MAX_TOOLS - 1}`);
    expect(text).not.toContain(`t${TURN_ERRORS_MAX_TOOLS}:`);
    expect(text).toContain("E mais 3 ferramenta(s) com falha.");
  });
});

describe("turnErrorsKey", () => {
  test("the same failure is the same key, whatever the count or order", () => {
    const a = new TurnErrors().items([
      failing("b"),
      { ...failing("a"), failed: 3 },
    ]);
    const b = new TurnErrors().items([failing("a"), failing("b")]);
    expect(turnErrorsKey(a)).toBe(turnErrorsKey(b));
    expect(turnErrorsKey(new TurnErrors().items([failing("a")]))).not.toBe(
      turnErrorsKey(new TurnErrors().items([failing("c")])),
    );
  });
});

async function chatwootStub(page: unknown[] = []) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET")
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ payload: page }),
      } as unknown as Response;
    bodies.push(JSON.parse(init?.body as string));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 1 }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  const client = await createChatwootClient(
    {
      baseUrl: "https://chat.example.com",
      accountId: 5,
      adminToken: "ADMIN_TOK",
      botToken: "BOT_TOK",
    },
    { fetchImpl, assertSafe: async (u: string) => new URL(u) },
  );
  return { bodies, client };
}

type Body = {
  private: boolean;
  message_type: string;
  content: string;
  content_attributes: Record<string, unknown>;
};

describe("the message on the wire", () => {
  const items = new TurnErrors().items([failing("consultar_pedido")]);

  test("activity: an activity row with the errors mark and its key", async () => {
    const { bodies, client } = await chatwootStub();
    expect(
      await postTurnErrors({
        client,
        conversationId: 42,
        format: "activity",
        items,
        flow,
      }),
    ).toBe("posted");
    const body = bodies[0] as Body;
    expect(body.message_type).toBe("activity");
    expect(body.private).toBe(false);
    expect(body.content).toContain("consultar_pedido");
    expect(body.content_attributes[CHATWOOT_ACTIVITY_NOTE_KEY]).toBe("errors");
    expect(body.content_attributes[CHATWOOT_ERRORS_KEY_KEY]).toBe(
      turnErrorsKey(items),
    );
  });

  test("note: a private note with the same marks", async () => {
    const { bodies, client } = await chatwootStub();
    await postTurnErrors({
      client,
      conversationId: 42,
      format: "note",
      items,
      flow,
    });
    const body = bodies[0] as Body;
    expect(body.private).toBe(true);
    expect(body.message_type).toBe("outgoing");
    expect(body.content_attributes[CHATWOOT_ACTIVITY_NOTE_KEY]).toBe("errors");
  });

  test("off, or nothing to say: no request at all", async () => {
    const { bodies, client } = await chatwootStub();
    expect(
      await postTurnErrors({
        client,
        conversationId: 42,
        format: "off",
        items,
        flow,
      }),
    ).toBe("nothing");
    expect(
      await postTurnErrors({
        client,
        conversationId: 42,
        format: "note",
        items: [],
        flow,
      }),
    ).toBe("nothing");
    expect(bodies).toHaveLength(0);
  });

  test("the same failure as the newest errors message is not said again", async () => {
    const key = turnErrorsKey(items);
    const errorsRow = (id: number, k: string) => ({
      id,
      content: "Erros neste turno do agente: ...",
      message_type: 2,
      private: false,
      content_attributes: {
        [CHATWOOT_ACTIVITY_NOTE_KEY]: "errors",
        [CHATWOOT_ERRORS_KEY_KEY]: k,
      },
    });
    const same = await chatwootStub([errorsRow(7, key)]);
    expect(
      await postTurnErrors({
        client: same.client,
        conversationId: 42,
        format: "activity",
        items,
        flow,
      }),
    ).toBe("repeated");
    expect(same.bodies).toHaveLength(0);
    // Another failure in between makes the old one news again.
    const other = await chatwootStub([
      errorsRow(7, key),
      errorsRow(9, "tool:x"),
    ]);
    expect(
      await postTurnErrors({
        client: other.client,
        conversationId: 42,
        format: "activity",
        items,
        flow,
      }),
    ).toBe("posted");
  });

  test("a Chatwoot that refuses does not throw out of the turn", async () => {
    const client = {
      getMessages: async () => ({ payload: [] }),
      sendMessage: async () => {
        throw new Error("HTTP 500");
      },
    };
    expect(
      await postTurnErrors({
        client,
        conversationId: 42,
        format: "note",
        items,
        flow,
      }),
    ).toBe("failed");
  });

  test("the mark never rides on a public outgoing message", async () => {
    const { bodies, client } = await chatwootStub();
    await client.sendMessage(42, "oi", {
      activity: "errors",
      activityAttributes: { [CHATWOOT_ERRORS_KEY_KEY]: "k" },
    });
    const ca = (bodies[0] as Body).content_attributes;
    expect(ca[CHATWOOT_ACTIVITY_NOTE_KEY]).toBeUndefined();
    expect(ca[CHATWOOT_ERRORS_KEY_KEY]).toBeUndefined();
  });
});

describe("reading the errors message back", () => {
  const page = [
    {
      id: 10,
      content: "Erros neste turno do agente: ...",
      message_type: 2,
      private: false,
      content_attributes: {
        [CHATWOOT_ACTIVITY_NOTE_KEY]: "errors",
        [CHATWOOT_ERRORS_KEY_KEY]: "tool:a:HTTP 500:n",
      },
    },
    {
      id: 11,
      content: "Erros neste turno do agente: nota",
      message_type: 1,
      private: true,
      content_attributes: { [CHATWOOT_ACTIVITY_NOTE_KEY]: "errors" },
    },
    {
      id: 12,
      content: "mensagem do cliente",
      message_type: 0,
      private: false,
      content_attributes: { [CHATWOOT_ACTIVITY_NOTE_KEY]: "errors" },
    },
  ];

  test("an activity row and a private note are ours; a contact's message is not", () => {
    const rows = parseChatwootMessages(page);
    expect(rows.map((r) => r.activityNote)).toEqual([
      "errors",
      "errors",
      undefined,
    ]);
    expect(rows[0]?.activityErrorsKey).toBe("tool:a:HTTP 500:n");
  });

  test("the monitoring agent's notes block leaves the errors note out", () => {
    const notes = notesFromRows(parseChatwootMessages(page), 10);
    expect(notes.some((n) => n.includes("Erros neste turno"))).toBe(false);
  });
});
