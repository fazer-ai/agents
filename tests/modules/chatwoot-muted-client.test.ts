import { describe, expect, test } from "bun:test";
import { ChatwootClient, ChatwootMutedError } from "@/modules/chatwoot/client";

// A monitoring agent runs the ordinary graph with the ordinary tools, and the ONE thing it must
// never do is put something in front of the customer (issue #568). The refusal is at the transport
// so it covers every sender at once — including the one written after this file.

type Call = { url: string; method: string; body: unknown };

function client(mute: boolean): { c: ChatwootClient; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body,
    });
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const c = new ChatwootClient(
    {
      baseUrl: "https://chat.example.com",
      accountId: 5,
      adminToken: "admin",
      botToken: "bot",
      mute,
    },
    fetchImpl,
  );
  return { c, calls };
}

describe("a muted Chatwoot client", () => {
  test("refuses a reply to the customer, and nothing leaves the process", async () => {
    const { c, calls } = client(true);
    await expect(c.sendMessage(9, "Olá!")).rejects.toBeInstanceOf(
      ChatwootMutedError,
    );
    expect(calls).toEqual([]);
  });

  test("allows a private note, which is how a watcher speaks to the team", async () => {
    const { c, calls } = client(true);
    await c.sendPrivateNote(9, "cliente irritado");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]?.body))).toMatchObject({ private: true });
  });

  test("refuses the attachment senders too, which never pass a private flag", async () => {
    const { c, calls } = client(true);
    const bytes = new ArrayBuffer(4);
    await expect(
      c.sendFileAttachment(9, bytes, "a.pdf", "application/pdf"),
    ).rejects.toBeInstanceOf(ChatwootMutedError);
    await expect(
      c.sendAudioMessage(9, bytes, "a.ogg", "audio/ogg"),
    ).rejects.toBeInstanceOf(ChatwootMutedError);
    expect(calls).toEqual([]);
  });

  test("refuses a template, which posts to the same endpoint by another name", async () => {
    const { c } = client(true);
    await expect(
      c.sendTemplate(9, {
        content: "oi",
        name: "hello",
        category: "UTILITY",
        language: "pt_BR",
        processedParams: {},
      }),
    ).rejects.toBeInstanceOf(ChatwootMutedError);
  });

  test("leaves every other write alone: a watcher is meant to label, note and read", async () => {
    const { c, calls } = client(true);
    await c.setConversationLabels(9, ["vip"]);
    await c.getConversationLabels(9);
    await c.toggleStatus(9, "resolved");
    expect(calls.map((x) => x.method)).toEqual(["POST", "GET", "POST"]);
  });

  test("an unmuted client is byte-for-byte what it was", async () => {
    const { c, calls } = client(false);
    await c.sendMessage(9, "Olá!");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]?.body))).toMatchObject({
      content: "Olá!",
      private: false,
    });
  });
});
