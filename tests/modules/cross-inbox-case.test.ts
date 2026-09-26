import { describe, expect, test } from "bun:test";
import { ToolMessage } from "@langchain/core/messages";
import { owesHandbackNote } from "@/graph/handback";
import { OPEN_CASE_HANDED_MARK } from "@/graph/tools/catalog";
import { buildNativeTools } from "@/graph/tools/native";
import { ChatwootApiError, ChatwootClient } from "@/modules/chatwoot/client";
import { withConversationLabels } from "@/modules/chatwoot/labels";
import {
  type CaseClient,
  customerTyped,
  destinationIdentity,
  normalizeEmail,
  OPENING_OUTSIDE_WINDOW_PREFIX,
  type OpenCaseInput,
  openCaseInInbox,
} from "@/modules/cross-inbox-case/service";
import {
  CROSS_INBOX_CASE_DEFAULTS,
  readCrossInboxCaseConfig,
} from "@/modules/cross-inbox-case/settings";

// A Chatwoot account small enough to reason about: contacts, conversations with their inbox, status,
// custom attributes and labels, and every call recorded in order.
interface Conv {
  id: number;
  inboxId: number;
  contactId: number;
  status: string;
  attrs: Record<string, unknown>;
  labels: string[];
}

function fakeChatwoot(
  opts: {
    inboxes?: Record<number, { name: string; channel_type: string }>;
    contacts?: Record<number, { email?: string | null; phone?: string | null }>;
    convs?: Conv[];
    incoming?: string[];
    failOn?: Set<string>;
    continueOpen?: boolean;
    // Chatwoot's lock_to_single_conversation: the contact's LAST conversation in the inbox comes back
    // whatever its state, and the status asked for is not applied.
    lockToSingle?: boolean;
    // Runs right after the create, standing for an automation or a person acting in that window.
    afterCreate?: (id: number) => void;
    // Chatwoot's `can_reply` on what the create answers.
    canReply?: boolean;
    // The fork's contact-conversations listing answers only the newest N.
    listNewest?: number;
    // A wait inside the listing, so two concurrent calls can both list before either creates.
    listDelayMs?: number;
  } = {},
) {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const inboxes = opts.inboxes ?? {
    40: { name: "E-mail SAC", channel_type: "Channel::Email" },
  };
  const contacts = new Map(
    Object.entries(
      opts.contacts ?? { 5: { email: "ana@exemplo.com", phone: "+5511999" } },
    ).map(([k, v]) => [Number(k), { ...v }]),
  );
  const convs: Conv[] = opts.convs ?? [
    {
      id: 7,
      inboxId: 10,
      contactId: 5,
      status: "pending",
      attrs: {},
      labels: [],
    },
  ];
  let nextId = 100;
  const fail = (fn: string) => {
    if (opts.failOn?.has(fn)) throw new ChatwootApiError(500, fn);
  };
  const conv = (id: number) => {
    const c = convs.find((x) => x.id === id);
    if (!c) throw new ChatwootApiError(404, `GET /conversations/${id}`);
    return c;
  };
  const record = (fn: string, args: unknown[]) => {
    calls.push({ fn, args });
    fail(fn);
  };
  const client: CaseClient = {
    conversationUrl: (id: number) =>
      `https://cw.example/app/accounts/1/conversations/${id}`,
    getInbox: async (id: number) => {
      record("getInbox", [id]);
      const ib = inboxes[id];
      if (!ib) throw new ChatwootApiError(404, `GET /inboxes/${id}`);
      return { id, ...ib };
    },
    getConversation: async (id: number) => {
      record("getConversation", [id]);
      const c = conv(id);
      return {
        id: c.id,
        inbox_id: c.inboxId,
        status: c.status,
        custom_attributes: { ...c.attrs },
      };
    },
    getContact: async (id: number) => {
      record("getContact", [id]);
      const c = contacts.get(id);
      return c
        ? {
            id,
            name: null,
            email: c.email ?? null,
            phoneNumber: c.phone ?? null,
          }
        : null;
    },
    updateContact: async (id: number, fields: { email?: string }) => {
      record("updateContact", [id, fields]);
      if (fields.email) {
        for (const [otherId, other] of contacts) {
          if (
            otherId !== id &&
            other.email?.toLowerCase() === fields.email.toLowerCase()
          ) {
            throw new ChatwootApiError(422, `PUT /contacts/${id}`);
          }
        }
        const c = contacts.get(id);
        if (c) c.email = fields.email;
      }
      return {};
    },
    findContactIdByEmail: async (email: string) => {
      record("findContactIdByEmail", [email]);
      for (const [id, c] of contacts) {
        if (c.email?.toLowerCase() === email.toLowerCase()) return id;
      }
      return null;
    },
    mergeContacts: async (base: number, mergee: number) => {
      record("mergeContacts", [base, mergee]);
      const b = contacts.get(base);
      const m = contacts.get(mergee);
      if (b && m) b.email = b.email ?? m.email;
      contacts.delete(mergee);
      for (const c of convs) if (c.contactId === mergee) c.contactId = base;
      return {};
    },
    listContactConversations: async (contactId: number) => {
      record("listContactConversations", [contactId]);
      // Read first, answered after the wait: what the server saw when the request arrived.
      const listed = convs
        .filter((c) => c.contactId === contactId)
        .sort((a, b) => b.id - a.id)
        .slice(0, opts.listNewest ?? Number.MAX_SAFE_INTEGER)
        .map((c) => ({ id: c.id, inboxId: c.inboxId, status: c.status }));
      if (opts.listDelayMs) {
        await new Promise((res) => setTimeout(res, opts.listDelayMs));
      }
      return listed;
    },
    createConversation: async (p) => {
      record("createConversation", [p]);
      if (opts.lockToSingle) {
        const last = convs
          .filter((c) => c.contactId === p.contactId && c.inboxId === p.inboxId)
          .at(-1);
        if (last)
          return {
            id: last.id,
            inboxId: last.inboxId,
            status: last.status,
            canReply: opts.canReply ?? null,
          };
      }
      if (opts.continueOpen) {
        const open = convs
          .filter(
            (c) =>
              c.contactId === p.contactId &&
              c.inboxId === p.inboxId &&
              c.status !== "resolved",
          )
          .at(-1);
        if (open) {
          open.status = p.status;
          Object.assign(open.attrs, p.customAttributes);
          return {
            id: open.id,
            inboxId: open.inboxId,
            status: open.status,
            canReply: opts.canReply ?? null,
          };
        }
      }
      const c: Conv = {
        id: nextId++,
        inboxId: p.inboxId,
        contactId: p.contactId,
        status: p.status,
        attrs: { ...p.customAttributes },
        labels: [],
      };
      convs.push(c);
      opts.afterCreate?.(c.id);
      return {
        id: c.id,
        inboxId: c.inboxId,
        status: c.status,
        canReply: opts.canReply ?? null,
      };
    },
    sendMessageAsAdmin: async (id: number, content: string, o) => {
      record("sendMessageAsAdmin", [id, content, o]);
      return {};
    },
    sendPrivateNote: async (id: number, content: string) => {
      record("sendPrivateNote", [id, content]);
      return {};
    },
    getMessages: async (id: number) => {
      record("getMessages", [id]);
      return {
        payload: [
          ...(opts.incoming ?? []).map((content) => ({
            message_type: 0,
            content,
          })),
          // The agent's own words never count as the customer typing an address.
          { message_type: 1, content: "Pode ser outro@exemplo.com?" },
        ],
      };
    },
    getConversationLabels: async (id: number) => {
      record("getConversationLabels", [id]);
      return [...conv(id).labels];
    },
    setConversationLabels: async (id: number, labels: string[], o) => {
      record("setConversationLabels", [id, labels, o]);
      conv(id).labels = [...labels];
      return {};
    },
    toggleStatus: async (id: number, status: string, o?: unknown) => {
      record("toggleStatus", [id, status, o]);
      conv(id).status = status;
      return {};
    },
    setConversationCustomAttributes: async (
      id: number,
      attrs: Record<string, unknown>,
      o?: { stillWanted?: () => Promise<boolean> },
    ) => {
      record("setConversationCustomAttributes", [id, attrs]);
      if (o?.stillWanted && !(await o.stillWanted())) return {};
      Object.assign(conv(id).attrs, attrs);
      return {};
    },
  } as CaseClient;
  return { client, calls, convs, contacts };
}

