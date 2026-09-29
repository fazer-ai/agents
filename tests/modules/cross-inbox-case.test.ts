import { describe, expect, test } from "bun:test";
import { ToolMessage } from "@langchain/core/messages";
import { owesHandbackNote } from "@/graph/handback";
import { interpolatePromptVars } from "@/graph/prompt";
import { OPEN_CASE_HANDED_MARK } from "@/graph/tools/catalog";
import { buildNativeTools } from "@/graph/tools/native";
import { ChatwootApiError, ChatwootClient } from "@/modules/chatwoot/client";
import { withConversationLabels } from "@/modules/chatwoot/labels";
import { markValue } from "@/modules/chatwoot/liquid";
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
  CROSS_INBOX_CASE_SUBJECT_MAX,
  openingAsksMessage,
  readCrossInboxCaseConfig,
  renderCaseNote,
  renderCaseOpening,
  renderCaseSubject,
  subjectAsksSummary,
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
  // Who holds it. `bot` is the agent bot's id; `botTyped: false` is the fork's bot
  // assignment that carries the id without `ai_assignee_type`, which its JSON shows as no assignee.
  bot?: number | null;
  botTyped?: boolean;
  human?: number | null;
  teamId?: number | null;
}

function fakeChatwoot(
  opts: {
    inboxes?: Record<number, { name: string; channel_type: string }>;
    contacts?: Record<number, { email?: string | null; phone?: string | null }>;
    convs?: Conv[];
    incoming?: string[];
    // The origin's whole history, oldest first, served the way Chatwoot pages it: the newest page of
    // 20 by default, and the 20 before a message id with `before`. Replaces `incoming` when given.
    history?: Array<{ type: "in" | "out"; content: string }>;
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
    // The account's label catalog (`GET /labels`); "fail" answers it with a 500.
    catalog?: string[] | "fail";
    // The destination inbox's agent bot, which Chatwoot assigns to a conversation it creates there
    // (the fork assigns it without the type).
    inboxBot?: number;
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
      const meta: Record<string, unknown> = {};
      if (c.human) {
        meta.assignee = { id: c.human };
        meta.assignee_type = "User";
      } else if (c.bot && c.botTyped !== false) {
        meta.assignee = { id: c.bot };
        meta.assignee_type = "AgentBot";
      }
      if (c.teamId) meta.team = { id: c.teamId };
      return {
        id: c.id,
        inbox_id: c.inboxId,
        status: c.status,
        custom_attributes: { ...c.attrs },
        meta,
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
        .map((c) => ({
          id: c.id,
          inboxId: c.inboxId,
          status: c.status,
          customAttributes: { ...c.attrs },
        }));
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
        ...(opts.inboxBot ? { bot: opts.inboxBot, botTyped: false } : {}),
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
    getMessages: async (id: number, o?: { before?: number }) => {
      record("getMessages", [id, o]);
      if (opts.history) {
        const rows = opts.history
          .map((m, i) => ({
            id: i + 1,
            message_type: m.type === "in" ? 0 : 1,
            content: m.content,
          }))
          .filter((m) => o?.before == null || m.id < o.before);
        return { payload: rows.slice(-20) };
      }
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
    listLabels: async () => {
      record("listLabels", []);
      if (opts.catalog === "fail")
        throw new ChatwootApiError(500, "GET /labels");
      return [...(opts.catalog ?? [])];
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
    // `assignee_id: 0`: the fork's AssignmentService sets both the person and the bot to none.
    unassignConversation: async (id: number, o?: unknown) => {
      record("unassignConversation", [id, o]);
      const c = conv(id);
      c.human = null;
      c.bot = null;
      return {};
    },
    assignTeam: async (id: number, teamId: number, o?: unknown) => {
      record("assignTeam", [id, teamId, o]);
      conv(id).teamId = teamId;
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
  "unassignConversation",
  "assignTeam",
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
      caseLabels: [],
      subjectTemplate: null,
      openingTemplate: null,
      noteTemplate: null,
    });
    const bad = readCrossInboxCaseConfig({
      crossInboxCase: { targetInboxId: 0, caseAttributeKey: "Protocolo X" },
    });
    expect(bad.targetInboxId).toBeNull();
    expect(bad.caseAttributeKey).toBe("case_conversation_id");
  });

  test("case labels: trimmed, lowercased, deduplicated, blanks and non-strings dropped (issue #901)", () => {
    expect(
      readCrossInboxCaseConfig({
        crossInboxCase: {
          caseLabels: [" Agente-SAC ", "agente-sac", "", 7, "veio-do-whatsapp"],
        },
      }).caseLabels,
    ).toEqual(["agente-sac", "veio-do-whatsapp"]);
    expect(
      readCrossInboxCaseConfig({ crossInboxCase: { caseLabels: "agente-sac" } })
        .caseLabels,
    ).toEqual([]);
    expect(readCrossInboxCaseConfig({}).caseLabels).toEqual([]);
  });

  test("case labels: the first 20 are kept", () => {
    const many = Array.from({ length: 25 }, (_, i) => `etiqueta-${i}`);
    expect(
      readCrossInboxCaseConfig({ crossInboxCase: { caseLabels: many } })
        .caseLabels,
    ).toEqual(many.slice(0, 20));
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
    // NOTE: a substring match would let a truncated address through.
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

  test("the whole case: open conversation, number back on the origin, opening message, one note each side, labels", async () => {
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
      [
        100,
        "**Caso aberto a partir de outra conversa:** [ver conversa de origem](https://cw.example/app/accounts/1/conversations/7)\n\n**Motivo:**\ncliente pediu atendente humano",
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
    ).toEqual([true]);
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
    // Nothing is opened or sent to the customer. The case's owner is settled (with no person on it,
    // whatever bot may hold it is cleared, and that is idempotent), and the reason goes to the case
    // as a note, since it is what the customer added since the case opened.
    expect(writesOf(f.calls)).toEqual([
      "unassignConversation",
      "sendMessageAsAdmin",
    ]);
    const note = f.calls.find((c) => c.fn === "sendMessageAsAdmin");
    expect(note?.args[0]).toBe(55);
    expect(note?.args[1]).toContain("cliente pediu atendente humano");
    expect(note?.args[1]).toContain("**Informação adicional do cliente**");
    expect(note?.args[2]).toEqual({ private: true });
  });

  test("the note on a remembered case carries the addition literally", async () => {
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
    await openCaseInInbox(f.client, input({ reason: "valor {{ total }}" }));
    const note = f.calls.find((c) => c.fn === "sendMessageAsAdmin");
    expect(note?.args[1]).toContain("valor {{ '{{' }} total }}");
  });

  test("withdrawn before the note on a remembered case: the note is not written", async () => {
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
    const r = await openCaseInInbox(
      f.client,
      input({ stillWanted: async () => false }),
    );
    expect(r).toMatchObject({ kind: "already_open", partial: ["called_off"] });
    expect(f.calls.some((c) => c.fn === "sendMessageAsAdmin")).toBe(false);
  });

  test("a remembered case that went pending or snoozed is reopened before it is reported open", async () => {
    // NOTE: out of the team's open queue is not "already with the team".
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
    // The create can hand back the origin itself and flip it open under the turn.
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
    // An official WhatsApp destination rejects a free-form first message.
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
    // The listing is the newest 25, and absence from it is not a new case.
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
    // per-origin queues alone run side by side, both list before either creates, and an inbox
    // that continues open conversations hands both the same case as "opened".
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
    // The second lists after the first created, and finds the case it opened.
    expect([a.kind, b.kind].sort()).toEqual(["appended", "opened"]);
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
    // Read as a plain drop, the case would open and resolveOrigin would close the origin.
    const f = fakeChatwoot();
    const r = await openCaseInInbox(
      f.client,
      input({ screenCustomerMessage: async () => "failed" }),
    );
    expect(r).toMatchObject({ kind: "failed", step: "guardrail_handoff" });
    expect(f.calls.some((c) => c.fn === "createConversation")).toBe(false);
  });

  test("the opening the customer receives is signed; the note of a closed window is not", async () => {
    // Chatwoot does not sign API sends.
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

  // The opening and the reason note are the model's words, and Chatwoot renders both as
  // Liquid, so they go escaped (the wire shape is pinned in chatwoot-liquid.test.ts). The links are
  // ours and carry no Liquid. A signer, when there is one, owns the whole opening: it attaches the
  // operator's signature, which keeps its Liquid, and escapes the model's part itself (src/graph/prepare.ts).
  test("the opening and the reason reach the case literally", async () => {
    const f = fakeChatwoot();
    await openCaseInInbox(
      f.client,
      input({
        customerMessage: "Abrimos seu caso {{contact.email}} ref {{foo}}",
        reason: "cliente pediu {{contact.phone_number}}",
      }),
    );
    const sends = f.calls
      .filter((c) => c.fn === "sendMessageAsAdmin")
      .map((c) => c.args[1]);
    expect(sends[0]).toBe(
      "Abrimos seu caso {{ '{{' }}contact.email}} ref {{ '{{' }}foo}}",
    );
    expect(sends[1]).toContain(
      "**Motivo:**\ncliente pediu {{ '{{' }}contact.phone_number}}",
    );
    const closed = fakeChatwoot({ canReply: false });
    await openCaseInInbox(
      closed.client,
      input({ customerMessage: "Abrimos {{contact.email}}" }),
    );
    const note = closed.calls.find(
      (c) =>
        c.fn === "sendMessageAsAdmin" && String(c.args[1]).includes("Abrimos"),
    );
    expect(String(note?.args[1])).toEndWith(
      "Abrimos {{ '{{' }}contact.email}}",
    );
    const signed = fakeChatwoot();
    await openCaseInInbox(
      signed.client,
      input({
        customerMessage: "Abrimos {{foo}}",
        signCustomerMessage: (t) => `WIRE(${t})`,
      }),
    );
    expect(
      signed.calls.find((c) => c.fn === "sendMessageAsAdmin")?.args[1],
    ).toBe("WIRE(Abrimos {{foo}})");
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

  describe("the contact's case opened from another conversation", () => {
    // The origin was resolved with the case open, and the customer wrote again: the channel opened
    // conversation 8, which knows nothing about case 60.
    const withCase = (status: string, over: Partial<Conv> = {}) =>
      fakeChatwoot({
        convs: [
          {
            id: 7,
            inboxId: 10,
            contactId: 5,
            status: "resolved",
            attrs: { case_conversation_id: 60 },
            labels: [],
          },
          {
            id: 8,
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
            status,
            attrs: { origin_conversation_id: 7 },
            labels: [],
            ...over,
          },
        ],
      });

    test("the addition goes to that case as a note, and the new conversation is linked to it", async () => {
      const f = withCase("open");
      const r = await openCaseInInbox(
        f.client,
        input({
          originConversationId: 8,
          reason: "cliente mandou o print do erro",
          customerMessage: "Olá! Abrimos seu atendimento.",
        }),
      );
      expect(r).toMatchObject({ kind: "appended", caseId: 60 });
      expect(f.calls.some((c) => c.fn === "createConversation")).toBe(false);
      expect(f.convs).toHaveLength(3);
      const toCase = f.calls.filter(
        (c) => c.fn === "sendMessageAsAdmin" && c.args[0] === 60,
      );
      // One private note, and nothing to the customer there: the case already has its opening.
      expect(toCase).toHaveLength(1);
      expect(toCase[0]?.args[2]).toEqual({ private: true });
      expect(toCase[0]?.args[1]).toContain("cliente mandou o print do erro");
      expect(toCase[0]?.args[1]).toContain("/conversations/8");
      // An addition, not a case being opened: its own header, and not the operator's note layout.
      expect(toCase[0]?.args[1]).toContain(
        "**Informação adicional do cliente**",
      );
      expect(toCase[0]?.args[1]).not.toContain("Caso aberto");
      expect(f.convs.find((c) => c.id === 8)?.attrs).toEqual({
        case_conversation_id: 60,
      });
      expect(
        f.calls.find((c) => c.fn === "sendPrivateNote")?.args,
      ).toMatchObject([8, expect.stringContaining("/conversations/60")]);
    });

    test("the operator's note layout is for opening a case, and the addition goes in literally", async () => {
      const f = withCase("open");
      await openCaseInInbox(
        f.client,
        input({
          originConversationId: 8,
          reason: "valor {{ total }}",
          config: {
            ...CROSS_INBOX_CASE_DEFAULTS,
            targetInboxId: 40,
            noteTemplate: "NOVO CASO: {{motivo}}",
          },
        }),
      );
      const note = String(
        f.calls.find((c) => c.fn === "sendMessageAsAdmin" && c.args[0] === 60)
          ?.args[1],
      );
      expect(note).not.toContain("NOVO CASO");
      expect(note).toContain("valor {{ '{{' }} total }}");
    });

    test("a case that went pending is reopened before the addition is reported", async () => {
      const f = withCase("pending");
      const r = await openCaseInInbox(
        f.client,
        input({ originConversationId: 8 }),
      );
      expect(r).toMatchObject({ kind: "appended", caseId: 60 });
      expect(f.convs.find((c) => c.id === 60)?.status).toBe("open");
    });

    test("a resolved case, a case in another inbox, or a conversation this tool did not open gets a new case", async () => {
      for (const [status, over] of [
        ["resolved", {}],
        ["open", { inboxId: 41 }],
        ["open", { attrs: {} }],
      ] as const) {
        const f = withCase(status, over);
        const r = await openCaseInInbox(
          f.client,
          input({ originConversationId: 8 }),
        );
        expect(r.kind).toBe("opened");
        expect(f.calls.some((c) => c.fn === "createConversation")).toBe(true);
      }
    });

    test("the newest of two open cases is the one appended to", async () => {
      const f = withCase("open");
      f.convs.push({
        id: 61,
        inboxId: 40,
        contactId: 5,
        status: "open",
        attrs: { origin_conversation_id: 3 },
        labels: [],
      });
      const r = await openCaseInInbox(
        f.client,
        input({ originConversationId: 8 }),
      );
      expect(r).toMatchObject({ kind: "appended", caseId: 61 });
    });

    test("withdrawn before the addition is written: nothing is", async () => {
      const f = withCase("open");
      let asks = 0;
      const r = await openCaseInInbox(
        f.client,
        input({
          originConversationId: 8,
          stillWanted: async () => ++asks < 2,
        }),
      );
      expect(r.kind).toBe("called_off");
      expect(writesOf(f.calls)).toEqual([]);
    });
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

  describe("an address typed before the newest page of the conversation", () => {
    const noEmail = { 5: { email: null, phone: "+5511999" } };
    const chatter = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        type: (i % 2 === 0 ? "out" : "in") as "in" | "out",
        content: i % 2 === 0 ? `resposta ${i}` : `mensagem ${i}`,
      }));
    const pagesAsked = (calls: Array<{ fn: string; args: unknown[] }>) =>
      calls.filter((c) => c.fn === "getMessages");

    test("typed only in the first message of a long conversation, the case opens", async () => {
      const f = fakeChatwoot({
        contacts: noEmail,
        history: [
          { type: "in", content: "Olá, meu e-mail é ana@exemplo.com" },
          ...chatter(44),
        ],
      });
      const r = await openCaseInInbox(
        f.client,
        input({ email: "ana@exemplo.com" }),
      );
      expect(r).toMatchObject({ kind: "opened", identity: "written" });
      expect(f.contacts.get(5)?.email).toBe("ana@exemplo.com");
      expect(pagesAsked(f.calls).length).toBeGreaterThan(1);
    });

    test("the message 21st from the end is read", async () => {
      const f = fakeChatwoot({
        contacts: noEmail,
        history: [
          { type: "in", content: "meu e-mail: ana@exemplo.com" },
          ...chatter(20),
        ],
      });
      const r = await openCaseInInbox(
        f.client,
        input({ email: "ana@exemplo.com" }),
      );
      expect(r).toMatchObject({ kind: "opened" });
    });

    test("an address never typed is still refused after reading the whole conversation", async () => {
      const f = fakeChatwoot({ contacts: noEmail, history: chatter(65) });
      const r = await openCaseInInbox(
        f.client,
        input({ email: "ana@exemplo.com" }),
      );
      expect(r).toEqual({
        kind: "rejected_email",
        why: "not_in_conversation",
      });
      expect(writesOf(f.calls)).toEqual([]);
      // The walk reached the first message and stopped there.
      expect(pagesAsked(f.calls).length).toBe(4);
    });

    test("an old address written only by the agent does not count", async () => {
      const f = fakeChatwoot({
        contacts: noEmail,
        history: [
          { type: "out", content: "É ana@exemplo.com?" },
          ...chatter(44),
        ],
      });
      const r = await openCaseInInbox(
        f.client,
        input({ email: "ana@exemplo.com" }),
      );
      expect(r).toEqual({
        kind: "rejected_email",
        why: "not_in_conversation",
      });
    });

    test("an old address that only contains the one asked is refused", async () => {
      const f = fakeChatwoot({
        contacts: noEmail,
        history: [
          { type: "in", content: "joanna@exemplo.com.br" },
          ...chatter(44),
        ],
      });
      const r = await openCaseInInbox(
        f.client,
        input({ email: "anna@exemplo.com" }),
      );
      expect(r).toEqual({
        kind: "rejected_email",
        why: "not_in_conversation",
      });
    });

    test("a short conversation is read in one page, as before", async () => {
      const f = fakeChatwoot({
        contacts: noEmail,
        history: [{ type: "in", content: "ana@exemplo.com" }, ...chatter(5)],
      });
      const r = await openCaseInInbox(
        f.client,
        input({ email: "ana@exemplo.com" }),
      );
      expect(r).toMatchObject({ kind: "opened" });
      expect(pagesAsked(f.calls)).toHaveLength(1);
    });

    test("found on the newest page, no older page is asked", async () => {
      const f = fakeChatwoot({
        contacts: noEmail,
        history: [...chatter(44), { type: "in", content: "ana@exemplo.com" }],
      });
      const r = await openCaseInInbox(
        f.client,
        input({ email: "ana@exemplo.com" }),
      );
      expect(r).toMatchObject({ kind: "opened" });
      expect(pagesAsked(f.calls)).toHaveLength(1);
    });

    test("the walk is bounded: an address older than a thousand messages is refused", async () => {
      const f = fakeChatwoot({
        contacts: noEmail,
        history: [{ type: "in", content: "ana@exemplo.com" }, ...chatter(1100)],
      });
      const r = await openCaseInInbox(
        f.client,
        input({ email: "ana@exemplo.com" }),
      );
      expect(r).toEqual({
        kind: "rejected_email",
        why: "not_in_conversation",
      });
      expect(pagesAsked(f.calls)).toHaveLength(50);
    });

    test("a server that ignores `before` does not keep the walk going", async () => {
      const f = fakeChatwoot({ contacts: noEmail, history: chatter(45) });
      const newest = await f.client.getMessages(7);
      let asked = 0;
      const client: CaseClient = {
        ...f.client,
        getMessages: async () => {
          asked += 1;
          return newest;
        },
      };
      const r = await openCaseInInbox(
        client,
        input({ email: "ana@exemplo.com" }),
      );
      expect(r).toEqual({
        kind: "rejected_email",
        why: "not_in_conversation",
      });
      expect(asked).toBe(2);
    });

    test("a conversation with no customer message ends the walk and refuses", async () => {
      const f = fakeChatwoot({ contacts: noEmail, history: [] });
      const r = await openCaseInInbox(
        f.client,
        input({ email: "ana@exemplo.com" }),
      );
      expect(r).toEqual({
        kind: "rejected_email",
        why: "not_in_conversation",
      });
      expect(pagesAsked(f.calls)).toHaveLength(1);
    });
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
      // The merge is the one write nothing undoes.
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
    // An ask only before this read would miss a withdrawal inside it.
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
    // The case still opens, with its note: the team still owes the customer.
    expect(f.calls.filter((c) => c.fn === "sendMessageAsAdmin")).toHaveLength(
      1,
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
    // A fence asked before the queue's wait would undo a reset queued inside it.
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
    // Outside the queue, a `set_labels` beside it reads the same set and the last write erases the other.
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
    // A swallowed reopen would report an open case, and resolveOrigin would close the origin.
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
    // The label write replaces the set, so a new case is not assumed to have no labels.
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
    // None of the opening message, notes or labels may go out after a withdrawal.
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
    // Only the case's owner is still settled: a withdrawal on the ORIGIN does not make
    // an open case anyone's, and left with a bot it is the conversation nobody sees.
    expect(after).toEqual(["unassignConversation"]);
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

  describe("the operator's fixed case labels (issue #901)", () => {
    const withCaseLabels = (
      caseLabels: string[],
      over: Partial<OpenCaseInput> = {},
    ) =>
      input({
        config: { ...CROSS_INBOX_CASE_DEFAULTS, targetInboxId: 40, caseLabels },
        ...over,
      });

    test("applied to a new case together with the model's labels", async () => {
      const f = fakeChatwoot({
        catalog: ["agente-sac", "veio-do-whatsapp", "financeiro"],
      });
      const r = await openCaseInInbox(
        f.client,
        withCaseLabels(["agente-sac", "veio-do-whatsapp"], {
          labels: ["financeiro"],
        }),
      );
      expect(r).toMatchObject({ kind: "opened", partial: [] });
      expect(
        [...(f.convs.find((c) => c.id === 100)?.labels ?? [])].sort(),
      ).toEqual(["agente-sac", "financeiro", "veio-do-whatsapp"]);
    });

    test("none configured: the catalog is not even read, and the case gets only the model's labels", async () => {
      const f = fakeChatwoot({ catalog: ["financeiro"] });
      await openCaseInInbox(f.client, input({ labels: ["financeiro"] }));
      expect(f.calls.some((c) => c.fn === "listLabels")).toBe(false);
      expect(f.convs.find((c) => c.id === 100)?.labels).toEqual(["financeiro"]);
    });

    test("a label the account does not have is left out and reported, the known ones still land", async () => {
      const f = fakeChatwoot({ catalog: ["agente-sac"] });
      const r = await openCaseInInbox(
        f.client,
        withCaseLabels(["agente-sac", "nao-existe"]),
      );
      expect(r).toMatchObject({
        kind: "opened",
        partial: [],
        unknownCaseLabels: ["nao-existe"],
      });
      expect(f.convs.find((c) => c.id === 100)?.labels).toEqual(["agente-sac"]);
    });

    test("the catalog is matched without regard to case", async () => {
      const f = fakeChatwoot({ catalog: ["Agente-SAC"] });
      const r = await openCaseInInbox(f.client, withCaseLabels(["agente-sac"]));
      expect(r).toMatchObject({ kind: "opened", partial: [] });
      expect(r).not.toHaveProperty("unknownCaseLabels");
      expect(f.convs.find((c) => c.id === 100)?.labels).toEqual(["agente-sac"]);
    });

    test("an unreadable catalog does not cost the label: applied as configured", async () => {
      const f = fakeChatwoot({ catalog: "fail" });
      const r = await openCaseInInbox(f.client, withCaseLabels(["agente-sac"]));
      expect(r).toMatchObject({ kind: "opened", partial: [] });
      expect(f.convs.find((c) => c.id === 100)?.labels).toEqual(["agente-sac"]);
    });

    test("a continued case gets only the labels it lacks, and none at all when it has them", async () => {
      const convs = (labels: string[]) => [
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
          labels,
        },
      ];
      const f = fakeChatwoot({
        continueOpen: true,
        catalog: ["agente-sac", "vip"],
        convs: convs(["vip", "agente-sac"]),
      });
      const r = await openCaseInInbox(f.client, withCaseLabels(["agente-sac"]));
      expect(r).toMatchObject({ kind: "continued", caseId: 60 });
      expect(f.convs.find((c) => c.id === 60)?.labels).toEqual([
        "vip",
        "agente-sac",
      ]);
      expect(
        f.calls.some(
          (c) => c.fn === "setConversationLabels" && c.args[0] === 60,
        ),
      ).toBe(false);

      const g = fakeChatwoot({
        continueOpen: true,
        catalog: ["agente-sac", "vip"],
        convs: convs(["vip"]),
      });
      await openCaseInInbox(g.client, withCaseLabels(["agente-sac"]));
      expect(g.convs.find((c) => c.id === 60)?.labels).toEqual([
        "vip",
        "agente-sac",
      ]);
    });

    test("the same label from the operator and from the model is written once", async () => {
      const f = fakeChatwoot({ catalog: ["agente-sac"] });
      await openCaseInInbox(
        f.client,
        withCaseLabels(["agente-sac"], { labels: ["agente-sac"] }),
      );
      expect(f.convs.find((c) => c.id === 100)?.labels).toEqual(["agente-sac"]);
    });

    test("a label write that fails is a partial step, and the case stays open", async () => {
      const f = fakeChatwoot({
        catalog: ["agente-sac"],
        failOn: new Set(["setConversationLabels"]),
      });
      const r = await openCaseInInbox(f.client, withCaseLabels(["agente-sac"]));
      expect(r).toMatchObject({ kind: "opened", caseId: 100 });
      expect((r as { partial: string[] }).partial).toContain(
        "destination_labels",
      );
    });
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

  // The note left when the case could not be opened quotes the model's reason, which Chatwoot renders
  // as Liquid like any note, so it goes escaped.
  test("the note of a case that failed to open quotes the reason literally", async () => {
    const f = fakeChatwoot({ failOn: new Set(["createConversation"]) });
    const { t } = toolFor(f);
    await t.invoke({ reason: "pediu {{contact.phone_number}}" });
    const note = f.calls.find(
      (c) =>
        c.fn === "sendPrivateNote" &&
        String(c.args[1]).includes("Não consegui abrir o caso"),
    );
    expect(String(note?.args[1])).toEndWith(
      "Motivo informado: pediu {{ '{{' }}contact.phone_number}}",
    );
  });

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

  test("the operator's case labels reach the tool, and a label the account lacks is reported to the operator, not to the model (issue #901)", async () => {
    const f = fakeChatwoot({ catalog: ["agente-sac"] });
    const reported: Array<{ phase: string; detail: unknown }> = [];
    const client = { ...f.client, muted: false } as unknown as ChatwootClient;
    const [t] = buildNativeTools(
      {
        client,
        conversationId: 7,
        crossInboxCase: {
          config: {
            ...CROSS_INBOX_CASE_DEFAULTS,
            targetInboxId: 40,
            caseLabels: ["agente-sac", "nao-existe"],
          },
          contactId: 5,
        },
        onSideEffectError: (e: { phase: string; detail: unknown }) => {
          reported.push({ phase: e.phase, detail: e.detail });
        },
      } as never,
      ["open_case_in_inbox"],
    );
    if (!t) throw new Error("tool not built");
    const out = String(await t.invoke({ reason: "x" }));
    expect(out).toContain("Case opened: conversation #100");
    expect(out).not.toContain("nao-existe");
    expect(f.convs.find((c) => c.id === 100)?.labels).toEqual(["agente-sac"]);
    expect(reported).toEqual([
      {
        phase: "case_labels_unknown",
        detail: { caseId: 100, labels: ["nao-existe"] },
      },
    ]);
  });

  test("appended: the model is told the addition reached the open case, and the description says when to call again", async () => {
    const f = fakeChatwoot({
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
          status: "open",
          attrs: { origin_conversation_id: 3 },
          labels: [],
        },
      ],
    });
    const { t } = toolFor(f);
    const out = String(await t.invoke({ reason: "o print do erro" }));
    expect(out).toContain("already has an open case with the team");
    expect(out).toContain("#60");
    expect(out).toContain("added to that case as an internal note");
    expect(out).not.toContain("Case opened");
    expect(t.description).toContain(
      "When the customer adds something after their case was opened",
    );
  });

  test("appended: a note that did not land reaches the flow log", async () => {
    const f = fakeChatwoot({
      failOn: new Set(["sendMessageAsAdmin"]),
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
          status: "open",
          attrs: { origin_conversation_id: 3 },
          labels: [],
        },
      ],
    });
    const seen: Array<{ phase: string; detail: unknown }> = [];
    const { t } = toolFor(f, {
      onSideEffectError: (e: { phase: string; detail: unknown }) => {
        seen.push({ phase: e.phase, detail: e.detail });
      },
    });
    const out = String(await t.invoke({ reason: "x" }));
    expect(out).toContain("Some writes did not land (destination_note)");
    expect(seen).toContainEqual({
      phase: "follow_up_writes",
      detail: { caseId: 60, failed: ["destination_note"] },
    });
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
      // The close is the case's, so the operator's resolve labels do not ride it.
      expect((turnState as { caseClosing?: boolean }).caseClosing).toBe(true);
      expect(out).toContain("marked resolved after your reply");
      expect(t.description).toContain("closed after your reply");
      // The origin's status is left to the runtime, which closes after delivery.
      expect(f.convs.find((c) => c.id === 7)?.status).toBe("pending");
    });

    test("on, and the addition went to the contact's open case: the close is still scheduled", async () => {
      const f = fakeChatwoot({
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
            status: "open",
            attrs: { origin_conversation_id: 3 },
            labels: [],
          },
        ],
      });
      const turnState = turn();
      const t = withClose(f, true, { turnState });
      const out = String(await t.invoke({ reason: "x" }));
      expect(turnState.resolveRequested).toBe(true);
      expect(out).toContain("marked resolved after your reply");
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
    // Without the silence mark the model's next reply could still go out.
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

  test("the model is told to call it directly, not to ask for an email first", () => {
    // Told only "when it asks for an email, ask the customer", a model asks for an address the
    // contact already has, before calling the tool at all.
    const { t } = toolFor(fakeChatwoot());
    expect(t.description).toContain(
      "Call it directly: it reads the contact's email and phone itself, so do not ask the customer for them first.",
    );
    expect(t.description).toContain(
      "Only when the result says an email is missing",
    );
    const email = (
      t.schema as unknown as { shape: Record<string, { description?: string }> }
    ).shape.email;
    expect(email?.description).toStartWith("Leave it out on the first call.");
  });

  test("a failed request after the turn was withdrawn hands nothing off", async () => {
    // The fallback must not transfer a conversation the operator has just cleared.
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

// The reply window is read off what the create answers, as Chatwoot reports it.
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

// When the tool handed the conversation to people, a later return to the bot owes the
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

// The email subject of a case: the operator's template, with the prompt's context
// variables and a one-line summary the model writes.
describe("the case's email subject", () => {
  const vars = { nome_contato: "Ana Souza", contact_name: "Ana Souza" };
  const interpolate = (t: string) => interpolatePromptVars(t, vars);
  const created = (f: ReturnType<typeof fakeChatwoot>) =>
    f.calls
      .filter((c) => c.fn === "createConversation")
      .map((c) => c.args[0] as { additionalAttributes?: unknown });

  test("context variables and the summary fill the template, in one line", () => {
    expect(
      renderCaseSubject(
        "Solicitação de {{nome_contato}}: {{resumo}}",
        "troca de ingresso\n  do show de sábado",
        interpolate,
      ),
    ).toBe("Solicitação de Ana Souza: troca de ingresso do show de sábado");
    expect(
      renderCaseSubject("[SAC] {{ summary }}", "reembolso", interpolate),
    ).toBe("[SAC] reembolso");
  });

  test("the model's text is never interpolated", () => {
    expect(
      renderCaseSubject(
        "{{resumo}}",
        "pedido de {{nome_contato}}",
        interpolate,
      ),
    ).toBe("pedido de {{nome_contato}}");
  });

  test("clipped to a header's length without splitting a character, and empty is no subject", () => {
    const long = `${"x".repeat(CROSS_INBOX_CASE_SUBJECT_MAX - 1)}😀 e mais texto`;
    const out = renderCaseSubject("{{resumo}}", long, interpolate) ?? "";
    expect(out.length).toBeLessThanOrEqual(CROSS_INBOX_CASE_SUBJECT_MAX);
    expect(out.endsWith("\ud83d")).toBe(false);
    expect(renderCaseSubject("{{resumo}}", "  ", interpolate)).toBeNull();
    expect(renderCaseSubject(null, "reembolso", interpolate)).toBeNull();
  });

  test("the summary is asked for only when the template has it", () => {
    expect(subjectAsksSummary("Caso de {{nome_contato}}: {{resumo}}")).toBe(
      true,
    );
    expect(subjectAsksSummary("{{summary}}")).toBe(true);
    expect(subjectAsksSummary("Caso de {{nome_contato}}")).toBe(false);
    expect(subjectAsksSummary(null)).toBe(false);
  });

  test("the template is read trimmed, and an empty one is none", () => {
    expect(
      readCrossInboxCaseConfig({
        crossInboxCase: {
          targetInboxId: 40,
          subjectTemplate: "  Caso {{resumo}} ",
        },
      }).subjectTemplate,
    ).toBe("Caso {{resumo}}");
    expect(
      readCrossInboxCaseConfig({
        crossInboxCase: { targetInboxId: 40, subjectTemplate: "   " },
      }).subjectTemplate,
    ).toBeNull();
  });

  test("an email destination opens the case with the subject", async () => {
    const f = fakeChatwoot();
    await openCaseInInbox(f.client, input({ subject: "Solicitação de Ana" }));
    expect(created(f)[0]?.additionalAttributes).toEqual({
      mail_subject: "Solicitação de Ana",
    });
  });

  test("a destination that is not email gets no subject", async () => {
    const f = fakeChatwoot({
      inboxes: {
        40: { name: "WhatsApp oficial", channel_type: "Channel::Whatsapp" },
      },
    });
    await openCaseInInbox(f.client, input({ subject: "Solicitação de Ana" }));
    expect(created(f)[0]?.additionalAttributes).toBeUndefined();
  });

  test("the subject passes the output check: a refused one is dropped, a transfer opens nothing", async () => {
    const screened: string[] = [];
    const screen =
      (verdicts: Record<string, "send" | "drop" | "handed">) =>
      async (text: string) => {
        screened.push(text);
        return verdicts[text] ?? "send";
      };
    const dropped = fakeChatwoot();
    const r1 = await openCaseInInbox(
      dropped.client,
      input({
        subject: "Assunto proibido",
        screenCustomerMessage: screen({ "Assunto proibido": "drop" }),
      }),
    );
    expect(r1.kind).toBe("opened");
    expect(created(dropped)[0]?.additionalAttributes).toBeUndefined();
    expect(screened).toContain("Assunto proibido");
    const handed = fakeChatwoot();
    const r2 = await openCaseInInbox(
      handed.client,
      input({
        customerMessage: null,
        subject: "Assunto que transfere",
        screenCustomerMessage: screen({ "Assunto que transfere": "handed" }),
      }),
    );
    expect(r2.kind).toBe("handed_by_policy");
    expect(created(handed)).toEqual([]);
  });

  test("a subject the check allows is written", async () => {
    const f = fakeChatwoot();
    await openCaseInInbox(
      f.client,
      input({
        subject: "Solicitação de Ana",
        screenCustomerMessage: async () => "send",
      }),
    );
    expect(created(f)[0]?.additionalAttributes).toEqual({
      mail_subject: "Solicitação de Ana",
    });
  });

  test("without a subject, the case opens as before", async () => {
    const f = fakeChatwoot();
    await openCaseInInbox(f.client, input());
    expect(created(f)[0]?.additionalAttributes).toBeUndefined();
  });

  function subjectTool(
    f: ReturnType<typeof fakeChatwoot>,
    template: string | null,
  ) {
    const client = { ...f.client, muted: false } as unknown as ChatwootClient;
    const [t] = buildNativeTools(
      {
        client,
        conversationId: 7,
        crossInboxCase: {
          config: {
            ...CROSS_INBOX_CASE_DEFAULTS,
            targetInboxId: 40,
            subjectTemplate: template,
          },
          contactId: 5,
          renderSubject: (summary) =>
            renderCaseSubject(template, summary, interpolate),
        },
      },
      ["open_case_in_inbox"],
    );
    if (!t) throw new Error("tool not built");
    return t;
  }

  test("the tool offers the summary only when the template asks for it", () => {
    const keys = (template: string | null) =>
      Object.keys(
        (
          subjectTool(fakeChatwoot(), template).schema as {
            shape: Record<string, unknown>;
          }
        ).shape,
      );
    expect(keys("Caso de {{nome_contato}}: {{resumo}}")).toContain("summary");
    expect(keys("Caso de {{nome_contato}}")).not.toContain("summary");
    expect(keys(null)).not.toContain("summary");
  });

  test("a call without the summary still opens the case, on a destination the template no longer fits", async () => {
    const f = fakeChatwoot({
      inboxes: { 40: { name: "API", channel_type: "Channel::Api" } },
    });
    const t = subjectTool(f, "Caso de {{nome_contato}}: {{resumo}}");
    await t.invoke({
      reason: "troca",
      handoff_message: "Vou te passar para o time.",
    });
    expect(created(f)).toHaveLength(1);
    expect(created(f)[0]?.additionalAttributes).toBeUndefined();
  });

  test("the tool writes the rendered subject on the case", async () => {
    const f = fakeChatwoot();
    const t = subjectTool(f, "Solicitação de {{nome_contato}}: {{resumo}}");
    await t.invoke({
      reason: "troca",
      summary: "troca de ingresso",
      handoff_message: "Vou te passar para o time.",
    });
    expect(created(f)[0]?.additionalAttributes).toEqual({
      mail_subject: "Solicitação de Ana Souza: troca de ingresso",
    });
  });
});

// A case the tool opened, continued or reopened must not sit `open` with another agent's bot still
// assigned and no team: the destination's agent only answers `pending`, and the fork counts the bot
// as an owner, so no "open with no owner" rule routes it and nobody sees the case.
describe("who holds the case (issue #908)", () => {
  // A fresh one per use: the service writes the case number on it.
  const originConv = (): Conv => ({
    id: 7,
    inboxId: 10,
    contactId: 5,
    status: "pending",
    attrs: {},
    labels: [],
  });
  const emailAgentsCase = (over: Partial<Conv> = {}): Conv => ({
    id: 55,
    inboxId: 40,
    contactId: 5,
    status: "pending",
    attrs: {},
    labels: [],
    bot: 13,
    botTyped: false,
    ...over,
  });

  test("a continued conversation the email agent left pending: open, no bot, the pinned team", async () => {
    const f = fakeChatwoot({
      continueOpen: true,
      convs: [originConv(), emailAgentsCase()],
    });
    const r = await openCaseInInbox(f.client, input({ caseTeamId: 3 }));
    expect(r).toMatchObject({ kind: "continued", caseId: 55, partial: [] });
    const c = f.convs.find((x) => x.id === 55);
    expect(c).toMatchObject({ status: "open", bot: null, teamId: 3 });
    // Written as the admin: the destination is another inbox the persona bot may not reach.
    expect(f.calls.find((x) => x.fn === "unassignConversation")?.args).toEqual([
      55,
      { asAdmin: true },
    ]);
    expect(f.calls.find((x) => x.fn === "assignTeam")?.args).toEqual([
      55,
      3,
      { asAdmin: true },
    ]);
  });

  test("a bot the JSON does show (typed) is cleared the same way", async () => {
    const f = fakeChatwoot({
      continueOpen: true,
      convs: [originConv(), emailAgentsCase({ botTyped: true })],
    });
    await openCaseInInbox(f.client, input());
    expect(f.convs.find((x) => x.id === 55)?.bot).toBeNull();
  });

  test("a person already on the case: nothing is written, the team neither", async () => {
    // The fork drops an assignee who is not in a newly set team, so even the team would take
    // the case from the person working it.
    const f = fakeChatwoot({
      continueOpen: true,
      convs: [originConv(), emailAgentsCase({ bot: null, human: 21 })],
    });
    await openCaseInInbox(f.client, input({ caseTeamId: 3 }));
    expect(
      f.calls.some(
        (x) => x.fn === "unassignConversation" || x.fn === "assignTeam",
      ),
    ).toBe(false);
    expect(f.convs.find((x) => x.id === 55)?.human).toBe(21);
  });

  test("a team someone already routed the case to is not moved", async () => {
    const f = fakeChatwoot({
      continueOpen: true,
      convs: [originConv(), emailAgentsCase({ teamId: 9 })],
    });
    await openCaseInInbox(f.client, input({ caseTeamId: 3 }));
    expect(f.calls.some((x) => x.fn === "assignTeam")).toBe(false);
    expect(f.convs.find((x) => x.id === 55)).toMatchObject({
      teamId: 9,
      bot: null,
    });
  });

  test("a new conversation the inbox handed its own bot on create is taken from it too", async () => {
    const f = fakeChatwoot({ convs: [originConv()], inboxBot: 13 });
    const r = await openCaseInInbox(f.client, input({ caseTeamId: 3 }));
    expect(r).toMatchObject({ kind: "opened", caseId: 100, partial: [] });
    expect(f.convs.find((x) => x.id === 100)).toMatchObject({
      status: "open",
      bot: null,
      teamId: 3,
    });
  });

  test("no pinned team: the bot is still cleared, and no team is written (Chatwoot routes)", async () => {
    const f = fakeChatwoot({
      continueOpen: true,
      convs: [originConv(), emailAgentsCase()],
    });
    await openCaseInInbox(f.client, input());
    expect(f.calls.some((x) => x.fn === "assignTeam")).toBe(false);
    expect(f.convs.find((x) => x.id === 55)?.bot).toBeNull();
    expect(f.convs.find((x) => x.id === 55)?.teamId).toBeUndefined();
  });

  test("this origin's known case, pending with the bot: reopened, cleared and given the team", async () => {
    const f = fakeChatwoot({
      convs: [
        { ...originConv(), attrs: { case_conversation_id: 55 } },
        emailAgentsCase(),
      ],
    });
    const r = await openCaseInInbox(f.client, input({ caseTeamId: 3 }));
    expect(r).toMatchObject({ kind: "already_open", caseId: 55, partial: [] });
    expect(f.convs.find((x) => x.id === 55)).toMatchObject({
      status: "open",
      bot: null,
      teamId: 3,
    });
  });

  test("an owner write that fails is reported, and the case is still open", async () => {
    const f = fakeChatwoot({
      continueOpen: true,
      convs: [originConv(), emailAgentsCase()],
      failOn: new Set(["unassignConversation", "assignTeam"]),
    });
    const r = await openCaseInInbox(f.client, input({ caseTeamId: 3 }));
    expect(r).toMatchObject({
      kind: "continued",
      partial: ["case_assignee", "case_team"],
    });
    expect(f.convs.find((x) => x.id === 55)?.status).toBe("open");
  });

  // Routing or an operator acting while the clear is in flight: the fake applies it right after
  // the clear, as the next read would see it.
  const routedDuringClear = (
    f: ReturnType<typeof fakeChatwoot>,
    apply: (c: Conv) => void,
  ): CaseClient =>
    ({
      ...f.client,
      unassignConversation: async (id: number, o?: { asAdmin?: boolean }) => {
        const r = await f.client.unassignConversation(id, o);
        const c = f.convs.find((x) => x.id === id);
        if (c) apply(c);
        return r;
      },
    }) as CaseClient;

  test("a team routed while the clear was in flight is not overwritten", async () => {
    const f = fakeChatwoot({
      continueOpen: true,
      convs: [originConv(), emailAgentsCase()],
    });
    const client = routedDuringClear(f, (c) => {
      c.teamId = 9;
    });
    const r = await openCaseInInbox(client, input({ caseTeamId: 3 }));
    expect(r).toMatchObject({ kind: "continued", partial: [] });
    expect(f.calls.some((x) => x.fn === "assignTeam")).toBe(false);
    expect(f.convs.find((x) => x.id === 55)?.teamId).toBe(9);
  });

  test("a person assigned while the clear was in flight keeps the case, no team written", async () => {
    const f = fakeChatwoot({
      continueOpen: true,
      convs: [originConv(), emailAgentsCase()],
    });
    const client = routedDuringClear(f, (c) => {
      c.human = 21;
    });
    await openCaseInInbox(client, input({ caseTeamId: 3 }));
    expect(f.calls.some((x) => x.fn === "assignTeam")).toBe(false);
    expect(f.convs.find((x) => x.id === 55)?.human).toBe(21);
  });

  test("the read before the team fails: told apart from a refused write, and no team written blind", async () => {
    const f = fakeChatwoot({
      continueOpen: true,
      convs: [originConv(), emailAgentsCase()],
    });
    let cleared = false;
    const client = {
      ...f.client,
      unassignConversation: async (id: number, o?: { asAdmin?: boolean }) => {
        cleared = true;
        return f.client.unassignConversation(id, o);
      },
      getConversation: async (id: number) => {
        if (cleared) throw new ChatwootApiError(500, "GET");
        return f.client.getConversation(id);
      },
    } as CaseClient;
    const r = await openCaseInInbox(client, input({ caseTeamId: 3 }));
    expect(r).toMatchObject({
      kind: "continued",
      partial: [],
      caseOwnerUnread: "before_team",
    });
    expect(f.calls.some((x) => x.fn === "assignTeam")).toBe(false);
    expect(f.convs.find((x) => x.id === 55)?.bot).toBeNull();
  });

  test("an unreadable case: reported as unread, not as writes that failed, and nothing guessed", async () => {
    const f = fakeChatwoot({
      convs: [
        { ...originConv(), attrs: { case_conversation_id: 55 } },
        emailAgentsCase({ status: "open" }),
      ],
    });
    // The first read (the known case) answers; the owner read after it fails.
    let reads = 0;
    const client = {
      ...f.client,
      getConversation: async (id: number) => {
        reads++;
        if (reads > 2) throw new ChatwootApiError(500, "GET");
        return f.client.getConversation(id);
      },
    } as CaseClient;
    const r = await openCaseInInbox(client, input({ caseTeamId: 3 }));
    expect(r).toMatchObject({
      kind: "already_open",
      partial: [],
      caseOwnerUnread: "before_clear",
    });
    // NOTE: no owner write; the one write is the reason's note, which does not depend on the owner.
    expect(writesOf(f.calls)).toEqual(["sendMessageAsAdmin"]);
  });

  describe("the tool", () => {
    const build = (
      f: ReturnType<typeof fakeChatwoot>,
      handoff: Record<string, unknown> | undefined,
      reported: Array<{ phase: string; detail: unknown }> = [],
    ) => {
      const client = { ...f.client, muted: false } as unknown as ChatwootClient;
      const [t] = buildNativeTools(
        {
          client,
          conversationId: 7,
          crossInboxCase: {
            config: { ...CROSS_INBOX_CASE_DEFAULTS, targetInboxId: 40 },
            contactId: 5,
          },
          ...(handoff ? { handoff } : {}),
          onSideEffectError: (e: { phase: string; detail: unknown }) => {
            reported.push({ phase: e.phase, detail: e.detail });
          },
        } as never,
        ["open_case_in_inbox"],
      );
      if (!t) throw new Error("tool not built");
      return t;
    };
    const pinned = (o: Record<string, unknown>) => ({
      mode: "pinned",
      targetAgentId: null,
      targetTeamId: null,
      targetInstanceId: null,
      instructions: null,
      ...o,
    });

    test("the pinned handoff team is the case's team", async () => {
      const f = fakeChatwoot({
        continueOpen: true,
        convs: [originConv(), emailAgentsCase()],
      });
      await build(f, pinned({ targetTeamId: 3 })).invoke({ reason: "x" });
      expect(f.convs.find((x) => x.id === 55)).toMatchObject({
        bot: null,
        teamId: 3,
      });
    });

    test("a pinned person, or routing, writes no team", async () => {
      for (const h of [
        pinned({ targetAgentId: 21, targetTeamId: 3 }),
        { ...pinned({ targetTeamId: 3 }), mode: "route" },
        undefined,
      ]) {
        const f = fakeChatwoot({
          continueOpen: true,
          convs: [originConv(), emailAgentsCase()],
        });
        await build(f, h).invoke({ reason: "x" });
        expect(f.calls.some((x) => x.fn === "assignTeam")).toBe(false);
        expect(f.convs.find((x) => x.id === 55)?.bot).toBeNull();
      }
    });

    test("a failed owner write reaches the flow log as a warning, on an already-open case too", async () => {
      const reported: Array<{ phase: string; detail: unknown }> = [];
      const f = fakeChatwoot({
        convs: [
          { ...originConv(), attrs: { case_conversation_id: 55 } },
          emailAgentsCase(),
        ],
        failOn: new Set(["unassignConversation"]),
      });
      await build(f, undefined, reported).invoke({ reason: "x" });
      expect(reported).toEqual([
        {
          phase: "follow_up_writes",
          detail: { caseId: 55, failed: ["case_assignee"] },
        },
      ]);
    });

    // A write Chatwoot refused and a case that could not be read are different things to whoever
    // reads the log: the second wrote nothing, so it names no write as failed.
    test("an unreadable case reaches the flow log as its own warning, naming no failed write", async () => {
      const reported: Array<{ phase: string; detail: unknown }> = [];
      const messages: string[] = [];
      const f = fakeChatwoot({
        convs: [
          { ...originConv(), attrs: { case_conversation_id: 55 } },
          emailAgentsCase({ status: "open" }),
        ],
      });
      let reads = 0;
      const client = {
        ...f.client,
        muted: false,
        getConversation: async (id: number) => {
          reads++;
          if (reads > 2) throw new ChatwootApiError(500, "GET");
          return f.client.getConversation(id);
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
          handoff: pinned({ targetTeamId: 3 }),
          onSideEffectError: (e: {
            phase: string;
            detail: unknown;
            err: Error;
          }) => {
            reported.push({ phase: e.phase, detail: e.detail });
            messages.push(e.err.message);
          },
        } as never,
        ["open_case_in_inbox"],
      );
      if (!t) throw new Error("tool not built");
      await t.invoke({ reason: "x" });
      expect(reported).toEqual([
        {
          phase: "case_owner_unread",
          detail: { caseId: 55, at: "before_clear" },
        },
      ]);
      expect(messages[0]).toContain("could not be read");
      expect(messages[0]).toContain("nothing was written");
      expect(writesOf(f.calls)).toEqual(["sendMessageAsAdmin"]);
    });
  });
});

// The operator's opening email and the single note on the case: the model writes only its part, the
// operator writes the rest, and the team reads the case from one note.
describe("the operator's opening and the case note (issue #923)", () => {
  const vars = {
    nome_contato: "Ana Souza",
    contact_name: "Ana Souza",
    primeiro_nome: "Ana",
    contact_first_name: "Ana",
  };
  const interpolate = (t: string) => interpolatePromptVars(t, vars);
  const ORIGIN = "https://cw.example/app/accounts/1/conversations/7";
  const TEMPLATE =
    "Olá, {{primeiro_nome}}!\n\nSua solicitação nº {{numero_caso}} foi recebida.\n\n{{mensagem}}\n\nAtenciosamente,\nEquipe";
  const withTemplates = (
    opening: string | null,
    note: string | null = null,
    over: Partial<OpenCaseInput> = {},
  ) =>
    input({
      config: {
        ...CROSS_INBOX_CASE_DEFAULTS,
        targetInboxId: 40,
        openingTemplate: opening,
        noteTemplate: note,
      },
      interpolate,
      ...over,
    });
  const sends = (f: ReturnType<typeof fakeChatwoot>, priv: boolean) =>
    f.calls
      .filter(
        (c) =>
          c.fn === "sendMessageAsAdmin" &&
          (c.args[2] as { private: boolean }).private === priv,
      )
      .map((c) => String(c.args[1]));

  describe("settings", () => {
    test("both templates default to none, and are read trimmed", () => {
      expect(CROSS_INBOX_CASE_DEFAULTS.openingTemplate).toBeNull();
      expect(CROSS_INBOX_CASE_DEFAULTS.noteTemplate).toBeNull();
      const c = readCrossInboxCaseConfig({
        crossInboxCase: {
          targetInboxId: 40,
          openingTemplate: "  Olá {{mensagem}} ",
          noteTemplate: " {{motivo}}\n",
        },
      });
      expect(c.openingTemplate).toBe("Olá {{mensagem}}");
      expect(c.noteTemplate).toBe("{{motivo}}");
      const empty = readCrossInboxCaseConfig({
        crossInboxCase: {
          targetInboxId: 40,
          openingTemplate: " ",
          noteTemplate: "",
        },
      });
      expect(empty.openingTemplate).toBeNull();
      expect(empty.noteTemplate).toBeNull();
    });

    test("the message is asked for without a template, and by a template that has the placeholder", () => {
      expect(openingAsksMessage(null)).toBe(true);
      expect(openingAsksMessage("Olá {{mensagem}}")).toBe(true);
      expect(openingAsksMessage("Olá {{ message }}")).toBe(true);
      expect(openingAsksMessage("Olá, caso {{numero_caso}}")).toBe(false);
    });

    test("the opening: context variables, the case number, and the model's text kept literal", () => {
      expect(
        renderCaseOpening(TEMPLATE, "Vamos verificar.", 123, interpolate),
      ).toBe(
        "Olá, Ana!\n\nSua solicitação nº 123 foi recebida.\n\nVamos verificar.\n\nAtenciosamente,\nEquipe",
      );
      expect(
        renderCaseOpening(
          "{{case_number}}: {{message}}",
          "Confira {{numero_caso}} e {{primeiro_nome}}",
          9,
          interpolate,
        ),
      ).toBe("9: Confira {{ '{{' }}numero_caso}} e {{ '{{' }}primeiro_nome}}");
    });

    test("the default note: the subject as the title, a link to the origin, the reason", () => {
      const note = renderCaseNote(
        null,
        {
          subject: "Pedido de Ana: troca",
          reason: "Linha um\nLinha dois",
          originUrl: ORIGIN,
        },
        interpolate,
      );
      const lines = note.split("\n").filter((l) => l.trim() !== "");
      expect(lines[0]).toBe("### Pedido de Ana: troca");
      expect(note).toContain(`](${ORIGIN})`);
      expect(note).toContain("Linha um\nLinha dois");
      const bare = renderCaseNote(
        null,
        { subject: null, reason: "x", originUrl: ORIGIN },
        interpolate,
      );
      expect(bare).not.toContain("###");
      expect(bare).toContain(`](${ORIGIN})`);
    });

    test("the note template takes its variables in both languages, and the model's text stays literal", () => {
      expect(
        renderCaseNote(
          "{{assunto}}|{{subject}}|{{motivo}}|{{reason}}|{{link_origem}}|{{origin_url}}|{{primeiro_nome}}",
          { subject: "S", reason: "R {{assunto}}", originUrl: ORIGIN },
          interpolate,
        ),
      ).toBe(
        `S|S|R {{ '{{' }}assunto}}|R {{ '{{' }}assunto}}|${ORIGIN}|${ORIGIN}|Ana`,
      );
      expect(
        renderCaseNote(
          null,
          { subject: "Troca {{x}}", reason: "R", originUrl: ORIGIN },
          interpolate,
        ),
      ).toStartWith("### Troca {{ '{{' }}x}}\n");
    });
  });

  describe("the service", () => {
    test("a template with the message: one opening, rendered around the model's part, with the case number and no signature", async () => {
      const f = fakeChatwoot();
      await openCaseInInbox(
        f.client,
        withTemplates(TEMPLATE, null, {
          customerMessage: "Vamos verificar seu pedido.",
          signCustomerMessage: (t) => `${t}\n-- Assinatura`,
        }),
      );
      expect(sends(f, false)).toEqual([
        "Olá, Ana!\n\nSua solicitação nº 100 foi recebida.\n\nVamos verificar seu pedido.\n\nAtenciosamente,\nEquipe",
      ]);
    });

    // The model's part goes in escaped once, whether the opening is sent or kept as a note; the
    // operator's text around it keeps its Liquid for Chatwoot to render.
    test("a template's model part is escaped once, sent or kept as a note, and the operator's Liquid stays", async () => {
      const tpl = "{{contact.name}}, caso {{numero_caso}}: {{mensagem}}";
      const f = fakeChatwoot();
      await openCaseInInbox(
        f.client,
        withTemplates(tpl, null, { customerMessage: "veja {{contact.email}}" }),
      );
      expect(sends(f, false)).toEqual([
        "{{contact.name}}, caso 100: veja {{ '{{' }}contact.email}}",
      ]);
      const closed = fakeChatwoot({ canReply: false });
      await openCaseInInbox(
        closed.client,
        withTemplates(tpl, null, { customerMessage: "veja {{contact.email}}" }),
      );
      expect(
        sends(closed, true).some((n) =>
          n.endsWith(
            "{{contact.name}}, caso 100: veja {{ '{{' }}contact.email}}",
          ),
        ),
      ).toBe(true);
    });

    // A context variable is the contact's data, and a code span of the operator's around a value
    // would show its escape: both come out as the customer and the team should read them.
    test("a contact's name and a value inside the operator's code span come out as written", async () => {
      const f = fakeChatwoot();
      await openCaseInInbox(
        f.client,
        withTemplates(
          "Olá, {{primeiro_nome}}! {{mensagem}}",
          "Motivo: `{{motivo}}`",
          {
            customerMessage: "Ok.",
            reason: "pediu {{foo}}",
            interpolate: (t) =>
              interpolatePromptVars(
                t,
                { primeiro_nome: "{{contact.email}}{{mensagem}}" },
                { wrap: markValue },
              ),
          },
        ),
      );
      expect(sends(f, false)).toEqual([
        "Olá, {{ '{{' }}contact.email}}{{ '{{' }}mensagem}}! Ok.",
      ]);
      expect(sends(f, true)).toContain(
        "Motivo: {{ '%60' | url_decode }}pediu {{ '{{' }}foo}}{{ '%60' | url_decode }}",
      );
    });

    test("without a template the opening is the model's text, signed, as before", async () => {
      const f = fakeChatwoot();
      await openCaseInInbox(
        f.client,
        withTemplates(null, null, {
          signCustomerMessage: (t) => `${t} -- Ana`,
        }),
      );
      expect(sends(f, false)).toEqual([
        "Olá! Abrimos seu atendimento por aqui. -- Ana",
      ]);
    });

    test("a fixed template goes out even when the model wrote nothing", async () => {
      const f = fakeChatwoot();
      await openCaseInInbox(
        f.client,
        withTemplates(
          "Olá, {{primeiro_nome}}! Caso nº {{numero_caso}}.",
          null,
          {
            customerMessage: null,
          },
        ),
      );
      expect(sends(f, false)).toEqual(["Olá, Ana! Caso nº 100."]);
    });

    test("a template that needs the model's part sends nothing without it", async () => {
      const f = fakeChatwoot();
      await openCaseInInbox(
        f.client,
        withTemplates(TEMPLATE, null, { customerMessage: null }),
      );
      expect(sends(f, false)).toEqual([]);
    });

    test("a model part the output check refuses discards the whole opening; the case and its note still land", async () => {
      const f = fakeChatwoot();
      const r = await openCaseInInbox(
        f.client,
        withTemplates(TEMPLATE, null, {
          customerMessage: "PROIBIDO",
          screenCustomerMessage: async (t) =>
            t.includes("PROIBIDO") ? "drop" : "send",
        }),
      );
      expect(r).toMatchObject({ kind: "opened", openingBlocked: true });
      expect(sends(f, false)).toEqual([]);
      expect(sends(f, true)).toHaveLength(1);
    });

    test("a refused part discards a fixed opening too, when a caller passed one", async () => {
      const f = fakeChatwoot();
      await openCaseInInbox(
        f.client,
        withTemplates("Caso nº {{numero_caso}}.", null, {
          customerMessage: "PROIBIDO",
          screenCustomerMessage: async (t) =>
            t.includes("PROIBIDO") ? "drop" : "send",
        }),
      );
      expect(sends(f, false)).toEqual([]);
    });

    test("a continued case gets no opening, template or not", async () => {
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
            status: "open",
            attrs: {},
            labels: [],
          },
        ],
      });
      const r = await openCaseInInbox(
        f.client,
        withTemplates("Caso nº {{numero_caso}}.", null),
      );
      expect(r.kind).toBe("continued");
      expect(sends(f, false)).toEqual([]);
    });

    test("a closed reply window leaves the rendered opening to the team", async () => {
      const f = fakeChatwoot({
        canReply: false,
        inboxes: {
          40: { name: "WhatsApp oficial", channel_type: "Channel::Whatsapp" },
        },
      });
      await openCaseInInbox(
        f.client,
        withTemplates("Caso nº {{numero_caso}}."),
      );
      expect(sends(f, false)).toEqual([]);
      expect(sends(f, true)[0]).toBe(
        `${OPENING_OUTSIDE_WINDOW_PREFIX}Caso nº 100.`,
      );
    });

    test("the case gets ONE note, headed by the subject, with the origin link and the reason", async () => {
      const f = fakeChatwoot();
      await openCaseInInbox(
        f.client,
        withTemplates(null, null, {
          subject: "Pedido de Ana: troca",
          reason: "Linha um\nLinha dois",
        }),
      );
      const notes = sends(f, true);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toStartWith("### Pedido de Ana: troca\n");
      expect(notes[0]).toContain(`](${ORIGIN})`);
      expect(notes[0]).toContain("Linha um\nLinha dois");
    });

    test("the operator's note template replaces the layout", async () => {
      const f = fakeChatwoot();
      await openCaseInInbox(
        f.client,
        withTemplates(null, "{{motivo}} em {{link_origem}}", {
          reason: "troca",
        }),
      );
      expect(sends(f, true)).toEqual([`troca em ${ORIGIN}`]);
    });

    test("a refused subject is not the note's title either", async () => {
      const f = fakeChatwoot();
      await openCaseInInbox(
        f.client,
        withTemplates(null, null, {
          subject: "Assunto proibido",
          screenCustomerMessage: async (t) =>
            t === "Assunto proibido" ? "drop" : "send",
        }),
      );
      expect(sends(f, true)[0]).not.toContain("Assunto proibido");
    });

    test("a note that does not land is one partial step", async () => {
      const f = fakeChatwoot({ failOn: new Set(["sendMessageAsAdmin"]) });
      const r = await openCaseInInbox(
        f.client,
        withTemplates(null, null, { customerMessage: null }),
      );
      expect((r as { partial: string[] }).partial).toEqual([
        "destination_note",
      ]);
    });
  });

  describe("the tool", () => {
    function openingTool(
      f: ReturnType<typeof fakeChatwoot>,
      template: string | null,
      sign?: (t: string) => string,
    ) {
      const client = { ...f.client, muted: false } as unknown as ChatwootClient;
      const [t] = buildNativeTools(
        {
          client,
          conversationId: 7,
          crossInboxCase: {
            config: {
              ...CROSS_INBOX_CASE_DEFAULTS,
              targetInboxId: 40,
              openingTemplate: template,
            },
            contactId: 5,
            interpolate,
            sign,
          },
        },
        ["open_case_in_inbox"],
      );
      if (!t) throw new Error("tool not built");
      return t;
    }
    const keys = (template: string | null) =>
      Object.keys(
        (
          openingTool(fakeChatwoot(), template).schema as {
            shape: Record<string, unknown>;
          }
        ).shape,
      );

    test("a fixed opening takes the message argument out of the schema", () => {
      expect(keys("Olá, caso {{numero_caso}}")).not.toContain(
        "customer_message",
      );
      expect(keys(TEMPLATE)).toContain("customer_message");
      expect(keys(null)).toContain("customer_message");
    });

    test("the description says the opening is fixed when it is", () => {
      const d = (t: string | null) =>
        openingTool(fakeChatwoot(), t).description;
      expect(d("Olá, caso {{numero_caso}}")).not.toContain("customer_message");
      expect(d(TEMPLATE)).toContain("customer_message");
    });

    test("the tool renders the operator's opening, unsigned", async () => {
      const f = fakeChatwoot();
      const t = openingTool(f, TEMPLATE, (x) => `${x} -- Ana`);
      await t.invoke({ reason: "x", customer_message: "Parte do modelo." });
      expect(sends(f, false)).toEqual([
        "Olá, Ana!\n\nSua solicitação nº 100 foi recebida.\n\nParte do modelo.\n\nAtenciosamente,\nEquipe",
      ]);
    });
  });
});
