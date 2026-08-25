import { describe, expect, test } from "bun:test";
import {
  ChatwootApiError,
  ChatwootMissingTokenError,
  createChatwootClient,
} from "@/modules/chatwoot/client";
import { CHATWOOT_AUTH_HEADER } from "@/modules/chatwoot/constants";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stub(status = 200, payload: unknown = {}) {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const passthroughSafe = async (u: string) => new URL(u);
const baseConfig = {
  baseUrl: "https://chat.example.com",
  accountId: 5,
  adminToken: "ADMIN_TOK",
  botToken: "BOT_TOK",
};

describe("ChatwootClient", () => {
  test("createChatwootClient rejects an SSRF baseUrl", async () => {
    await expect(
      createChatwootClient({
        ...baseConfig,
        baseUrl: "https://169.254.169.254",
      }),
      // real SSRF guard (no assertSafe override)
    ).rejects.toThrow();
  });

  test("sendMessage uses the bot token and the right URL/body", async () => {
    const { fetchImpl, calls } = stub(200, { id: 1 });
    const client = await createChatwootClient(baseConfig, {
      fetchImpl,
      assertSafe: passthroughSafe,
    });
    await client.sendMessage(42, "olá");
    expect(calls[0]?.url).toBe(
      "https://chat.example.com/api/v1/accounts/5/conversations/42/messages",
    );
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["api-access-token"]).toBe("BOT_TOK");
    expect(calls[0]?.body).toMatchObject({
      content: "olá",
      private: false,
      message_type: "outgoing",
    });
  });

  test("sendPrivateNote sets private:true", async () => {
    const { fetchImpl, calls } = stub();
    const client = await createChatwootClient(baseConfig, {
      fetchImpl,
      assertSafe: passthroughSafe,
    });
    await client.sendPrivateNote(42, "resumo para o humano");
    expect(calls[0]?.body).toMatchObject({ private: true });
  });

  test("handoff/assign and toggleStatus use the bot token", async () => {
    const { fetchImpl, calls } = stub();
    const client = await createChatwootClient(baseConfig, {
      fetchImpl,
      assertSafe: passthroughSafe,
    });
    await client.assignToAgent(42, 99);
    await client.toggleStatus(42, "open");
    expect(calls[0]?.url).toContain("/conversations/42/assignments");
    expect(calls[0]?.body).toMatchObject({ assignee_id: 99 });
    expect(calls[1]?.url).toContain("/conversations/42/toggle_status");
    expect(calls[1]?.headers["api-access-token"]).toBe("BOT_TOK");
  });

  test("asAdmin routes assign/unassign/toggleStatus through the admin token", async () => {
    const { fetchImpl, calls } = stub();
    const client = await createChatwootClient(baseConfig, {
      fetchImpl,
      assertSafe: passthroughSafe,
    });
    // Operator-initiated actions must be attributed to the instance admin, not the persona bot.
    await client.assignToAgent(42, 99, { asAdmin: true });
    await client.unassignConversation(42, { asAdmin: true });
    await client.toggleStatus(42, "pending", { asAdmin: true });
    expect(calls[0]?.headers["api-access-token"]).toBe("ADMIN_TOK");
    expect(calls[1]?.headers["api-access-token"]).toBe("ADMIN_TOK");
    expect(calls[2]?.headers["api-access-token"]).toBe("ADMIN_TOK");
  });

  test("unassignConversation posts assignee_id 0 with the bot token", async () => {
    const { fetchImpl, calls } = stub();
    const client = await createChatwootClient(baseConfig, {
      fetchImpl,
      assertSafe: passthroughSafe,
    });
    await client.unassignConversation(42);
    expect(calls[0]?.url).toContain("/conversations/42/assignments");
    expect(calls[0]?.body).toMatchObject({ assignee_id: 0 });
    expect(calls[0]?.headers["api-access-token"]).toBe("BOT_TOK");
  });

  test("toggleTyping uses the bot token (toggle_typing_status is bot-accessible)", async () => {
    const { fetchImpl, calls } = stub();
    const client = await createChatwootClient(baseConfig, {
      fetchImpl,
      assertSafe: passthroughSafe,
    });
    await client.toggleTyping(42, true);
    expect(calls[0]?.url).toContain("/conversations/42/toggle_typing_status");
    expect(calls[0]?.body).toMatchObject({ typing_status: "on" });
    expect(calls[0]?.headers["api-access-token"]).toBe("BOT_TOK");
  });

  test("read methods use the admin token", async () => {
    const { fetchImpl, calls } = stub(200, { id: 42 });
    const client = await createChatwootClient(baseConfig, {
      fetchImpl,
      assertSafe: passthroughSafe,
    });
    await client.getConversation(42);
    expect(calls[0]?.headers["api-access-token"]).toBe("ADMIN_TOK");
    expect(calls[0]?.method).toBe("GET");
  });

  test("Kanban driver uses the admin token and wraps the Rails root keys", async () => {
    const { fetchImpl, calls } = stub(200, {});
    const client = await createChatwootClient(baseConfig, {
      fetchImpl,
      assertSafe: passthroughSafe,
    });
    await client.createKanbanBoard({ name: "Funil" });
    await client.createKanbanStep(3, { name: "Lead" });
    await client.setBoardInboxes(3, [7, 8]);
    await client.setBoardAgents(3, [1]);
    await client.moveKanbanTask(99, 5, 100);

    expect(calls[0]?.url).toBe(
      "https://chat.example.com/api/v1/accounts/5/kanban/boards",
    );
    expect(calls[0]?.headers["api-access-token"]).toBe("ADMIN_TOK");
    expect(calls[0]?.body).toMatchObject({ board: { name: "Funil" } });
    expect(calls[1]?.url).toContain("/kanban/boards/3/steps");
    expect(calls[1]?.body).toMatchObject({ step: { name: "Lead" } });
    expect(calls[2]?.url).toContain("/kanban/boards/3/update_inboxes");
    expect(calls[2]?.body).toMatchObject({ inbox_ids: [7, 8] });
    expect(calls[3]?.body).toMatchObject({ agent_ids: [1] });
    expect(calls[4]?.url).toContain("/kanban/tasks/99/move");
    expect(calls[4]?.body).toMatchObject({
      board_step_id: 5,
      insert_before_task_id: 100,
    });
  });

  test("updateKanbanTask PATCHes only the provided fields (camel→snake) with the admin token", async () => {
    const { fetchImpl, calls } = stub(200, {});
    const client = await createChatwootClient(baseConfig, {
      fetchImpl,
      assertSafe: passthroughSafe,
    });
    await client.updateKanbanTask(99, {
      title: "Maria Souza",
      priority: "high",
      dueDate: "2026-06-20",
    });
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toContain("/kanban/tasks/99");
    expect(calls[0]?.headers["api-access-token"]).toBe("ADMIN_TOK");
    expect(calls[0]?.body).toEqual({
      task: { title: "Maria Souza", priority: "high", due_date: "2026-06-20" },
    });
  });

  test("listLabels returns the payload titles (admin token)", async () => {
    const { fetchImpl, calls } = stub(200, {
      payload: [{ title: "lead" }, { title: "vip" }, { id: 3 }],
    });
    const client = await createChatwootClient(baseConfig, {
      fetchImpl,
      assertSafe: passthroughSafe,
    });
    expect(await client.listLabels()).toEqual(["lead", "vip"]);
    expect(calls[0]?.url).toContain("/api/v1/accounts/5/labels");
    expect(calls[0]?.headers["api-access-token"]).toBe("ADMIN_TOK");
  });

  test("listCustomAttributeDefinitions maps the fork shape", async () => {
    const { fetchImpl } = stub(200, [
      {
        attribute_key: "plano",
        attribute_display_name: "Plano",
        attribute_model: "contact_attribute",
        attribute_display_type: "list",
        attribute_values: ["Free", "Pro"],
      },
      { attribute_display_name: "no key" },
    ]);
    const client = await createChatwootClient(baseConfig, {
      fetchImpl,
      assertSafe: passthroughSafe,
    });
    const defs = await client.listCustomAttributeDefinitions();
    expect(defs).toEqual([
      {
        key: "plano",
        displayName: "Plano",
        model: "contact_attribute",
        displayType: "list",
        values: ["Free", "Pro"],
      },
    ]);
  });

  test("kanbanTaskIdForConversation reads the embedded kanban_task object's id", async () => {
    const withCard = await createChatwootClient(baseConfig, {
      fetchImpl: stub(200, { id: 1, kanban_task: { id: 11 } }).fetchImpl,
      assertSafe: passthroughSafe,
    });
    expect(await withCard.kanbanTaskIdForConversation(7)).toBe(11);
    const noCard = await createChatwootClient(baseConfig, {
      fetchImpl: stub(200, { id: 1, kanban_task: null }).fetchImpl,
      assertSafe: passthroughSafe,
    });
    expect(await noCard.kanbanTaskIdForConversation(7)).toBeNull();
  });

  test("kanbanTaskForConversation returns the embedded card object, or null", async () => {
    const withCard = await createChatwootClient(baseConfig, {
      fetchImpl: stub(200, {
        id: 1,
        kanban_task: { id: 11, board_id: 2, title: "Card" },
      }).fetchImpl,
      assertSafe: passthroughSafe,
    });
    expect(await withCard.kanbanTaskForConversation(7)).toMatchObject({
      id: 11,
      board_id: 2,
      title: "Card",
    });
    const noCard = await createChatwootClient(baseConfig, {
      fetchImpl: stub(200, { id: 1 }).fetchImpl,
      assertSafe: passthroughSafe,
    });
    expect(await noCard.kanbanTaskForConversation(7)).toBeNull();
  });

  test("listMessageTemplates maps approved templates, drops non-approved", async () => {
    const { fetchImpl, calls } = stub(200, {
      message_templates: [
        {
          name: "reengajamento",
          category: "MARKETING",
          language: "pt_BR",
          status: "approved",
        },
        {
          name: "rejeitado",
          category: "UTILITY",
          language: "pt_BR",
          status: "rejected",
        },
        { category: "UTILITY" },
      ],
    });
    const client = await createChatwootClient(baseConfig, {
      fetchImpl,
      assertSafe: passthroughSafe,
    });
    expect(await client.listMessageTemplates(8)).toEqual([
      { name: "reengajamento", category: "MARKETING", language: "pt_BR" },
    ]);
    expect(calls[0]?.url).toContain("/inboxes/8");
  });

  // Chatwoot puts the attachment's data_url in the message_created payload BEFORE ActiveStorage has
  // written the file, so the eager STT/vision download races it and gets a 404 on a fresh voice note.
  // The retry is opt-in: the interactive media proxy must still fail fast on a genuinely missing file.
  describe("downloadAttachment write race", () => {
    // A public documentation IP (RFC 5737) keeps the real anti-SSRF guard happy without a DNS lookup —
    // downloadAttachment always uses the real guard, never deps.assertSafe.
    const HOST = "https://203.0.113.10";
    const URL_ = `${HOST}/rails/active_storage/blobs/redirect/abc/audio.ogg`;

    function downloadStub(statuses: number[]) {
      const slept: number[] = [];
      let calls = 0;
      const fetchImpl = (async () => {
        const status = statuses[calls++] ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          arrayBuffer: async () => new ArrayBuffer(3),
          headers: { get: () => "audio/ogg" },
        } as unknown as Response;
      }) as unknown as typeof fetch;
      return {
        fetchImpl,
        slept,
        sleep: async (ms: number) => {
          slept.push(ms);
        },
        count: () => calls,
      };
    }

    const clientFor = (fetchImpl: typeof fetch) =>
      createChatwootClient(
        { ...baseConfig, baseUrl: HOST },
        { fetchImpl, assertSafe: passthroughSafe },
      );

    test("retries a 404 on the backoff and returns the file once it lands", async () => {
      const s = downloadStub([404, 404, 200]);
      const client = await clientFor(s.fetchImpl);
      const out = await client.downloadAttachment(URL_, {
        retryOnMissing: true,
        sleep: s.sleep,
      });
      expect(out.bytes.byteLength).toBe(3);
      expect(out.contentType).toBe("audio/ogg");
      expect(s.count()).toBe(3);
      expect(s.slept).toEqual([250, 750]);
    });

    test("does not retry by default (interactive media proxy fails fast)", async () => {
      const s = downloadStub([404, 200]);
      const client = await clientFor(s.fetchImpl);
      const err = await client.downloadAttachment(URL_).catch((e) => e);
      expect(err).toBeInstanceOf(ChatwootApiError);
      expect((err as ChatwootApiError).status).toBe(404);
      expect(s.count()).toBe(1);
    });

    test("does not retry a non-404 even when opted in", async () => {
      const s = downloadStub([403, 200]);
      const client = await clientFor(s.fetchImpl);
      const err = await client
        .downloadAttachment(URL_, { retryOnMissing: true, sleep: s.sleep })
        .catch((e) => e);
      expect((err as ChatwootApiError).status).toBe(403);
      expect(s.count()).toBe(1);
      expect(s.slept).toEqual([]);
    });

    test("gives up after the bounded backoff", async () => {
      const s = downloadStub([404, 404, 404, 404, 404]);
      const client = await clientFor(s.fetchImpl);
      const err = await client
        .downloadAttachment(URL_, { retryOnMissing: true, sleep: s.sleep })
        .catch((e) => e);
      expect((err as ChatwootApiError).status).toBe(404);
      expect(s.count()).toBe(4);
      expect(s.slept).toEqual([250, 750, 1500]);
    });
  });

  test("throws ChatwootApiError (without body) on a non-auth non-2xx", async () => {
    const { fetchImpl } = stub(422, { error: "message content here" });
    const client = await createChatwootClient(baseConfig, {
      fetchImpl,
      assertSafe: passthroughSafe,
    });
    const err = await client.sendMessage(42, "x").catch((e) => e);
    expect(err).toBeInstanceOf(ChatwootApiError);
    expect((err as ChatwootApiError).status).toBe(422);
    expect((err as ChatwootApiError).message).not.toContain(
      "message content here",
    );
  });

  // Chatwoot answers BOTH "the token is blank/wrong" and "this endpoint is not open to bots" with
  // 401 + a fixed string, so without the reason the two are one identical log line and two very
  // different operator actions.
  describe("auth failures name the reason", () => {
    const authError = async (status: number, payload: unknown) => {
      const { fetchImpl } = stub(status, payload);
      const client = await createChatwootClient(baseConfig, {
        fetchImpl,
        assertSafe: passthroughSafe,
      });
      return (await client
        .sendMessage(42, "x")
        .catch((e) => e)) as ChatwootApiError;
    };

    test("401 carries Chatwoot's error string", async () => {
      const err = await authError(401, { error: "Invalid Access Token" });
      expect(err.status).toBe(401);
      expect(err.message).toContain("Invalid Access Token");
    });

    test("403 carries it too", async () => {
      const err = await authError(403, {
        error: "API access is not enabled for this account",
      });
      expect(err.message).toContain("API access is not enabled");
    });

    test("a body that is not the expected shape is dropped, not guessed at", async () => {
      const err = await authError(401, { detail: { nested: "shape" } });
      expect(err.message).toBe(
        "Chatwoot API 401 for POST /conversations/42/messages",
      );
    });

    test("a body that is not JSON at all never reaches the message", async () => {
      // A proxy in front of Chatwoot can answer anything; whatever it is, it did not come from
      // Chatwoot's renderer, so nothing is known about what is inside it.
      const raw = "<html>token 4b3a9f customer Maria</html>";
      const client = await createChatwootClient(baseConfig, {
        fetchImpl: (async () =>
          ({
            ok: false,
            status: 401,
            text: async () => raw,
          }) as unknown as Response) as unknown as typeof fetch,
        assertSafe: passthroughSafe,
      });
      const err = (await client
        .sendMessage(42, "x")
        .catch((e) => e)) as ChatwootApiError;
      expect(err.message).not.toContain("Maria");
      expect(err.message).not.toContain("4b3a9f");
      expect(err.message).toContain("unrecognized reason");
    });

    // Parsing as JSON does not prove the answer came from Chatwoot: the base URL is tenant-configured
    // and whatever sits in front of it can answer `{"error": <anything>}`.
    test("a reason that is not one of Chatwoot's own is never repeated", async () => {
      const err = await authError(403, {
        error: "customer Maria Souza, cpf 123.456.789-00",
      });
      expect(err.message).not.toContain("Maria");
      expect(err.message).not.toContain("123.456");
      expect(err.message).toContain("unrecognized reason");
    });
  });

  // A client built without the token a call needs used to send the empty string and read Chatwoot's
  // 401 back, which reported a local wiring mistake as a remote rejection (issue #79).
  test("refuses to call with an empty token instead of sending it", async () => {
    const { fetchImpl, calls } = stub(200, {});
    const client = await createChatwootClient(
      { ...baseConfig, botToken: "" },
      { fetchImpl, assertSafe: passthroughSafe },
    );
    const err = await client.sendMessage(42, "x").catch((e) => e);
    expect(err).toBeInstanceOf(ChatwootMissingTokenError);
    expect(calls).toHaveLength(0);
  });

  // The multipart senders build their own fetch instead of going through request(), so the guard has
  // to be on both of them too — otherwise the empty token still goes out on the wire.
  test("the multipart senders refuse an empty token as well", async () => {
    const { fetchImpl, calls } = stub(200, {});
    const client = await createChatwootClient(
      { ...baseConfig, botToken: "" },
      { fetchImpl, assertSafe: passthroughSafe },
    );
    const audioErr = await client
      .sendAudioMessage(42, new ArrayBuffer(4), "a.ogg", "audio/ogg")
      .catch((e) => e);
    const fileErr = await client
      .sendFileAttachment(42, new ArrayBuffer(4), "a.pdf", "application/pdf")
      .catch((e) => e);
    expect(audioErr).toBeInstanceOf(ChatwootMissingTokenError);
    expect(fileErr).toBeInstanceOf(ChatwootMissingTokenError);
    expect(calls).toHaveLength(0);
  });

  test("an admin-token call on that same client still works", async () => {
    const { fetchImpl, calls } = stub(200, { payload: [] });
    const client = await createChatwootClient(
      { ...baseConfig, botToken: "" },
      { fetchImpl, assertSafe: passthroughSafe },
    );
    await client.getConversationLabels(42);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers[CHATWOOT_AUTH_HEADER]).toBe("ADMIN_TOK");
  });

  test("updateContact can clear an identifier with null", async () => {
    // The unique index is `(identifier, account_id)` with no partial predicate, so an empty string is
    // a value like any other and a second contact cleared that way would collide with the first.
    const { fetchImpl, calls } = stub(200, {});
    const client = await createChatwootClient(baseConfig, {
      fetchImpl,
      assertSafe: passthroughSafe,
    });
    await client.updateContact(7, { identifier: null });
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.body).toEqual({ identifier: null });
  });
});