const WRITES = new Set([
  "toggleStatus",
  "updateContact",
  "mergeContacts",
  "createConversation",
  "sendMessageAsAdmin",
  "sendPrivateNote",
  "setConversationLabels",
  "setConversationCustomAttributes",
]);

function input(over: Partial<OpenCaseInput> = {}): OpenCaseInput {
  return {
    config: { ...CROSS_INBOX_CASE_DEFAULTS, targetInboxId: 40 },
    originConversationId: 7,
    originContactId: 5,
    reason: "cliente pediu atendente humano",
    customerMessage: "Olá! Abrimos seu atendimento por aqui.",
    email: null,
    labels: [],
    ...over,
  };
}

const writesOf = (calls: Array<{ fn: string }>) =>
  calls.filter((c) => WRITES.has(c.fn)).map((c) => c.fn);

describe("settings", () => {
  test("defaults: no inbox, no label, the default key, no merge", () => {
    expect(readCrossInboxCaseConfig({})).toEqual(CROSS_INBOX_CASE_DEFAULTS);
    expect(readCrossInboxCaseConfig({ crossInboxCase: [] })).toEqual(
      CROSS_INBOX_CASE_DEFAULTS,
    );
  });

  test("merge only when it is literally true", () => {
    expect(
      readCrossInboxCaseConfig({ crossInboxCase: { mergeContacts: "true" } })
        .mergeContacts,
    ).toBe(false);
    expect(
      readCrossInboxCaseConfig({ crossInboxCase: { mergeContacts: true } })
        .mergeContacts,
    ).toBe(true);
  });

  test("an inbox id, a trimmed label, and a key the dashboard can show", () => {
    expect(
      readCrossInboxCaseConfig({
        crossInboxCase: {
          targetInboxId: "40",
          originLabel: "  caso-email ",
          caseAttributeKey: "protocolo",
        },
      }),
    ).toEqual({
      targetInboxId: 40,
      targetInstanceId: null,
      originLabel: "caso-email",
      caseAttributeKey: "protocolo",
      mergeContacts: false,
      resolveOrigin: false,
    });
    const bad = readCrossInboxCaseConfig({
      crossInboxCase: { targetInboxId: 0, caseAttributeKey: "Protocolo X" },
    });
    expect(bad.targetInboxId).toBeNull();
    expect(bad.caseAttributeKey).toBe("case_conversation_id");
  });
});

describe("pure helpers", () => {
  test("which identity each destination channel needs", () => {
    expect(destinationIdentity("Channel::Email")).toBe("email");
    expect(destinationIdentity("Channel::Whatsapp")).toBe("phone");
    expect(destinationIdentity("Channel::Sms")).toBe("phone");
    expect(destinationIdentity("Channel::TwilioSms")).toBe("phone");
    expect(destinationIdentity("Channel::Api")).toBe("none");
    expect(destinationIdentity("Channel::WebWidget")).toBe("none");
    expect(destinationIdentity("Channel::Instagram")).toBeNull();
    expect(destinationIdentity(null)).toBeNull();
  });

  test("an address is an address", () => {
    expect(normalizeEmail(" ana@exemplo.com ")).toBe("ana@exemplo.com");
    expect(normalizeEmail("mailto:ana@exemplo.com")).toBe("ana@exemplo.com");
    expect(normalizeEmail("joao@")).toBeNull();
    expect(normalizeEmail("joao@exemplo")).toBeNull();
    expect(normalizeEmail("a b@exemplo.com")).toBeNull();
  });

  test("a whole address, never a piece of a longer one", () => {
    // Review round 1: a substring match let a truncated address through.
    expect(customerTyped(["joanna@example.com.br"], "anna@example.com")).toBe(
      false,
    );
    expect(customerTyped(["anna@example.com.br"], "anna@example.com")).toBe(
      false,
    );
    expect(customerTyped(["é ana@exemplo.com."], "ana@exemplo.com")).toBe(true);
    expect(customerTyped(["<ana@exemplo.com>"], "ana@exemplo.com")).toBe(true);
    expect(
      customerTyped(["mailto:ana@exemplo.com, obrigado"], "ana@exemplo.com"),
    ).toBe(true);
  });

  test("the customer typed it, in any case", () => {
    expect(
      customerTyped(["meu email é Ana@Exemplo.com"], "ana@exemplo.com"),
    ).toBe(true);
    expect(
      customerTyped(["meu email é ana@exemplo.co"], "ana@exemplo.com"),
    ).toBe(false);
  });
});

