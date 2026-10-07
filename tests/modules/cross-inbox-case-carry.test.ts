import { describe, expect, test } from "bun:test";
import { ChatwootApiError } from "@/modules/chatwoot/client";
import {
  CARRY_ATTACHMENTS_DEFAULTS,
  type CarryAttachmentsConfig,
  type CarryClient,
  type CarryInput,
  CROSS_INBOX_CASE_CARRIED_ATTRIBUTE,
  carryCaseAttachments,
  readCarryAttachments,
} from "@/modules/cross-inbox-case/carry-attachments";

// The origin conversation's messages as Chatwoot's REST list serves them: 20 a page, newest first,
// `before` for the page older than a message id. Each file is an attachment with an id and a data_url
// on the instance's host unless the test says otherwise.
interface Msg {
  id: number;
  createdAt: number;
  type?: "in" | "out";
  private?: boolean;
  senderType?: "contact" | "user" | "agent_bot";
  senderId?: number;
  files?: Array<{
    id: number;
    type?: string;
    host?: string;
    size?: number;
    name?: string;
  }>;
}

const INSTANCE = "https://cw.example";
const CONTACT = 5;

function fake(
  opts: {
    messages?: Msg[];
    caseAttrs?: Record<string, unknown>;
    // attachment id → how its download answers
    download?: Record<number, "fail" | "413" | number>;
    uploadFails?: boolean;
    caseReadFails?: boolean;
  } = {},
) {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const caseAttrs: Record<string, unknown> = { ...(opts.caseAttrs ?? {}) };
  const messages = [...(opts.messages ?? [])].sort((a, b) => a.id - b.id);
  const bytesOf = (id: number) => {
    const d = opts.download?.[id];
    const n = typeof d === "number" ? d : 8;
    const out = new Uint8Array(n);
    out.fill(id % 251);
    return out.buffer;
  };
  const client: CarryClient = {
    conversationUrl: (id: number) =>
      `${INSTANCE}/app/accounts/1/conversations/${id}`,
    getConversation: async (id: number) => {
      calls.push({ fn: "getConversation", args: [id] });
      if (opts.caseReadFails) throw new ChatwootApiError(500, "GET");
      return { id, custom_attributes: { ...caseAttrs } };
    },
    getMessages: async (id: number, o?: { before?: number }) => {
      calls.push({ fn: "getMessages", args: [id, o] });
      const older = messages.filter(
        (m) => o?.before == null || m.id < o.before,
      );
      return {
        payload: older.slice(-20).map((m) => ({
          id: m.id,
          created_at: m.createdAt,
          message_type: m.type === "out" ? 1 : 0,
          private: m.private ?? false,
          sender_type:
            m.senderType === "user"
              ? "User"
              : m.senderType === "agent_bot"
                ? "AgentBot"
                : "Contact",
          sender_id: m.senderId ?? CONTACT,
          attachments: (m.files ?? []).map((f) => ({
            id: f.id,
            file_type: f.type ?? "file",
            data_url: `${f.host ?? INSTANCE}/rails/active_storage/blobs/${f.id}/${f.name ?? `doc-${f.id}.pdf`}`,
            ...(f.size != null ? { file_size: f.size } : {}),
          })),
        })),
      };
    },
    isInstanceUrl: (url: string) =>
      new URL(url).host === new URL(INSTANCE).host,
    downloadAttachment: async (url: string) => {
      calls.push({ fn: "downloadAttachment", args: [url] });
      const id = Number(url.split("/blobs/")[1]?.split("/")[0]);
      const d = opts.download?.[id];
      if (d === "fail") throw new ChatwootApiError(500, "GET attachment");
      if (d === "413") throw new ChatwootApiError(413, "GET attachment");
      return { bytes: bytesOf(id), contentType: "application/pdf" };
    },
    sendFilesAsAdmin: async (id, files, o) => {
      calls.push({ fn: "sendFilesAsAdmin", args: [id, files, o] });
      if (opts.uploadFails) throw new ChatwootApiError(422, "POST files");
      return {};
    },
    sendMessageAsAdmin: async (id, content, o) => {
      calls.push({ fn: "sendMessageAsAdmin", args: [id, content, o] });
      return {};
    },
    setConversationCustomAttributes: async (id, attrs, o) => {
      calls.push({
        fn: "setConversationCustomAttributes",
        args: [id, attrs, o],
      });
      Object.assign(caseAttrs, attrs);
      return {};
    },
  } as CarryClient;
  return { client, calls, caseAttrs };
}

