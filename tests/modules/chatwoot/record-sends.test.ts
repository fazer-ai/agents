import { describe, expect, test } from "bun:test";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  noteLandedMessage,
  recordSends,
  SENT_IDS_CAP,
} from "@/modules/chatwoot/record-sends";

// Issue #855: a turn knows which messages it created, noted where Chatwoot hands their ids back. The
// rule is on the client, so whoever sends (the reply, a tool, the handoff's closing line) is covered.

class FakeClient {
  next = 100;
  async sendMessage(_conv: number, _content: string, _opts?: object) {
    return { id: this.next++ };
  }
  // Like the real one: a note IS a message, sent through `sendMessage` on `this`.
  async sendPrivateNote(conv: number, content: string) {
    return this.sendMessage(conv, content, { private: true });
  }
  async sendAudioMessage() {
    return { id: this.next++ };
  }
  async sendFileAttachment() {
    return null;
  }
  async sendTemplate() {
    return { id: "not-a-number" };
  }
  async toggleStatus() {
    return { id: 999 };
  }
  // Not a create itself, and sends through one: what a future helper on the client would look like.
  async replyAndResolve(conv: number, content: string) {
    const sent = await this.sendMessage(conv, content);
    await this.toggleStatus();
    return sent;
  }
}

function wrap() {
  const fake = new FakeClient();
  return { fake, ...recordSends(fake as unknown as ChatwootClient) };
}

describe("the messages a turn created", () => {
  test("every create is noted once, in the order it returned, and nothing else is", async () => {
    const { client, sentIds } = wrap();
    await client.sendMessage(1, "a");
    await client.sendPrivateNote(1, "nota");
    await client.toggleStatus(1, "open");
    await client.sendAudioMessage(1, new ArrayBuffer(0), "a.ogg", "audio/ogg");
    expect(sentIds()).toEqual([100, 101, 102]);
  });

  test("a helper that sends through a create is noted once, by that create", async () => {
    const { client, sentIds } = wrap();
    const c = client as unknown as FakeClient;
    await c.replyAndResolve(1, "a");
    expect(sentIds()).toEqual([100]);
  });

  test("a create Chatwoot answered without a usable id adds nothing", async () => {
    const { client, sentIds } = wrap();
    await client.sendFileAttachment(
      1,
      new ArrayBuffer(0),
      "f.pdf",
      "application/pdf",
    );
    await client.sendTemplate(1, {} as never);
    expect(sentIds()).toEqual([]);
  });

  test("a failed create adds nothing and still throws", async () => {
    const { fake, client, sentIds } = wrap();
    fake.sendMessage = async () => {
      throw new Error("chatwoot 500");
    };
    await expect(client.sendMessage(1, "a")).rejects.toThrow("chatwoot 500");
    expect(sentIds()).toEqual([]);
  });

  test("a message a read-back confirmed is noted once, and only on a recorded client", async () => {
    const { fake, client, sentIds } = wrap();
    await client.sendMessage(1, "a");
    noteLandedMessage(client, 555);
    noteLandedMessage(client, 555);
    noteLandedMessage(fake as unknown as ChatwootClient, 777);
    expect(sentIds()).toEqual([100, 555]);
  });

  test("the list is bounded", async () => {
    const { client, sentIds } = wrap();
    for (let i = 0; i < SENT_IDS_CAP + 5; i++) await client.sendMessage(1, "a");
    expect(sentIds().length).toBe(SENT_IDS_CAP);
    expect(sentIds()[0]).toBe(100);
  });
});