describe("openCaseInInbox", () => {
  test("no destination inbox: nothing is read or written", async () => {
    const f = fakeChatwoot();
    const r = await openCaseInInbox(
      f.client,
      input({ config: { ...CROSS_INBOX_CASE_DEFAULTS } }),
    );
    expect(r.kind).toBe("not_configured");
    expect(f.calls).toEqual([]);
  });

  test("a destination that cannot start a conversation is refused before any write", async () => {
    const f = fakeChatwoot({
      inboxes: { 40: { name: "Insta", channel_type: "Channel::Instagram" } },
    });
    const r = await openCaseInInbox(f.client, input());
    expect(r).toEqual({
      kind: "unsupported_channel",
      channelType: "Channel::Instagram",
    });
    expect(writesOf(f.calls)).toEqual([]);
  });

  test("the whole case: open conversation, number back on the origin, opening message, two-sided links, labels", async () => {
    const f = fakeChatwoot();
    const r = await openCaseInInbox(
      f.client,
      input({
        labels: ["financeiro"],
        config: {
          ...CROSS_INBOX_CASE_DEFAULTS,
          targetInboxId: 40,
          originLabel: "caso-aberto",
        },
      }),
    );
    expect(r).toMatchObject({
      kind: "opened",
      caseId: 100,
      identity: "held",
      partial: [],
    });
    const created = f.convs.find((c) => c.id === 100);
    expect(created).toMatchObject({
      inboxId: 40,
      contactId: 5,
      // Open, so the destination's own agent does not triage it again.
      status: "open",
      attrs: { origin_conversation_id: 7 },
      labels: ["financeiro"],
    });
    const origin = f.convs.find((c) => c.id === 7);
    expect(origin?.attrs).toEqual({ case_conversation_id: 100 });
    expect(origin?.labels).toEqual(["caso-aberto"]);
    // The origin is not closed, nor its status touched.
    expect(origin?.status).toBe("pending");
    const sends = f.calls.filter((c) => c.fn === "sendMessageAsAdmin");
    expect(sends.map((c) => c.args)).toEqual([
      [100, "Olá! Abrimos seu atendimento por aqui.", { private: false }],
      [100, "Motivo: cliente pediu atendente humano", { private: true }],
      [
        100,
        "⬅️ Caso aberto a partir da conversa: https://cw.example/app/accounts/1/conversations/7",
        { private: true },
      ],
    ]);
    expect(
      f.calls.filter((c) => c.fn === "sendPrivateNote").map((c) => c.args),
    ).toEqual([
      [
        7,
        "➡️ Caso aberto na caixa E-mail SAC: https://cw.example/app/accounts/1/conversations/100",
      ],
    ]);
    // The case number is written before anything else that follows the create.
    const after = writesOf(f.calls).slice(
      writesOf(f.calls).indexOf("createConversation") + 1,
    );
    expect(after[0]).toBe("setConversationCustomAttributes");
  });

  test("an origin label already there is not written twice", async () => {
    const f = fakeChatwoot({
      convs: [
        {
          id: 7,
          inboxId: 10,
          contactId: 5,
          status: "pending",
          attrs: {},
          labels: ["vip", "caso-aberto"],
        },
      ],
    });
    await openCaseInInbox(
      f.client,
      input({
        config: {
          ...CROSS_INBOX_CASE_DEFAULTS,
          targetInboxId: 40,
          originLabel: "caso-aberto",
        },
      }),
    );
    expect(f.convs.find((c) => c.id === 7)?.labels).toEqual([
      "vip",
      "caso-aberto",
    ]);
    expect(
      f.calls.some((c) => c.fn === "setConversationLabels" && c.args[0] === 7),
    ).toBe(false);
  });

  test("no opening message asked for: none is sent", async () => {
    const f = fakeChatwoot();
    await openCaseInInbox(f.client, input({ customerMessage: null }));
    expect(
      f.calls
        .filter((c) => c.fn === "sendMessageAsAdmin")
        .map((c) => (c.args[2] as { private: boolean }).private),
    ).toEqual([true, true]);
  });

  test("an open case this conversation already opened is the answer, not a second one", async () => {
    const f = fakeChatwoot({
      convs: [
        {
          id: 7,
          inboxId: 10,
          contactId: 5,
          status: "pending",
          attrs: { case_conversation_id: 55 },
          labels: [],
        },
        {
          id: 55,
          inboxId: 40,
          contactId: 5,
          status: "open",
          attrs: {},
          labels: [],
        },
      ],
    });
    const r = await openCaseInInbox(f.client, input());
    expect(r).toMatchObject({ kind: "already_open", caseId: 55 });
    expect(writesOf(f.calls)).toEqual([]);
  });

  test("a remembered case that went pending or snoozed is reopened before it is reported open", async () => {
    // Review round 4: out of the team's open queue is not "already with the team".
    for (const status of ["pending", "snoozed"]) {
      const f = fakeChatwoot({
        convs: [
          {
            id: 7,
            inboxId: 10,
            contactId: 5,
            status: "pending",
            attrs: { case_conversation_id: 55 },
            labels: [],
          },
          {
            id: 55,
            inboxId: 40,
            contactId: 5,
            status: "pending",
            attrs: {},
            labels: [],
          },
        ],
      });
      const remembered = f.convs.find((c) => c.id === 55);
      if (remembered) remembered.status = status;
      const r = await openCaseInInbox(f.client, input());
      expect(r).toMatchObject({ kind: "already_open", caseId: 55 });
      expect(f.convs.find((c) => c.id === 55)?.status).toBe("open");
      expect(f.calls.some((c) => c.fn === "createConversation")).toBe(false);
    }
  });

  test("a remembered case that cannot be reopened fails the opening", async () => {
    const f = fakeChatwoot({
      failOn: new Set(["toggleStatus"]),
      convs: [
        {
          id: 7,
          inboxId: 10,
          contactId: 5,
          status: "pending",
          attrs: { case_conversation_id: 55 },
          labels: [],
        },
        {
          id: 55,
          inboxId: 40,
          contactId: 5,
          status: "pending",
          attrs: {},
          labels: [],
        },
      ],
    });
    const r = await openCaseInInbox(f.client, input());
    expect(r).toMatchObject({ kind: "failed", step: "reopen_known_case" });
  });

  test("withdrawn before the remembered case is reopened: nothing is written", async () => {
    const f = fakeChatwoot({
      convs: [
        {
          id: 7,
          inboxId: 10,
          contactId: 5,
          status: "pending",
          attrs: { case_conversation_id: 55 },
          labels: [],
        },
        {
          id: 55,
          inboxId: 40,
          contactId: 5,
          status: "pending",
          attrs: {},
          labels: [],
        },
      ],
    });
    const r = await openCaseInInbox(
      f.client,
      input({ stillWanted: async () => false }),
    );
    expect(r.kind).toBe("called_off");
    expect(f.convs.find((c) => c.id === 55)?.status).toBe("pending");
  });

  test("a remembered case that is open is not toggled", async () => {
    const f = fakeChatwoot({
      convs: [
        {
          id: 7,
          inboxId: 10,
          contactId: 5,
          status: "pending",
          attrs: { case_conversation_id: 55 },
          labels: [],
        },
        {
          id: 55,
          inboxId: 40,
          contactId: 5,
          status: "open",
          attrs: {},
          labels: [],
        },
      ],
    });
    await openCaseInInbox(f.client, input());
    expect(f.calls.some((c) => c.fn === "toggleStatus")).toBe(false);
  });

  test("a destination that is this conversation's own inbox opens nothing", async () => {
    // Review round 4: the create could hand back the origin itself and flip it open under the turn.
    const f = fakeChatwoot({
      continueOpen: true,
      inboxes: { 10: { name: "WhatsApp", channel_type: "Channel::Api" } },
    });
    const r = await openCaseInInbox(
      f.client,
      input({ config: { ...CROSS_INBOX_CASE_DEFAULTS, targetInboxId: 10 } }),
    );
    expect(r.kind).toBe("same_inbox");
    expect(writesOf(f.calls)).toEqual([]);
    expect(f.convs.find((c) => c.id === 7)?.status).toBe("pending");
  });

  test("a closed reply window keeps the opening off the customer's channel and leaves it for the team", async () => {
    // Review round 4: an official WhatsApp destination rejects a free-form first message.
    const f = fakeChatwoot({
      canReply: false,
      inboxes: {
        40: { name: "WhatsApp oficial", channel_type: "Channel::Whatsapp" },
      },
    });
    const r = await openCaseInInbox(f.client, input());
    expect(r).toMatchObject({ kind: "opened", openingOutsideWindow: true });
    const opening = f.calls.filter(
      (c) =>
        c.fn === "sendMessageAsAdmin" &&
        String(c.args[1]).includes("Abrimos seu atendimento"),
    );
    expect(opening).toHaveLength(1);
    expect(opening[0]?.args[2]).toEqual({ private: true });
    expect(String(opening[0]?.args[1])).toStartWith(
      OPENING_OUTSIDE_WINDOW_PREFIX,
    );
  });

  test("an open reply window sends the opening to the customer", async () => {
    const f = fakeChatwoot({ canReply: true });
    const r = await openCaseInInbox(f.client, input());
    expect(r).not.toHaveProperty("openingOutsideWindow");
    const opening = f.calls.find(
      (c) =>
        c.fn === "sendMessageAsAdmin" &&
        String(c.args[1]).includes("Abrimos seu atendimento"),
    );
    expect(opening?.args[2]).toEqual({ private: false });
  });

  test("a continued case older than the listing reaches is still told apart by its number", async () => {
    // Review round 5: the listing is the newest 25, and absence from it is not a new case.
    const f = fakeChatwoot({
      continueOpen: true,
      listNewest: 1,
      convs: [
        {
          id: 60,
          inboxId: 40,
          contactId: 5,
          status: "open",
          attrs: {},
          labels: [],
        },
        {
          id: 70,
          inboxId: 10,
          contactId: 5,
          status: "pending",
          attrs: {},
          labels: [],
        },
        {
          id: 7,
          inboxId: 10,
          contactId: 5,
          status: "pending",
          attrs: {},
          labels: [],
        },
      ],
    });
    const r = await openCaseInInbox(f.client, input());
    expect(r).toMatchObject({ kind: "continued", caseId: 60 });
    expect(
      f.calls.filter(
        (c) =>
          c.fn === "sendMessageAsAdmin" &&
          (c.args[2] as { private: boolean }).private === false,
      ),
    ).toEqual([]);
  });

  test("two origins of one contact opening at once send one opening, to one case", async () => {
    // Review round 9: the per-origin queues ran side by side, both listed before either created, and
    // an inbox that continues open conversations handed both the same case as "opened".
    const f = fakeChatwoot({
      continueOpen: true,
      listDelayMs: 30,
      convs: [
        {
          id: 7,
          inboxId: 10,
          contactId: 5,
          status: "pending",
          attrs: {},
          labels: [],
        },
        {
          id: 8,
          inboxId: 11,
          contactId: 5,
          status: "pending",
          attrs: {},
          labels: [],
        },
      ],
    });
    const [a, b] = await Promise.all([
      openCaseInInbox(f.client, input({ originConversationId: 7 })),
      openCaseInInbox(f.client, input({ originConversationId: 8 })),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(["continued", "opened"]);
    const openings = f.calls.filter(
      (c) =>
        c.fn === "sendMessageAsAdmin" &&
        (c.args[2] as { private: boolean }).private === false,
    );
    expect(openings).toHaveLength(1);
  });

  test("a new case is numbered above what the contact had, and reads as opened", async () => {
    const f = fakeChatwoot({ listNewest: 1 });
    expect((await openCaseInInbox(f.client, input())).kind).toBe("opened");
  });

  test("a policy transfer that did not land stops the opening", async () => {
    // Review round 5: read as a plain drop, the case opened and resolveOrigin closed the origin.
    const f = fakeChatwoot();
    const r = await openCaseInInbox(
      f.client,
      input({ screenCustomerMessage: async () => "failed" }),
    );
    expect(r).toMatchObject({ kind: "failed", step: "guardrail_handoff" });
    expect(f.calls.some((c) => c.fn === "createConversation")).toBe(false);
  });

  test("the opening the customer receives is signed; the note of a closed window is not", async () => {
    // Review round 5: Chatwoot does not sign API sends.
    const sign = (t: string) => `${t}\n\nAna, fazer.ai`;
    const open = fakeChatwoot();
    await openCaseInInbox(open.client, input({ signCustomerMessage: sign }));
    const sent = open.calls.find(
      (c) =>
        c.fn === "sendMessageAsAdmin" &&
        (c.args[2] as { private: boolean }).private === false,
    );
    expect(sent?.args[1]).toBe(
      "Olá! Abrimos seu atendimento por aqui.\n\nAna, fazer.ai",
    );
    const closed = fakeChatwoot({ canReply: false });
    await openCaseInInbox(closed.client, input({ signCustomerMessage: sign }));
    expect(
      closed.calls.some((c) => String(c.args[1]).includes("Ana, fazer.ai")),
    ).toBe(false);
  });

  test("a case that was resolved, or lives in another inbox, does not block a new one", async () => {
    for (const known of [
      { status: "resolved", inboxId: 40 },
      { status: "open", inboxId: 41 },
    ]) {
      const f = fakeChatwoot({
        convs: [
          {
            id: 7,
            inboxId: 10,
            contactId: 5,
            status: "pending",
            attrs: { case_conversation_id: 55 },
            labels: [],
          },
          { id: 55, contactId: 5, attrs: {}, labels: [], ...known },
        ],
      });
      const r = await openCaseInInbox(f.client, input());
      expect(r.kind).toBe("opened");
    }
  });

  test("a case number that points at nothing does not block either", async () => {
    const f = fakeChatwoot({
      convs: [
        {
          id: 7,
          inboxId: 10,
          contactId: 5,
          status: "pending",
          attrs: { case_conversation_id: 999 },
          labels: [],
        },
      ],
    });
    expect((await openCaseInInbox(f.client, input())).kind).toBe("opened");
  });

  test("the inbox continues the contact's open case: no second conversation, no second opening email, labels kept", async () => {
    const f = fakeChatwoot({
      continueOpen: true,
      convs: [
        {
          id: 7,
          inboxId: 10,
          contactId: 5,
          status: "pending",
          attrs: {},
          labels: [],
        },
        {
          id: 60,
          inboxId: 40,
          contactId: 5,
          status: "pending",
          attrs: {},
          labels: ["vip"],
        },
      ],
    });
    const r = await openCaseInInbox(
      f.client,
      input({ labels: ["financeiro"] }),
    );
    expect(r).toMatchObject({ kind: "continued", caseId: 60 });
    expect(f.convs).toHaveLength(2);
    expect(
      f.calls
        .filter((c) => c.fn === "sendMessageAsAdmin")
        .some((c) => (c.args[2] as { private: boolean }).private === false),
    ).toBe(false);
    expect(f.convs.find((c) => c.id === 60)?.labels).toEqual([
      "vip",
      "financeiro",
    ]);
    // Continued, the case is back in the team's queue, and the links point at it.
    expect(f.convs.find((c) => c.id === 60)?.status).toBe("open");
    expect(f.calls.find((c) => c.fn === "sendPrivateNote")?.args[1]).toContain(
      "/conversations/60",
    );
  });

  test("two calls in one turn open one case", async () => {
    const f = fakeChatwoot();
    const [a, b] = await Promise.all([
      openCaseInInbox(f.client, input()),
      openCaseInInbox(f.client, input()),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(["already_open", "opened"]);
    expect(f.calls.filter((c) => c.fn === "createConversation")).toHaveLength(
      1,
    );
    expect(
      f.calls.filter(
        (c) =>
          c.fn === "sendMessageAsAdmin" &&
          (c.args[2] as { private: boolean }).private === false,
      ),
    ).toHaveLength(1);
  });

  describe("the email an email inbox needs", () => {
    const noEmail = { 5: { email: null, phone: "+5511999" } };

    test("none held and none given: ask, and write nothing", async () => {
      const f = fakeChatwoot({ contacts: noEmail });
      const r = await openCaseInInbox(f.client, input());
      expect(r.kind).toBe("needs_email");
      expect(writesOf(f.calls)).toEqual([]);
      expect(f.contacts.get(5)?.email).toBeNull();
    });

    test("an address that is not one is refused, and nothing is written", async () => {
      const f = fakeChatwoot({ contacts: noEmail, incoming: ["joao@"] });
      const r = await openCaseInInbox(f.client, input({ email: "joao@" }));
      expect(r).toEqual({ kind: "rejected_email", why: "invalid" });
      expect(writesOf(f.calls)).toEqual([]);
    });

    test("an address the customer did not type here is refused, and nothing is written", async () => {
      const f = fakeChatwoot({
        contacts: noEmail,
        incoming: ["quero falar com alguém"],
      });
      for (const email of ["ana@exemplo.com", "outro@exemplo.com"]) {
        const r = await openCaseInInbox(f.client, input({ email }));
        expect(r).toEqual({
          kind: "rejected_email",
          why: "not_in_conversation",
        });
      }
      expect(writesOf(f.calls)).toEqual([]);
    });

    test("an address the customer typed is written on the contact and the case opens", async () => {
      const f = fakeChatwoot({
        contacts: noEmail,
        incoming: ["meu e-mail é ana@exemplo.com"],
      });
      const r = await openCaseInInbox(
        f.client,
        input({ email: "ana@exemplo.com" }),
      );
      expect(r).toMatchObject({ kind: "opened", identity: "written" });
      expect(f.contacts.get(5)?.email).toBe("ana@exemplo.com");
      expect(f.contacts.size).toBe(1);
      expect(f.convs.find((c) => c.id === 100)?.contactId).toBe(5);
    });

    test("held by another contact, merge off: the case opens on that contact, nothing is merged", async () => {
      const f = fakeChatwoot({
        contacts: { ...noEmail, 9: { email: "Ana@Exemplo.com" } },
        incoming: ["ana@exemplo.com"],
      });
      const r = await openCaseInInbox(
        f.client,
        input({ email: "ana@exemplo.com" }),
      );
      expect(r).toMatchObject({ kind: "opened", identity: "other_contact" });
      expect(f.calls.some((c) => c.fn === "mergeContacts")).toBe(false);
      expect(f.contacts.size).toBe(2);
      expect(f.convs.find((c) => c.id === 100)?.contactId).toBe(9);
      // The origin still points at the case, so the halves stay joined.
      expect(f.convs.find((c) => c.id === 7)?.attrs).toEqual({
        case_conversation_id: 100,
      });
    });

    test("held by another contact, merge on: one contact with both histories, the origin contact kept", async () => {
      const f = fakeChatwoot({
        contacts: { ...noEmail, 9: { email: "ana@exemplo.com" } },
        convs: [
          {
            id: 7,
            inboxId: 10,
            contactId: 5,
            status: "pending",
            attrs: {},
            labels: [],
          },
          {
            id: 30,
            inboxId: 40,
            contactId: 9,
            status: "resolved",
            attrs: {},
            labels: [],
          },
        ],
        incoming: ["ana@exemplo.com"],
      });
      const r = await openCaseInInbox(
        f.client,
        input({
          email: "ana@exemplo.com",
          config: {
            ...CROSS_INBOX_CASE_DEFAULTS,
            targetInboxId: 40,
            mergeContacts: true,
          },
        }),
      );
      expect(r).toMatchObject({ kind: "opened", identity: "merged" });
      expect(f.calls.find((c) => c.fn === "mergeContacts")?.args).toEqual([
        5, 9,
      ]);
      expect([...f.contacts.keys()]).toEqual([5]);
      expect(f.contacts.get(5)?.email).toBe("ana@exemplo.com");
      expect(
        f.convs
          .filter((c) => c.contactId === 5)
          .map((c) => c.id)
          .sort(),
      ).toEqual([100, 30, 7].sort());
    });

    test("a refused write that is not a 422 fails, and nobody's address is looked up or merged", async () => {
      const f = fakeChatwoot({
        contacts: { ...noEmail, 9: { email: "ana@exemplo.com" } },
        incoming: ["ana@exemplo.com"],
      });
      f.client.updateContact = async () => {
        throw new ChatwootApiError(500, "PUT /contacts/5");
      };
      const r = await openCaseInInbox(
        f.client,
        input({
          email: "ana@exemplo.com",
          config: {
            ...CROSS_INBOX_CASE_DEFAULTS,
            targetInboxId: 40,
            mergeContacts: true,
          },
        }),
      );
      expect(r).toMatchObject({ kind: "failed", step: "write_email" });
      expect(
        f.calls.filter((c) =>
          [
            "findContactIdByEmail",
            "mergeContacts",
            "createConversation",
          ].includes(c.fn),
        ),
      ).toEqual([]);
    });

    test("a 422 whose holder is the contact itself is a failure, never a case on it", async () => {
      const f = fakeChatwoot({
        contacts: noEmail,
        incoming: ["ana@exemplo.com"],
      });
      f.client.updateContact = async () => {
        throw new ChatwootApiError(422, "PUT /contacts/5");
      };
      f.client.findContactIdByEmail = async () => 5;
      const r = await openCaseInInbox(
        f.client,
        input({ email: "ana@exemplo.com" }),
      );
      expect(r).toMatchObject({ kind: "failed", step: "find_email_holder" });
      expect(f.calls.some((c) => c.fn === "createConversation")).toBe(false);
    });

    test("called off during the holder search, merge on: nothing is merged", async () => {
      // Review round 3: the merge is the one write nothing undoes.
      let wanted = true;
      const f = fakeChatwoot({
        contacts: { ...noEmail, 9: { email: "ana@exemplo.com" } },
        incoming: ["ana@exemplo.com"],
      });
      const find = f.client.findContactIdByEmail;
      f.client.findContactIdByEmail = async (e: string) => {
        const r = await find(e);
        wanted = false;
        return r;
      };
      const r = await openCaseInInbox(
        f.client,
        input({
          email: "ana@exemplo.com",
          stillWanted: async () => wanted,
          config: {
            ...CROSS_INBOX_CASE_DEFAULTS,
            targetInboxId: 40,
            mergeContacts: true,
          },
        }),
      );
      expect(r.kind).toBe("called_off");
      expect(f.calls.some((c) => c.fn === "mergeContacts")).toBe(false);
      expect(f.contacts.size).toBe(2);
    });

    test("a 422 nobody explains is a failure, not a guess", async () => {
      const f = fakeChatwoot({
        contacts: noEmail,
        incoming: ["ana@exemplo.com"],
      });
      f.client.updateContact = async () => {
        throw new ChatwootApiError(422, "PUT /contacts/5");
      };
      const r = await openCaseInInbox(
        f.client,
        input({ email: "ana@exemplo.com" }),
      );
      expect(r).toMatchObject({ kind: "failed", step: "find_email_holder" });
      expect(f.calls.some((c) => c.fn === "createConversation")).toBe(false);
    });
  });

  test("a phone destination with no phone asks for a human instead", async () => {
    const f = fakeChatwoot({
      inboxes: { 40: { name: "WA", channel_type: "Channel::Whatsapp" } },
      contacts: { 5: { email: "ana@exemplo.com", phone: null } },
    });
    const r = await openCaseInInbox(f.client, input());
    expect(r.kind).toBe("needs_phone");
    expect(writesOf(f.calls)).toEqual([]);
  });

  test("called off after the reads: nothing is written", async () => {
    const f = fakeChatwoot();
    const r = await openCaseInInbox(
      f.client,
      input({ stillWanted: async () => false }),
    );
    expect(r.kind).toBe("called_off");
    expect(writesOf(f.calls)).toEqual([]);
  });

  test("called off during the last read before the create: no case, no opening", async () => {
    // Review round 1: the only ask sat before this read, so a withdrawal inside it still opened.
    const f = fakeChatwoot();
    let wanted = true;
    const list = f.client.listContactConversations;
    f.client.listContactConversations = async (id: number) => {
      const r = await list(id);
      wanted = false;
      return r;
    };
    const r = await openCaseInInbox(
      f.client,
      input({ stillWanted: async () => wanted }),
    );
    expect(r.kind).toBe("called_off");
    expect(writesOf(f.calls)).toEqual([]);
  });

  test("the opening message is screened before anything is written, and a refused one is not sent", async () => {
    const f = fakeChatwoot();
    const seen: string[] = [];
    const r = await openCaseInInbox(
      f.client,
      input({
        screenCustomerMessage: async (text) => {
          seen.push(`${text}|writes=${writesOf(f.calls).length}`);
          return "drop";
        },
      }),
    );
    expect(seen).toEqual(["Olá! Abrimos seu atendimento por aqui.|writes=0"]);
    expect(r).toMatchObject({ kind: "opened", openingBlocked: true });
    expect(
      f.calls.filter(
        (c) =>
          c.fn === "sendMessageAsAdmin" &&
          (c.args[2] as { private: boolean }).private === false,
      ),
    ).toEqual([]);
    // The case still opens, with its notes: the team still owes the customer.
    expect(f.calls.filter((c) => c.fn === "sendMessageAsAdmin")).toHaveLength(
      2,
    );
  });

  test("an opening the screening lets through is sent", async () => {
    const f = fakeChatwoot();
    const r = await openCaseInInbox(
      f.client,
      input({ screenCustomerMessage: async () => "send" }),
    );
    expect(r).toMatchObject({ kind: "opened" });
    expect((r as { openingBlocked?: boolean }).openingBlocked).toBeUndefined();
    expect(
      f.calls.filter(
        (c) =>
          c.fn === "sendMessageAsAdmin" &&
          (c.args[2] as { private: boolean }).private === false,
      ),
    ).toHaveLength(1);
  });

  test("a withdrawal queued ahead of the label write keeps it from putting a label back", async () => {
    // Review round 3: the fence ran before the queue's wait, and a reset inside it was undone.
    const f = fakeChatwoot();
    let wanted = true;
    const reset = withConversationLabels(1n, 7, async () => {
      await new Promise((res) => setTimeout(res, 30));
      wanted = false;
    });
    await Promise.all([
      reset,
      openCaseInInbox(
        f.client,
        input({
          tenantId: 1n,
          customerMessage: null,
          stillWanted: async () => wanted,
          config: {
            ...CROSS_INBOX_CASE_DEFAULTS,
            targetInboxId: 40,
            originLabel: "caso-aberto",
          },
        }),
      ),
    ]);
    expect(f.convs.find((c) => c.id === 7)?.labels).toEqual([]);
  });

  test("a withdrawal queued ahead of the case's label write keeps the case unlabelled", async () => {
    const f = fakeChatwoot();
    let wanted = true;
    let caseId = 0;
    const create = f.client.createConversation;
    f.client.createConversation = async (p) => {
      const r = await create(p);
      caseId = r.id;
      // A reset on the case itself, queued before the tool's label write reaches the queue.
      void withConversationLabels(1n, caseId, async () => {
        await new Promise((res) => setTimeout(res, 30));
        wanted = false;
      });
      return r;
    };
    await openCaseInInbox(
      f.client,
      input({
        tenantId: 1n,
        customerMessage: null,
        labels: ["urgente"],
        stillWanted: async () => wanted,
      }),
    );
    expect(caseId).toBeGreaterThan(0);
    expect(f.convs.find((c) => c.id === caseId)?.labels ?? []).toEqual([]);
  });

  test("the origin label waits in the queue every label writer shares", async () => {
    // Review round 1: a `set_labels` beside it read the same set, and the last write erased the other.
    const f = fakeChatwoot();
    const get = f.client.getConversationLabels;
    f.client.getConversationLabels = async (id: number) => {
      const r = await get(id);
      await new Promise((res) => setTimeout(res, 20));
      return r;
    };
    const other = withConversationLabels(1n, 7, async () => {
      const cur = await f.client.getConversationLabels(7);
      await f.client.setConversationLabels(7, [...cur, "vip"]);
    });
    await Promise.all([
      openCaseInInbox(
        f.client,
        input({
          tenantId: 1n,
          customerMessage: null,
          config: {
            ...CROSS_INBOX_CASE_DEFAULTS,
            targetInboxId: 40,
            originLabel: "caso-aberto",
          },
        }),
      ),
      other,
    ]);
    expect([...(f.convs.find((c) => c.id === 7)?.labels ?? [])].sort()).toEqual(
      ["caso-aberto", "vip"],
    );
  });

  test("the output check's policy transferred the origin: nothing is opened, nothing written", async () => {
    const f = fakeChatwoot();
    const r = await openCaseInInbox(
      f.client,
      input({ screenCustomerMessage: async () => "handed" }),
    );
    expect(r).toEqual({ kind: "handed_by_policy" });
    expect(writesOf(f.calls)).toEqual([]);
  });

  test("a locked inbox hands back the contact's closed conversation: it is reopened, not reported open while closed", async () => {
    const f = fakeChatwoot({
      lockToSingle: true,
      convs: [
        {
          id: 7,
          inboxId: 10,
          contactId: 5,
          status: "pending",
          attrs: {},
          labels: [],
        },
        {
          id: 60,
          inboxId: 40,
          contactId: 5,
          status: "resolved",
          attrs: {},
          labels: [],
        },
      ],
    });
    const r = await openCaseInInbox(f.client, input());
    expect(r).toMatchObject({ kind: "continued", caseId: 60, partial: [] });
    expect(f.convs.find((c) => c.id === 60)?.status).toBe("open");
    expect(f.calls.find((c) => c.fn === "toggleStatus")?.args).toEqual([
      60,
      "open",
      { asAdmin: true },
    ]);
  });

  test("a closed case that cannot be reopened fails the opening, and nothing claims it", async () => {
    // Review round 3: a swallowed reopen reported an open case, and resolveOrigin closed the origin.
    const f = fakeChatwoot({
      lockToSingle: true,
      failOn: new Set(["toggleStatus"]),
      convs: [
        {
          id: 7,
          inboxId: 10,
          contactId: 5,
          status: "pending",
          attrs: {},
          labels: [],
        },
        {
          id: 60,
          inboxId: 40,
          contactId: 5,
          status: "resolved",
          attrs: {},
          labels: [],
        },
      ],
    });
    const r = await openCaseInInbox(f.client, input());
    expect(r).toMatchObject({ kind: "failed", step: "reopen_case" });
    expect(f.convs.find((c) => c.id === 7)?.attrs).toEqual({});
  });

  test("an open case that comes back is not toggled again", async () => {
    const f = fakeChatwoot();
    await openCaseInInbox(f.client, input());
    expect(f.calls.some((c) => c.fn === "toggleStatus")).toBe(false);
  });

  test("labels a new case got after its create are kept", async () => {
    // Review round 2: a new case was assumed to have no labels, and the write replaced the set.
    const f = fakeChatwoot({
      afterCreate: (id) => {
        const c = f.convs.find((x) => x.id === id);
        if (c) c.labels.push("automacao");
      },
    });
    await openCaseInInbox(f.client, input({ labels: ["financeiro"] }));
    expect(f.convs.find((c) => c.id === 100)?.labels).toEqual([
      "automacao",
      "financeiro",
    ]);
  });

  test("called off after the create: nothing more is written, the attribute writer is fenced too", async () => {
    // Review round 2: the opening message, notes and labels went out after a withdrawal.
    let wanted = true;
    const f = fakeChatwoot({
      afterCreate: () => {
        wanted = false;
      },
    });
    const r = await openCaseInInbox(
      f.client,
      input({ labels: ["x"], stillWanted: async () => wanted }),
    );
    expect(r).toMatchObject({ kind: "opened", partial: ["called_off"] });
    const after = writesOf(f.calls).slice(
      writesOf(f.calls).indexOf("createConversation") + 1,
    );
    expect(after).toEqual([]);
  });

  test("the attribute writer gets the fence, for the ask it makes after its own read", async () => {
    const f = fakeChatwoot();
    let calls = 0;
    await openCaseInInbox(
      f.client,
      input({
        stillWanted: async () => {
          calls++;
          // Wanted for every ask the service makes; the writer's own ask, inside its queue, says no.
          return calls < 4;
        },
      }),
    );
    const attr = f.calls.find(
      (c) => c.fn === "setConversationCustomAttributes",
    );
    expect(attr).toBeDefined();
    expect(f.convs.find((c) => c.id === 7)?.attrs).toEqual({});
  });

  test("the create fails: failed at that step, and nothing claims a case", async () => {
    const f = fakeChatwoot({ failOn: new Set(["createConversation"]) });
    const r = await openCaseInInbox(f.client, input());
    expect(r).toMatchObject({ kind: "failed", step: "create_conversation" });
    expect(f.convs.find((c) => c.id === 7)?.attrs).toEqual({});
  });

  test("a note that does not land is reported, and the case stays open", async () => {
    const f = fakeChatwoot({ failOn: new Set(["sendPrivateNote"]) });
    const r = await openCaseInInbox(f.client, input());
    expect(r).toMatchObject({ kind: "opened", partial: ["origin_link_note"] });
  });
});

describe("the tool", () => {
  function toolFor(f: ReturnType<typeof fakeChatwoot>, extra = {}) {
    const toggles: string[] = [];
    const client = {
      ...f.client,
      muted: false,
      toggleStatus: async (id: number, status: string) => {
        toggles.push(`${id}:${status}`);
        return {};
      },
    } as unknown as ChatwootClient;
    const [t] = buildNativeTools(
      {
        client,
        conversationId: 7,
        crossInboxCase: {
          config: { ...CROSS_INBOX_CASE_DEFAULTS, targetInboxId: 40 },
          contactId: 5,
        },
        ...extra,
      },
      ["open_case_in_inbox"],
    );
    if (!t) throw new Error("tool not built");
    return { t, toggles };
  }

  test("the schema has no destination: the operator picks it, never the model", () => {
    const { t } = toolFor(fakeChatwoot());
    const shape = (t.schema as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(shape).sort()).toEqual([
      "customer_message",
      "email",
      "handoff_message",
      "labels",
      "reason",
    ]);
  });

  test("an extra argument naming another inbox reaches nothing", async () => {
    const f = fakeChatwoot({
      inboxes: {
        40: { name: "E-mail SAC", channel_type: "Channel::Email" },
        41: { name: "Outra", channel_type: "Channel::Email" },
      },
    });
    const { t } = toolFor(f);
    await t.invoke({ reason: "x", inbox_id: 41 } as never);
    expect(
      f.calls
        .filter((c) => c.fn === "createConversation")
        .map((c) => (c.args[0] as { inboxId: number }).inboxId),
    ).toEqual([40]);
  });

  test("opened: the model is told to tell the customer, and that the origin is not closed", async () => {
    const { t, toggles } = toolFor(fakeChatwoot());
    const out = String(await t.invoke({ reason: "x" }));
    expect(out).toContain("Case opened: conversation #100");
    expect(out).toContain("NOT closed");
    expect(toggles).toEqual([]);
  });

  describe("closing the origin, when the operator asks for it", () => {
    const turn = () => ({
      resolveRequested: false,
      pendingAttachments: [],
      imagesInFlight: 0,
      documentsInFlight: 0,
      attachmentsSeq: 0,
    });
    const withClose = (
      f: ReturnType<typeof fakeChatwoot>,
      resolveOrigin: boolean,
      extra: Record<string, unknown>,
    ) => {
      const client = {
        ...f.client,
        muted: false,
        toggleStatus: async () => ({}),
      } as unknown as ChatwootClient;
      const [t] = buildNativeTools(
        {
          client,
          conversationId: 7,
          crossInboxCase: {
            config: {
              ...CROSS_INBOX_CASE_DEFAULTS,
              targetInboxId: 40,
              resolveOrigin,
            },
            contactId: 5,
          },
          ...extra,
        },
        ["open_case_in_inbox"],
      );
      if (!t) throw new Error("tool not built");
      return t;
    };

    test("on: the close is SCHEDULED on the turn, the deferred path, never toggled here", async () => {
      const f = fakeChatwoot();
      const turnState = turn();
      const t = withClose(f, true, { turnState });
      const out = String(await t.invoke({ reason: "x" }));
      expect(turnState.resolveRequested).toBe(true);
      expect(out).toContain("marked resolved after your reply");
      expect(t.description).toContain("closed after your reply");
      // The origin's status is left to the runtime, which closes after delivery.
      expect(f.convs.find((c) => c.id === 7)?.status).toBe("pending");
    });

    test("on, and the case was already open: the close is still scheduled", async () => {
      const f = fakeChatwoot({
        convs: [
          {
            id: 7,
            inboxId: 10,
            contactId: 5,
            status: "pending",
            attrs: { case_conversation_id: 55 },
            labels: [],
          },
          {
            id: 55,
            inboxId: 40,
            contactId: 5,
            status: "open",
            attrs: {},
            labels: [],
          },
        ],
      });
      const turnState = turn();
      await withClose(f, true, { turnState }).invoke({ reason: "x" });
      expect(turnState.resolveRequested).toBe(true);
    });

    test("off: nothing is scheduled, and the model is told the conversation stays open", async () => {
      const f = fakeChatwoot();
      const turnState = turn();
      const t = withClose(f, false, { turnState });
      const out = String(await t.invoke({ reason: "x" }));
      expect(turnState.resolveRequested).toBe(false);
      expect(out).toContain("NOT closed");
      expect(t.description).toContain("does NOT close");
    });

    test("on, but the opening failed: nothing is scheduled, the conversation goes to people", async () => {
      const f = fakeChatwoot({ failOn: new Set(["createConversation"]) });
      const turnState = turn();
      await withClose(f, true, { turnState }).invoke({ reason: "x" });
      expect(turnState.resolveRequested).toBe(false);
    });

    test("on, but nothing was opened (email missing): nothing is scheduled", async () => {
      const f = fakeChatwoot({ contacts: { 5: { email: null } } });
      const turnState = turn();
      await withClose(f, true, { turnState }).invoke({ reason: "x" });
      expect(turnState.resolveRequested).toBe(false);
    });

    test("on, after this turn handed off: the conversation is the team's, nothing is scheduled", async () => {
      const f = fakeChatwoot();
      const turnState = turn();
      await withClose(f, true, {
        turnState,
        handoffState: { customerMessage: null, completed: true },
      }).invoke({ reason: "x" });
      expect(turnState.resolveRequested).toBe(false);
    });

    test("on, with no turn to defer to: the conversation is not closed immediately", async () => {
      const f = fakeChatwoot();
      const toggles: string[] = [];
      const client = {
        ...f.client,
        muted: false,
        toggleStatus: async (_id: number, status: string) => {
          toggles.push(status);
          return {};
        },
      } as unknown as ChatwootClient;
      const [t] = buildNativeTools(
        {
          client,
          conversationId: 7,
          crossInboxCase: {
            config: {
              ...CROSS_INBOX_CASE_DEFAULTS,
              targetInboxId: 40,
              resolveOrigin: true,
            },
            contactId: 5,
          },
        },
        ["open_case_in_inbox"],
      );
      const out = String(await t?.invoke({ reason: "x" }));
      expect(toggles).toEqual([]);
      expect(out).toContain("NOT closed");
    });
  });

  test("the turn's output screening decides whether the opening goes out", async () => {
    const f = fakeChatwoot();
    const screened: string[] = [];
    const { t } = toolFor(f, {
      screenCustomerText: async (text: string) => {
        screened.push(text);
        return "drop" as const;
      },
    });
    const out = String(
      await t.invoke({ reason: "x", customer_message: "Olá, abrimos." }),
    );
    expect(screened).toEqual(["Olá, abrimos."]);
    expect(out).toContain("refused by the output check");
    expect(
      f.calls.filter(
        (c) =>
          c.fn === "sendMessageAsAdmin" &&
          (c.args[2] as { private: boolean }).private === false,
      ),
    ).toEqual([]);
  });

  test("the email is asked for, not invented", async () => {
    const f = fakeChatwoot({ contacts: { 5: { email: null } } });
    const { t } = toolFor(f);
    const out = String(await t.invoke({ reason: "x" }));
    expect(out).toContain("Ask the customer for their email");
    expect(writesOf(f.calls)).toEqual([]);
  });

  test("a failed opening hands the conversation to a person, with a note saying why", async () => {
    const f = fakeChatwoot({ failOn: new Set(["createConversation"]) });
    const handoffState = { customerMessage: null, completed: false };
    const { t, toggles } = toolFor(f, { handoffState });
    const out = String(await t.invoke({ reason: "cliente pediu" }));
    expect(out).toContain("Could not open the case");
    expect(out).toContain("handed to the human team");
    expect(toggles).toEqual(["7:open"]);
    expect(handoffState.completed).toBe(true);
    const note = f.calls.find((c) => c.fn === "sendPrivateNote");
    expect(note?.args[0]).toBe(7);
    expect(String(note?.args[1])).toContain("create_conversation");
  });

  test("a failed opening hands the customer's line to the handoff's own delivery", async () => {
    const f = fakeChatwoot({ failOn: new Set(["createConversation"]) });
    const handoffState: {
      customerMessage: string | null;
      completed: boolean;
      declinedToSpeak?: boolean;
    } = { customerMessage: null, completed: false };
    const { t } = toolFor(f, { handoffState });
    const out = String(
      await t.invoke({
        reason: "x",
        handoff_message: "Vou passar para uma pessoa do time.",
      }),
    );
    expect(handoffState).toMatchObject({
      customerMessage: "Vou passar para uma pessoa do time.",
      completed: true,
      declinedToSpeak: false,
      // The status change is marked as the turn's own, so the ownership fence does not read it as a
      // person taking the conversation over.
      ownerChanged: true,
    });
    expect(out).toContain("do not repeat it");
  });

  test("a failed opening with no line is a silent transfer", async () => {
    // Review round 10: without the silence mark the model's next reply could still go out.
    const f = fakeChatwoot({ failOn: new Set(["createConversation"]) });
    const handoffState: {
      customerMessage: string | null;
      completed: boolean;
      declinedToSpeak?: boolean;
    } = { customerMessage: null, completed: false };
    const { t } = toolFor(f, { handoffState });
    await t.invoke({ reason: "x", handoff_message: "   " });
    expect(handoffState).toMatchObject({
      customerMessage: null,
      completed: true,
      declinedToSpeak: true,
    });
  });

  test("the model is told when the opening stayed a note, and when there was nowhere to move the case", async () => {
    const closed = toolFor(fakeChatwoot({ canReply: false }));
    expect(
      String(await closed.t.invoke({ reason: "x", customer_message: "Olá" })),
    ).toContain("Do not say a message was sent to them there");
    const same = toolFor(
      fakeChatwoot({
        inboxes: { 40: { name: "WhatsApp", channel_type: "Channel::Api" } },
        convs: [
          {
            id: 7,
            inboxId: 40,
            contactId: 5,
            status: "pending",
            attrs: {},
            labels: [],
          },
        ],
      }),
    );
    const out = String(await same.t.invoke({ reason: "x" }));
    expect(out).toContain("already in the destination inbox");
    expect(same.toggles).toEqual([]);
  });

  test("the tool hands the agent's signature to the opening", async () => {
    const f = fakeChatwoot();
    const { t } = toolFor(f, {
      crossInboxCase: {
        config: { ...CROSS_INBOX_CASE_DEFAULTS, targetInboxId: 40 },
        contactId: 5,
        sign: (x: string) => `${x} -- Ana`,
      },
    });
    await t.invoke({ reason: "x", customer_message: "Olá" });
    expect(
      f.calls.some(
        (c) => c.fn === "sendMessageAsAdmin" && c.args[1] === "Olá -- Ana",
      ),
    ).toBe(true);
  });

  test("a failed request after the turn was withdrawn hands nothing off", async () => {
    // Review round 3: the fallback transferred a conversation the operator had just cleared.
    const f = fakeChatwoot({ failOn: new Set(["createConversation"]) });
    let wanted = true;
    const create = f.client.createConversation;
    f.client.createConversation = async (p) => {
      wanted = false;
      return create(p);
    };
    const { t, toggles } = toolFor(f, { stillWanted: async () => wanted });
    const out = String(await t.invoke({ reason: "x" }));
    expect(toggles).toEqual([]);
    expect(f.calls.some((c) => c.fn === "sendPrivateNote")).toBe(false);
    expect(out).toContain("called off");
  });

  test("withdrawn while the fallback note was in flight: the note stays, the transfer does not happen", async () => {
    const f = fakeChatwoot({ failOn: new Set(["createConversation"]) });
    let wanted = true;
    const note = f.client.sendPrivateNote;
    f.client.sendPrivateNote = async (id: number, c: string) => {
      const r = await note(id, c);
      wanted = false;
      return r;
    };
    const { t, toggles } = toolFor(f, { stillWanted: async () => wanted });
    await t.invoke({ reason: "x" });
    expect(f.calls.some((c) => c.fn === "sendPrivateNote")).toBe(true);
    expect(toggles).toEqual([]);
  });

  test("without a line, a person still gets the conversation and the model is told nothing reaches the customer", async () => {
    const f = fakeChatwoot({ failOn: new Set(["createConversation"]) });
    const handoffState = { customerMessage: null, completed: false };
    const { t, toggles } = toolFor(f, { handoffState });
    const out = String(await t.invoke({ reason: "x" }));
    expect(toggles).toEqual(["7:open"]);
    expect(handoffState.customerMessage).toBeNull();
    expect(out).toContain("No message will reach the customer");
  });

  test("the output check's policy took the conversation: the model is told, and not to try again", async () => {
    const f = fakeChatwoot();
    const { t } = toolFor(f, {
      screenCustomerText: async () => "handed" as const,
    });
    const out = String(
      await t.invoke({ reason: "x", customer_message: "Olá" }),
    );
    expect(out).toContain(OPEN_CASE_HANDED_MARK);
    expect(writesOf(f.calls)).toEqual([]);
  });

  test("a failed opening is a marked failure, so the flow log carries it", async () => {
    const f = fakeChatwoot({ failOn: new Set(["createConversation"]) });
    const { t } = toolFor(f);
    const msg = await t.invoke({
      id: "call-1",
      name: "open_case_in_inbox",
      args: { reason: "x" },
      type: "tool_call",
    } as never);
    expect((msg as { status?: string }).status).toBe("error");
  });

  test("not offered under a mute: its opening reaches the customer", () => {
    const f = fakeChatwoot();
    const client = { ...f.client, muted: true } as unknown as ChatwootClient;
    const names = buildNativeTools({
      client,
      conversationId: 7,
      crossInboxCase: {
        config: { ...CROSS_INBOX_CASE_DEFAULTS, targetInboxId: 40 },
        contactId: 5,
      },
    }).map((t) => t.name);
    expect(names).not.toContain("open_case_in_inbox");
  });
});

// Review round 4: the reply window is read off what the create answers, as Chatwoot reports it.
describe("the client reads the create's reply window", () => {
  const created = async (body: Record<string, unknown>) => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const c = new ChatwootClient(
      {
        baseUrl: "https://chat.example.com",
        accountId: 5,
        adminToken: "admin",
        botToken: "bot",
      },
      fetchImpl,
    );
    return c.createConversation({
      inboxId: 40,
      contactId: 5,
      status: "open",
      customAttributes: {},
    });
  };
  test("closed, open, and not reported", async () => {
    const base = { id: 9, inbox_id: 40, status: "open" };
    expect((await created({ ...base, can_reply: false })).canReply).toBe(false);
    expect((await created({ ...base, can_reply: true })).canReply).toBe(true);
    expect((await created(base)).canReply).toBeNull();
  });
});

// Review round 5: when the tool handed the conversation to people, a later return to the bot owes the
// thread the same hand-back note a `handoff_to_human` does.
describe("the hand-back rule reads the tool's transfer", () => {
  const result = (content: string, name = "open_case_in_inbox") =>
    new ToolMessage({ content, name, tool_call_id: "c1" });
  test("a fallback transfer is a hand-over", () => {
    expect(
      owesHandbackNote([
        result(
          `Could not open the case (failed at: x). ${OPEN_CASE_HANDED_MARK} instead.`,
        ),
      ]),
    ).toBe(true);
  });
  test("an opened case is not, and neither is another tool saying the same", () => {
    expect(owesHandbackNote([result("Case opened: conversation #9.")])).toBe(
      false,
    );
    expect(
      owesHandbackNote([
        result(`${OPEN_CASE_HANDED_MARK} instead.`, "some_http_tool"),
      ]),
    ).toBe(false);
  });
});