function carryInput(
  config: Partial<CarryAttachmentsConfig>,
  over: Partial<CarryInput> = {},
): CarryInput {
  return {
    config: { ...CARRY_ATTACHMENTS_DEFAULTS, mode: "conversation", ...config },
    originConversationId: 7,
    originContactId: CONTACT,
    caseId: 100,
    ...over,
  };
}

const uploads = (calls: Array<{ fn: string; args: unknown[] }>) =>
  calls.filter((c) => c.fn === "sendFilesAsAdmin");
const uploadedNames = (call: { args: unknown[] } | undefined) =>
  ((call?.args[1] ?? []) as Array<{ fileName: string }>).map((f) => f.fileName);

describe("readCarryAttachments", () => {
  test("off by default, images and documents, ten files", () => {
    expect(readCarryAttachments(undefined)).toEqual({
      mode: "off",
      fileTypes: ["image", "file"],
      maxFiles: 10,
    });
    expect(readCarryAttachments({ mode: "everything" }).mode).toBe("off");
  });

  test("maxFiles is clamped to 1-20, and unknown file types are dropped", () => {
    expect(
      readCarryAttachments({
        mode: "conversation",
        maxFiles: 0,
        fileTypes: ["file", "desconhecido"],
      }),
    ).toEqual({ mode: "conversation", fileTypes: ["file"], maxFiles: 1 });
    expect(readCarryAttachments({ maxFiles: 25 }).maxFiles).toBe(20);
    expect(readCarryAttachments({ maxFiles: "7" }).maxFiles).toBe(7);
    expect(
      readCarryAttachments({ fileTypes: ["VIDEO", "audio", "audio"] })
        .fileTypes,
    ).toEqual(["video", "audio"]);
    // An empty list reads as the default rather than as a second way to switch it off.
    expect(readCarryAttachments({ fileTypes: [] }).fileTypes).toEqual([
      "image",
      "file",
    ]);
  });
});

