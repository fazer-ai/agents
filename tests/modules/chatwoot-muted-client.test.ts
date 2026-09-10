import { describe, expect, test } from "bun:test";
import {
  ChatwootCalledOffError,
  ChatwootClient,
  ChatwootExpiredError,
  ChatwootMutedError,
} from "@/modules/chatwoot/client";

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

  // NOT EVERY CUSTOMER-FACING WRITE IS A MESSAGE, which is what round 2 of review caught: the check
  // was one URL, and three other endpoints land on the customer's phone without going through it.
  test("refuses a reaction, which lands on the customer's own message", async () => {
    const { c, calls } = client(true);
    await expect(c.addMessageReaction(9, 77, "👍")).rejects.toBeInstanceOf(
      ChatwootMutedError,
    );
    expect(calls).toEqual([]);
  });

  test("refuses the typing indicator, which the fork forwards to the channel", async () => {
    // `channel_listener.rb` hands `conversation_typing_on` to the channel, so on WhatsApp this is
    // the customer watching a persona compose a reply that is never coming.
    const { c, calls } = client(true);
    await expect(c.toggleTyping(9, true)).rejects.toBeInstanceOf(
      ChatwootMutedError,
    );
    expect(calls).toEqual([]);
  });

  test("refuses the read receipt, which turns the ticks blue on their phone", async () => {
    const { c, calls } = client(true);
    await expect(c.markRead(9, [1, 2])).rejects.toBeInstanceOf(
      ChatwootMutedError,
    );
    expect(calls).toEqual([]);
  });

  test("the private-note exemption belongs to the message path alone", async () => {
    // A reaction has no private variant, so a body that happens to carry the flag must not buy one
    // a pass — the exemption is about a note to the team, not about a field name.
    const { c, calls } = client(true);
    const fetchImpl = (c as unknown as { fetchImpl: typeof fetch }).fetchImpl;
    await expect(
      fetchImpl(
        "https://chat.example.com/api/v1/accounts/5/conversations/9/messages/77/reactions",
        {
          method: "POST",
          body: JSON.stringify({ emoji: "👍", private: true }),
        },
      ),
    ).rejects.toBeInstanceOf(ChatwootMutedError);
    expect(calls).toEqual([]);
  });

  test("an unmuted client still reacts, types and acknowledges", async () => {
    const { c, calls } = client(false);
    await c.addMessageReaction(9, 77, "👍");
    await c.toggleTyping(9, true);
    await c.markRead(9, [1, 2]);
    expect(calls).toHaveLength(3);
  });

  test("leaves every other write alone: a watcher is meant to label, note and read", async () => {
    const { c, calls } = client(true);
    await c.setConversationLabels(9, ["vip"]);
    await c.getConversationLabels(9);
    await c.toggleStatus(9, "resolved");
    expect(calls.map((x) => x.method)).toEqual(["POST", "GET", "POST"]);
  });

  // ABORTING THE TURN STOPS THE CALLER WAITING, NOT THE HANDLER ALREADY RUNNING. A tool in the
  // middle of its own sequence of writes keeps going, and each request carries an independent
  // deadline of its own — so the tick could report a retryable failure while the turn it walked
  // away from kept mutating the conversation, and the retry then ran beside it.
  test("past its deadline the client answers nothing, writes and reads alike", async () => {
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
    const expired = AbortSignal.abort();
    const c = new ChatwootClient(
      {
        baseUrl: "https://chat.example.com",
        accountId: 5,
        adminToken: "admin",
        botToken: "bot",
        mute: true,
        expiresOn: expired,
      },
      fetchImpl,
    );
    // The write a handler would make AFTER its first one came back — the case a fence at the tool
    // boundary cannot reach, because it is inside one handler.
    await expect(c.toggleStatus(9, "resolved")).rejects.toBeInstanceOf(
      ChatwootExpiredError,
    );
    await expect(c.setConversationLabels(9, ["vip"])).rejects.toBeInstanceOf(
      ChatwootExpiredError,
    );
    // Reads too: past the deadline there is nobody left to answer.
    await expect(c.getConversationLabels(9)).rejects.toBeInstanceOf(
      ChatwootExpiredError,
    );
    expect(calls).toEqual([]);
  });

  test("a live deadline leaves the client exactly as it was", async () => {
    const { c, calls } = client(false);
    (c as unknown as { config: { expiresOn?: AbortSignal } }).config.expiresOn =
      new AbortController().signal;
    await c.setConversationLabels(9, ["vip"]);
    expect(calls).toHaveLength(1);
  });

  test("a request already in flight is cut by the deadline, without losing its own timeout", async () => {
    // The pre-dispatch check only stops a call that had not STARTED. One that did runs to the
    // client's own `AbortSignal.timeout` and can land its effect after runObserve already reported
    // the tick as failed — `recordResolutionOrigin` being the one that hurts (round 15).
    const seen: (AbortSignal | null | undefined)[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      seen.push(init.signal);
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const deadline = new AbortController();
    const c = new ChatwootClient(
      {
        baseUrl: "https://chat.example.com",
        accountId: 5,
        adminToken: "admin",
        botToken: "bot",
        expiresOn: deadline.signal,
      },
      fetchImpl,
    );
    await c.setConversationLabels(9, ["vip"]);
    const combined = seen[0];
    expect(combined).toBeDefined();
    expect(combined?.aborted).toBe(false);
    deadline.abort();
    expect(combined?.aborted).toBe(true);
  });

  test("and the request's own timeout still fires when the deadline is live", async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      seen.push(init.signal);
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
        expiresOn: new AbortController().signal,
      },
      fetchImpl,
    );
    await c.setConversationLabels(9, ["vip"]);
    // Combined, not replaced: the signal handed down is neither of the two originals.
    expect(seen[0]).toBeDefined();
    expect(seen[0]?.aborted).toBe(false);
  });

  test("the client says whether it is muted, for effects the transport cannot see", async () => {
    // A scheduled reminder is armed now and delivered later, by the inbox's responder and a client
    // of its own, so the mute here never reaches it. Callers that arm such an effect ask this
    // instead of being handed a second flag that could disagree with the wrapper (round 16).
    const mk = (mute: boolean) =>
      new ChatwootClient(
        {
          baseUrl: "https://chat.example.com",
          accountId: 5,
          adminToken: "admin",
          botToken: "bot",
          ...(mute ? { mute: true } : {}),
        },
        (async () => new Response("{}")) as unknown as typeof fetch,
      );
    expect(mk(true).muted).toBe(true);
    expect(mk(false).muted).toBe(false);
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

describe("a queued attribute write asks the fence at the last moment", () => {
  // The tool asks before it calls; between that ask and the PUT sit the keyed queue's wait and the
  // client's own re-read of the bag — and `/reset` CLEARS a conversation's attributes in exactly
  // that window, so a call admitted earlier would put the old episode's values back (round 25).
  function flakyClient(): { c: ChatwootClient; calls: Call[] } {
    const calls: Call[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body,
      });
      return new Response('{"custom_attributes":{"stage":"velho"}}', {
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
      },
      fetchImpl,
    );
    return { c, calls };
  }

  test("a run called off during the read never reaches the write", async () => {
    const { c, calls } = flakyClient();
    // Wanted when the tool asked; withdrawn by the time the queue and the GET were done.
    await expect(
      c.setConversationCustomAttributes(
        9,
        { stage: "novo" },
        { stillWanted: async () => false },
      ),
    ).rejects.toBeInstanceOf(ChatwootCalledOffError);
    // The GET happened (it is what the fence is asked after); the POST did not.
    expect(calls.map((k) => k.method)).toEqual(["GET"]);
  });

  test("the contact scope answers the same way", async () => {
    const { c, calls } = flakyClient();
    await expect(
      c.setContactCustomAttributes(
        3,
        { plano: "gold" },
        { stillWanted: async () => false },
      ),
    ).rejects.toBeInstanceOf(ChatwootCalledOffError);
    expect(calls.map((k) => k.method)).toEqual(["GET"]);
  });

  test("a fence that says yes, and one that cannot answer, both write", async () => {
    // The control the negatives need, and the second half is the rule every other fence follows: an
    // unreadable fence is not the operator saying no.
    const yes = flakyClient();
    await yes.c.setConversationCustomAttributes(
      9,
      { stage: "novo" },
      { stillWanted: async () => true },
    );
    expect(yes.calls.map((k) => k.method)).toEqual(["GET", "POST"]);
    const broken = flakyClient();
    await broken.c.setConversationCustomAttributes(
      9,
      { stage: "novo" },
      {
        stillWanted: async () => {
          throw new Error("database blip");
        },
      },
    );
    expect(broken.calls.map((k) => k.method)).toEqual(["GET", "POST"]);
  });

  test("with no fence offered, nothing changes for every other caller", async () => {
    const { c, calls } = flakyClient();
    await c.setConversationCustomAttributes(9, { stage: "novo" });
    expect(calls.map((k) => k.method)).toEqual(["GET", "POST"]);
  });
});