describe("carryCaseAttachments", () => {
  test("off: nothing is read and nothing is written", async () => {
    const f = fake({
      messages: [{ id: 1, createdAt: 10, files: [{ id: 11 }] }],
    });
    expect(
      await carryCaseAttachments(f.client, carryInput({ mode: "off" })),
    ).toBeNull();
    expect(f.calls).toEqual([]);
  });

  test("conversation: every contact file, in ONE private note with the bytes and a caption", async () => {
    const f = fake({
      messages: [
        {
          id: 1,
          createdAt: 10,
          files: [{ id: 11, type: "image", name: "a.jpg" }],
        },
        { id: 2, createdAt: 20, type: "out", files: [{ id: 12 }] },
        {
          id: 3,
          createdAt: 30,
          files: [
            { id: 13, name: "b.pdf" },
            { id: 14, name: "c.pdf" },
          ],
        },
      ],
    });
    const out = await carryCaseAttachments(f.client, carryInput({}));
    expect(out).toEqual({ carried: 3, skipped: 0, failed: 0 });
    const up = uploads(f.calls);
    expect(up).toHaveLength(1);
    expect(up[0]?.args[0]).toBe(100);
    // Oldest first, the order the customer sent them.
    expect(uploadedNames(up[0])).toEqual(["a.jpg", "b.pdf", "c.pdf"]);
    const sent = (up[0]?.args[1] ?? []) as Array<{ bytes: ArrayBuffer }>;
    expect(new Uint8Array(sent[0]?.bytes ?? new ArrayBuffer(0))[0]).toBe(11);
    const o = up[0]?.args[2] as { private: boolean; content: string };
    expect(o.private).toBe(true);
    expect(o.content).toContain(
      "Anexos enviados pelo cliente na conversa de origem (3)",
    );
    expect(o.content).toContain("/conversations/7");
    // The record of what the case got: message and attachment.
    expect(f.caseAttrs[CROSS_INBOX_CASE_CARRIED_ATTRIBUTE]).toBe(
      "1:11,3:13,3:14",
    );
    expect(f.calls.some((c) => c.fn === "sendMessageAsAdmin")).toBe(false);
  });

  test("attendance: only files after the boundary memory compaction cut", async () => {
    const f = fake({
      messages: [
        { id: 1, createdAt: 100, files: [{ id: 11 }] },
        { id: 2, createdAt: 200, files: [{ id: 12 }] },
        { id: 3, createdAt: 1000, files: [{ id: 13 }] },
        {
          id: 4,
          createdAt: 1100,
          files: [{ id: 14 }, { id: 15, type: "image" }],
        },
      ],
    });
    const out = await carryCaseAttachments(
      f.client,
      carryInput(
        { mode: "attendance" },
        { attendanceStartedAt: async () => new Date(500 * 1000) },
      ),
    );
    expect(out).toEqual({ carried: 3, skipped: 0, failed: 0 });
    expect(uploadedNames(uploads(f.calls)[0])).toEqual([
      "doc-13.pdf",
      "doc-14.pdf",
      "doc-15.pdf",
    ]);
  });

  test("attendance with no compaction yet is the whole conversation", async () => {
    const f = fake({
      messages: [
        { id: 1, createdAt: 100, files: [{ id: 11 }] },
        { id: 2, createdAt: 900, files: [{ id: 12 }] },
      ],
    });
    const out = await carryCaseAttachments(
      f.client,
      carryInput(
        { mode: "attendance" },
        { attendanceStartedAt: async () => null },
      ),
    );
    expect(out?.carried).toBe(2);
  });

  test("attendance whose boundary cannot be read carries nothing, not the whole conversation", async () => {
    const f = fake({
      messages: [{ id: 1, createdAt: 100, files: [{ id: 11 }] }],
    });
    const out = await carryCaseAttachments(
      f.client,
      carryInput(
        { mode: "attendance" },
        {
          attendanceStartedAt: async () => {
            throw new Error("db down");
          },
        },
      ),
    );
    expect(out).toEqual({
      carried: 0,
      skipped: 0,
      failed: 0,
      unread: "attendance",
    });
    expect(uploads(f.calls)).toHaveLength(0);
  });

  test("only the contact's own public incoming files are carried", async () => {
    const f = fake({
      messages: [
        { id: 1, createdAt: 10, files: [{ id: 11, name: "own.pdf" }] },
        {
          id: 2,
          createdAt: 20,
          type: "out",
          senderType: "user",
          files: [{ id: 12 }],
        },
        {
          id: 3,
          createdAt: 30,
          private: true,
          senderType: "user",
          files: [{ id: 13 }],
        },
        { id: 4, createdAt: 40, senderId: 99, files: [{ id: 14 }] },
        { id: 5, createdAt: 50, private: true, files: [{ id: 15 }] },
      ],
    });
    const out = await carryCaseAttachments(f.client, carryInput({}));
    expect(out?.carried).toBe(1);
    expect(uploadedNames(uploads(f.calls)[0])).toEqual(["own.pdf"]);
    const downloaded = f.calls.filter((c) => c.fn === "downloadAttachment");
    expect(downloaded).toHaveLength(1);
  });

  test("with no contact known, a file from anyone but a contact is still not carried", async () => {
    const f = fake({
      messages: [
        { id: 1, createdAt: 10, files: [{ id: 11, name: "own.pdf" }] },
        {
          id: 2,
          createdAt: 20,
          senderType: "agent_bot",
          senderId: 5,
          files: [{ id: 12 }],
        },
        {
          id: 3,
          createdAt: 30,
          senderType: "user",
          senderId: 5,
          files: [{ id: 13 }],
        },
      ],
    });
    const out = await carryCaseAttachments(
      f.client,
      carryInput({}, { originContactId: null }),
    );
    expect(out?.carried).toBe(1);
    expect(uploadedNames(uploads(f.calls)[0])).toEqual(["own.pdf"]);
  });

  test("fileTypes: a document is carried and an image is not even downloaded", async () => {
    const f = fake({
      messages: [
        {
          id: 1,
          createdAt: 10,
          files: [{ id: 11, type: "image" }, { id: 12 }],
        },
      ],
    });
    const out = await carryCaseAttachments(
      f.client,
      carryInput({ fileTypes: ["file"] }),
    );
    expect(out?.carried).toBe(1);
    expect(uploadedNames(uploads(f.calls)[0])).toEqual(["doc-12.pdf"]);
    expect(f.calls.filter((c) => c.fn === "downloadAttachment")).toHaveLength(
      1,
    );
  });

  test("maxFiles: the newest win and the note says how many were left out", async () => {
    const f = fake({
      messages: [301, 302, 303, 304, 305].map((id) => ({
        id,
        createdAt: id,
        files: [{ id: id * 10 }],
      })),
    });
    const out = await carryCaseAttachments(
      f.client,
      carryInput({ maxFiles: 3 }),
    );
    expect(out).toEqual({ carried: 3, skipped: 2, failed: 0 });
    expect(uploadedNames(uploads(f.calls)[0])).toEqual([
      "doc-3030.pdf",
      "doc-3040.pdf",
      "doc-3050.pdf",
    ]);
    const o = uploads(f.calls)[0]?.args[2] as { content: string };
    expect(o.content).toContain("(3 de 5)");
    expect(o.content).toContain("2 anexos ficaram de fora");
  });

  test("a case that already got some files gets only the new ones, and none when nothing is new", async () => {
    const messages: Msg[] = [
      { id: 301, createdAt: 1, files: [{ id: 11 }] },
      { id: 302, createdAt: 2, files: [{ id: 12 }] },
    ];
    const f = fake({ messages });
    expect(
      (await carryCaseAttachments(f.client, carryInput({})))?.carried,
    ).toBe(2);
    const second = fake({ messages, caseAttrs: { ...f.caseAttrs } });
    expect(await carryCaseAttachments(second.client, carryInput({}))).toEqual({
      carried: 0,
      skipped: 0,
      failed: 0,
    });
    expect(uploads(second.calls)).toHaveLength(0);
    expect(second.calls.some((c) => c.fn === "downloadAttachment")).toBe(false);
    const third = fake({
      messages: [...messages, { id: 303, createdAt: 3, files: [{ id: 13 }] }],
      caseAttrs: { ...f.caseAttrs },
    });
    expect(
      (await carryCaseAttachments(third.client, carryInput({})))?.carried,
    ).toBe(1);
    expect(uploadedNames(uploads(third.calls)[0])).toEqual(["doc-13.pdf"]);
    expect(third.caseAttrs[CROSS_INBOX_CASE_CARRIED_ATTRIBUTE]).toBe(
      "301:11,302:12,303:13",
    );
  });

  test("a download that fails is counted, the others still go, and the note says so", async () => {
    const f = fake({
      messages: [
        { id: 1, createdAt: 1, files: [{ id: 11 }, { id: 12 }, { id: 13 }] },
      ],
      download: { 13: "fail" },
    });
    const out = await carryCaseAttachments(f.client, carryInput({}));
    expect(out).toEqual({ carried: 2, skipped: 0, failed: 1 });
    const o = uploads(f.calls)[0]?.args[2] as { content: string };
    expect(o.content).toContain("1 anexo não pôde ser copiado");
    // The failed one is not recorded, so a later call tries it again.
    expect(f.caseAttrs[CROSS_INBOX_CASE_CARRIED_ATTRIBUTE]).toBe("1:11,1:12");
  });

  test("an upload that fails leaves a text note saying files could not be copied", async () => {
    const f = fake({
      messages: [{ id: 1, createdAt: 1, files: [{ id: 11 }] }],
      uploadFails: true,
    });
    const out = await carryCaseAttachments(f.client, carryInput({}));
    expect(out).toEqual({ carried: 0, skipped: 0, failed: 1 });
    const notes = f.calls.filter((c) => c.fn === "sendMessageAsAdmin");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.args[1]).toContain("1 anexo não pôde ser copiado");
    expect(notes[0]?.args[2]).toEqual({ private: true });
    expect(f.caseAttrs[CROSS_INBOX_CASE_CARRIED_ATTRIBUTE]).toBeUndefined();
  });

  test("a file on another host is never requested", async () => {
    const f = fake({
      messages: [
        {
          id: 1,
          createdAt: 1,
          files: [{ id: 11, host: "https://elsewhere.example" }, { id: 12 }],
        },
      ],
    });
    const out = await carryCaseAttachments(f.client, carryInput({}));
    expect(out).toEqual({ carried: 1, skipped: 1, failed: 0 });
    const urls = f.calls
      .filter((c) => c.fn === "downloadAttachment")
      .map((c) => String(c.args[0]));
    expect(urls.every((u) => u.startsWith(INSTANCE))).toBe(true);
    expect(urls).toHaveLength(1);
  });

  test("a file over the ceiling is skipped, by its declared size or by what came down", async () => {
    const f = fake({
      messages: [
        {
          id: 1,
          createdAt: 1,
          files: [{ id: 11, size: 101 }, { id: 12, size: 99 }, { id: 13 }],
        },
      ],
      download: { 12: 99, 13: 150 },
    });
    const out = await carryCaseAttachments(
      f.client,
      carryInput({}, { maxFileBytes: 100 }),
    );
    expect(out).toEqual({ carried: 1, skipped: 2, failed: 0 });
    expect(uploadedNames(uploads(f.calls)[0])).toEqual(["doc-12.pdf"]);
    expect(
      f.calls.some(
        (c) =>
          c.fn === "downloadAttachment" && String(c.args[0]).includes("/11/"),
      ),
    ).toBe(false);
  });

  test("the download refusing a big file (413) is a skip, not a failure", async () => {
    const f = fake({
      messages: [{ id: 1, createdAt: 1, files: [{ id: 11 }] }],
      download: { 11: "413" },
    });
    expect(await carryCaseAttachments(f.client, carryInput({}))).toEqual({
      carried: 0,
      skipped: 1,
      failed: 0,
    });
    expect(f.calls.some((c) => c.fn === "sendMessageAsAdmin")).toBe(false);
  });

  test("no files: no note, no download, no upload", async () => {
    const f = fake({ messages: [{ id: 1, createdAt: 1 }] });
    expect(await carryCaseAttachments(f.client, carryInput({}))).toEqual({
      carried: 0,
      skipped: 0,
      failed: 0,
    });
    expect(
      f.calls
        .map((c) => c.fn)
        .filter((fn) => fn !== "getMessages" && fn !== "getConversation"),
    ).toEqual([]);
  });

  test("the walk goes back past the newest page", async () => {
    const messages: Msg[] = Array.from({ length: 45 }, (_, i) => ({
      id: i + 1,
      createdAt: i + 1,
      ...(i === 0 ? { files: [{ id: 900, name: "first.pdf" }] } : {}),
    }));
    const f = fake({ messages });
    const out = await carryCaseAttachments(f.client, carryInput({}));
    expect(out?.carried).toBe(1);
    expect(uploadedNames(uploads(f.calls)[0])).toEqual(["first.pdf"]);
  });

  test("a run called off before the note writes nothing", async () => {
    const f = fake({
      messages: [{ id: 1, createdAt: 1, files: [{ id: 11 }] }],
    });
    const out = await carryCaseAttachments(
      f.client,
      carryInput({}, { stillWanted: async () => false }),
    );
    expect(out?.calledOff).toBe(true);
    expect(uploads(f.calls)).toHaveLength(0);
    expect(
      f.calls.some((c) => c.fn === "setConversationCustomAttributes"),
    ).toBe(false);
  });

  test("a case that cannot be read gets nothing, rather than the same files twice", async () => {
    const f = fake({
      messages: [{ id: 1, createdAt: 1, files: [{ id: 11 }] }],
      caseReadFails: true,
    });
    expect(await carryCaseAttachments(f.client, carryInput({}))).toEqual({
      carried: 0,
      skipped: 0,
      failed: 0,
      unread: "case",
    });
    expect(uploads(f.calls)).toHaveLength(0);
  });
});
