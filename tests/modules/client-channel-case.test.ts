import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { loadDetachedConfig } from "@/graph/detached-turn";
import { unverifiedAddressNote } from "@/graph/tools/native";
import type { TenantContext } from "@/lib/tenancy";
import {
  ChatwootApiError,
  type ChatwootClient,
} from "@/modules/chatwoot/client";
import { asRendered } from "@/modules/chatwoot/liquid";
import {
  anonymousCaseContactIdentifier,
  type CaseContactClient,
  caseContactIdentifier,
  detachedCaseFor,
  resolveAnonymousCaseContact,
  resolveCaseContact,
  UNVERIFIED_EMAIL_ATTRIBUTE,
  userTypedOnThread,
} from "@/modules/client-channel/case";
import { runClientTurn } from "@/modules/client-channel/service";
import { dbProbeFailed } from "@/tests/db-gate";
import { guardrailModel } from "../utils/scripted-models";

// Escalation on the client channel: the agent opens the user's request as a case in the team's inbox,
// for the contact the host stated, and the thread remembers the case it opened.

interface FakeContact {
  id: number;
  email: string | null;
  identifier: string | null;
  attrs?: Record<string, unknown>;
}

function contactBook(
  initial: FakeContact[] = [],
  opts: {
    refuseCreate?: (f: Record<string, unknown>) => boolean;
    // Runs before an attribute write lands, to play another worker or to fail it.
    beforeMark?: (id: number, attrs: Record<string, unknown>) => void;
    afterFindByIdentifier?: (id: number | null) => void;
  } = {},
) {
  const rows = [...initial];
  const created: Array<Record<string, unknown>> = [];
  const updates: Array<[number, Record<string, unknown>]> = [];
  const marked: Array<[number, Record<string, unknown>]> = [];
  let next = 500;
  const client: CaseContactClient = {
    setContactCustomAttributes: async (id, attrs) => {
      opts.beforeMark?.(id, attrs);
      marked.push([id, { ...attrs }]);
      const row = rows.find((r) => r.id === id);
      if (row) row.attrs = { ...row.attrs, ...attrs };
      return {};
    },
    getContact: async (id) => {
      const r = rows.find((c) => c.id === id);
      return r
        ? {
            id,
            name: null,
            email: r.email,
            phoneNumber: null,
            identifier: r.identifier,
            customAttributes: r.attrs,
          }
        : null;
    },
    updateContact: async (id, fields) => {
      updates.push([id, { ...fields }]);
      if ("identifier" in fields) {
        const row = rows.find((r) => r.id === id);
        if (row) row.identifier = fields.identifier ?? null;
      }
      if (
        fields.email &&
        rows.some(
          (r) =>
            r.id !== id &&
            r.email?.toLowerCase() === fields.email?.toLowerCase(),
        )
      )
        throw new ChatwootApiError(422, `PUT /contacts/${id}`);
      const row = rows.find((r) => r.id === id);
      if (row && fields.email) row.email = fields.email;
      return {};
    },
    findContactIdByIdentifier: async (identifier) => {
      const id = rows.find((r) => r.identifier === identifier)?.id ?? null;
      opts.afterFindByIdentifier?.(id);
      return id;
    },
    findContactIdByEmail: async (email) =>
      rows.find((r) => r.email?.toLowerCase() === email.toLowerCase())?.id ??
      null,
    createContact: async (fields) => {
      created.push({ ...fields });
      const clash = rows.some(
        (r) =>
          (fields.email && r.email === fields.email) ||
          (fields.identifier && r.identifier === fields.identifier),
      );
      if (clash || opts.refuseCreate?.(fields))
        throw new ChatwootApiError(422, "POST /contacts");
      const row = {
        id: next++,
        email: fields.email ?? null,
        identifier: fields.identifier ?? null,
      };
      rows.push(row);
      return row.id;
    },
  };
  return { client, rows, created, updates, marked };
}

const ana = { id: 7n, name: "Ana", email: "ana@exemplo.com" };
const mine = (over: Partial<FakeContact> = {}): FakeContact => ({
  id: 9,
  email: null,
  identifier: caseContactIdentifier(7n),
  ...over,
});

describe("the contact a case is opened for", () => {
  test("a user with no contact yet gets one, marked as ours", async () => {
    const book = contactBook();
    expect((await resolveCaseContact(book.client, ana)).id).toBe(500);
    expect(book.created).toEqual([
      {
        name: "Ana",
        email: "ana@exemplo.com",
        identifier: caseContactIdentifier(7n),
      },
    ]);
  });

  test("our contact, found by its identifier, takes the email the host states now", async () => {
    const book = contactBook([mine({ email: "antigo@exemplo.com" })]);
    expect(await resolveCaseContact(book.client, ana)).toEqual({
      id: 9,
      addressUpdated: true,
    });
    expect(book.rows.find((r) => r.id === 9)?.email).toBe("ana@exemplo.com");
    expect(book.created).toEqual([]);
  });

  test("our contact already up to date is not written", async () => {
    const book = contactBook([mine({ email: "Ana@Exemplo.com" })]);
    expect(await resolveCaseContact(book.client, ana)).toEqual({
      id: 9,
      addressUpdated: false,
    });
    expect(book.updates).toEqual([]);
  });

  test("an email another contact holds sends the case to that customer", async () => {
    const book = contactBook([
      mine({ email: "antigo@exemplo.com" }),
      { id: 3, email: "ana@exemplo.com", identifier: null },
    ]);
    expect((await resolveCaseContact(book.client, ana)).id).toBe(3);
  });

  test("a customer the team already knows by that email is the contact", async () => {
    const book = contactBook([
      { id: 3, email: "ANA@exemplo.com", identifier: null },
    ]);
    expect((await resolveCaseContact(book.client, ana)).id).toBe(3);
    expect(book.created).toEqual([]);
  });

  test("a create that loses a race reads the contact the other one made", async () => {
    const book = contactBook([], {
      refuseCreate: () => {
        book.rows.push(mine({ id: 77, email: "ana@exemplo.com" }));
        return true;
      },
    });
    expect((await resolveCaseContact(book.client, ana)).id).toBe(77);
  });

  test("any other refusal is not swallowed", async () => {
    const client: CaseContactClient = {
      setContactCustomAttributes: async () => ({}),
      getContact: async () => null,
      updateContact: async () => ({}),
      findContactIdByIdentifier: async () => null,
      findContactIdByEmail: async () => null,
      createContact: async () => {
        throw new ChatwootApiError(500, "POST /contacts");
      },
    };
    await expect(resolveCaseContact(client, ana)).rejects.toThrow();
  });
});

describe("the contact a case is opened for from an anonymous visitor", () => {
  const visitor = { id: 7n, email: "visitante@exemplo.com" };

  test("gets a contact of its own, marked unverified, and never one found by the address", async () => {
    const book = contactBook();
    const first = await resolveAnonymousCaseContact(book.client, visitor);
    expect({
      first,
      created: book.created,
      marked: book.marked,
    }).toEqual({
      first: { id: 500, addressUpdated: false },
      created: [
        {
          email: "visitante@exemplo.com",
          identifier: anonymousCaseContactIdentifier(
            7n,
            "visitante@exemplo.com",
          ),
        },
      ],
      marked: [[500, { [UNVERIFIED_EMAIL_ATTRIBUTE]: true }]],
    });
  });

  test("an address another contact holds is refused, not borrowed", async () => {
    const book = contactBook([
      { id: 40, email: "Visitante@exemplo.com", identifier: null },
    ]);
    const held = await resolveAnonymousCaseContact(book.client, visitor);
    expect({ held, created: book.created, updates: book.updates }).toEqual({
      held: "held",
      created: [],
      updates: [],
    });
  });

  test("a new address is a new contact: an anonymous call never changes an address", async () => {
    const book = contactBook();
    const first = await resolveAnonymousCaseContact(book.client, visitor);
    const second = await resolveAnonymousCaseContact(book.client, {
      ...visitor,
      email: "outro@exemplo.com",
    });
    expect({
      first,
      second,
      emails: book.rows.map((c) => c.email),
      updates: book.updates,
    }).toEqual({
      first: { id: 500, addressUpdated: false },
      second: { id: 501, addressUpdated: false },
      emails: ["visitante@exemplo.com", "outro@exemplo.com"],
      updates: [],
    });
  });

  test("once a signed-in user takes the contact, the visitor no longer reaches it", async () => {
    const book = contactBook();
    // The visitor got there first with someone else's address.
    await resolveAnonymousCaseContact(book.client, {
      ...visitor,
      email: "ana@exemplo.com",
    });
    const adopted = await resolveCaseContact(book.client, ana);
    const again = await resolveAnonymousCaseContact(book.client, {
      ...visitor,
      email: "ana@exemplo.com",
    });
    expect({
      adopted: adopted.id,
      identifier: book.rows[0]?.identifier,
      unmarked: book.marked.at(-1),
      again,
    }).toEqual({
      adopted: 500,
      identifier: null,
      unmarked: [500, { [UNVERIFIED_EMAIL_ATTRIBUTE]: false }],
      again: "held",
    });
  });

  test("its own contact whose address the team changed is not reached by the old one", async () => {
    const book = contactBook([
      {
        id: 60,
        email: "corrigido@exemplo.com",
        identifier: anonymousCaseContactIdentifier(7n, visitor.email),
      },
    ]);
    expect({
      result: await resolveAnonymousCaseContact(book.client, visitor),
      marked: book.marked,
      created: book.created,
    }).toEqual({ result: "held", marked: [], created: [] });
  });

  test("a contact released between the search and the read is not the visitor's", async () => {
    const book = contactBook(
      [
        {
          id: 61,
          email: visitor.email,
          identifier: anonymousCaseContactIdentifier(7n, visitor.email),
        },
      ],
      {
        // A signed-in user's resolution on another worker releases it right after the search.
        afterFindByIdentifier: (id) => {
          const row = book.rows.find((r) => r.id === id);
          if (row) row.identifier = null;
        },
      },
    );
    expect({
      result: await resolveAnonymousCaseContact(book.client, visitor),
      marked: book.marked,
    }).toEqual({ result: "held", marked: [] });
  });

  test("a contact released while the visitor marks it is handed back unmarked", async () => {
    let released = false;
    const book = contactBook(
      [
        {
          id: 62,
          email: visitor.email,
          identifier: anonymousCaseContactIdentifier(7n, visitor.email),
        },
      ],
      {
        beforeMark: (id, attrs) => {
          if (released || attrs[UNVERIFIED_EMAIL_ATTRIBUTE] !== true) return;
          released = true;
          const row = book.rows.find((r) => r.id === id);
          if (row) {
            row.identifier = null;
            row.attrs = { [UNVERIFIED_EMAIL_ATTRIBUTE]: false };
          }
        },
      },
    );
    expect({
      result: await resolveAnonymousCaseContact(book.client, visitor),
      attrs: book.rows[0]?.attrs,
    }).toEqual({
      result: "held",
      attrs: { [UNVERIFIED_EMAIL_ATTRIBUTE]: false },
    });
  });

  test("a contact the visitor just created and lost to a signed-in user is handed back unmarked", async () => {
    let released = false;
    const book = contactBook([], {
      beforeMark: (id, attrs) => {
        if (released || attrs[UNVERIFIED_EMAIL_ATTRIBUTE] !== true) return;
        released = true;
        const row = book.rows.find((r) => r.id === id);
        if (row) {
          row.identifier = null;
          row.attrs = { [UNVERIFIED_EMAIL_ATTRIBUTE]: false };
        }
      },
    });
    expect({
      result: await resolveAnonymousCaseContact(book.client, visitor),
      created: book.created.length,
      attrs: book.rows[0]?.attrs,
    }).toEqual({
      result: "held",
      created: 1,
      attrs: { [UNVERIFIED_EMAIL_ATTRIBUTE]: false },
    });
  });

  test("a contact the team moves to another address while the visitor marks it stays marked", async () => {
    let moved = false;
    const book = contactBook(
      [
        {
          id: 63,
          email: visitor.email,
          identifier: anonymousCaseContactIdentifier(7n, visitor.email),
        },
      ],
      {
        beforeMark: (id, attrs) => {
          if (moved || attrs[UNVERIFIED_EMAIL_ATTRIBUTE] !== true) return;
          moved = true;
          const row = book.rows.find((r) => r.id === id);
          if (row) row.email = "corrigido@exemplo.com";
        },
      },
    );
    expect({
      result: await resolveAnonymousCaseContact(book.client, visitor),
      attrs: book.rows[0]?.attrs,
    }).toEqual({
      result: "held",
      attrs: { [UNVERIFIED_EMAIL_ATTRIBUTE]: true },
    });
  });

  test("a release that failed halfway clears the mark on the next call", async () => {
    let failed = false;
    const book = contactBook([], {
      beforeMark: (_id, attrs) => {
        if (failed || attrs[UNVERIFIED_EMAIL_ATTRIBUTE] !== false) return;
        failed = true;
        throw new ChatwootApiError(500, "POST /contacts/500");
      },
    });
    await resolveAnonymousCaseContact(book.client, {
      ...visitor,
      email: "ana@exemplo.com",
    });
    await expect(resolveCaseContact(book.client, ana)).rejects.toThrow();
    const retried = await resolveCaseContact(book.client, ana);
    expect({
      retried: retried.id,
      identifier: book.rows[0]?.identifier,
      attrs: book.rows[0]?.attrs,
    }).toEqual({
      retried: 500,
      identifier: null,
      attrs: { [UNVERIFIED_EMAIL_ATTRIBUTE]: false },
    });
  });

  test("a create lost to someone else's contact on that address is refused", async () => {
    const book = contactBook([], {
      refuseCreate: () => {
        book.rows.push({ id: 42, email: visitor.email, identifier: null });
        return true;
      },
    });
    expect(await resolveAnonymousCaseContact(book.client, visitor)).toBe(
      "held",
    );
  });

  test("the unverified note shows the address as typed, not as a template Chatwoot renders", () => {
    const typed = "{{contact.email}}@exemplo.com";
    const note = unverifiedAddressNote(typed);
    expect({ raw: note.includes(typed), shown: asRendered(note) }).toEqual({
      raw: false,
      shown: unverifiedAddressNote("X").replace("X", typed),
    });
  });

  test("the address counts as typed only when a message of the user's carries it", async () => {
    const saver = new MemorySaver();
    const thread = "t-anon";
    const { buildThreadStateGraph, THREAD_STATE_NODE } = await import(
      "@/graph/thread-state"
    );
    await buildThreadStateGraph(saver).updateState(
      { configurable: { thread_id: thread } },
      {
        messages: [
          new HumanMessage("meu e-mail é Visitante@Exemplo.com"),
          new AIMessage("o seu é outro@exemplo.com?"),
        ],
      },
      THREAD_STATE_NODE,
    );
    // A message whose screen context names an address the visitor did not write.
    const withContext = "t-contexto";
    await buildThreadStateGraph(saver).updateState(
      { configurable: { thread_id: withContext } },
      {
        messages: [
          new HumanMessage(
            '<contexto-da-tela>\n{"cliente":"exibido@exemplo.com"}\n</contexto-da-tela>\n\nmeu e-mail é joanna@exemplo.com.br',
          ),
        ],
      },
      THREAD_STATE_NODE,
    );
    const typed = (t: string, email: string, current?: string) =>
      userTypedOnThread(saver, t, email, current);
    expect({
      typed: await typed(thread, "visitante@exemplo.com"),
      onlyTheAgent: await typed(thread, "outro@exemplo.com"),
      noThread: await typed("t-nada", "visitante@exemplo.com"),
      onlyInContext: await typed(withContext, "exibido@exemplo.com"),
      insideAnother: await typed(withContext, "anna@exemplo.com"),
      whole: await typed(withContext, "joanna@exemplo.com.br"),
      thisTurnOnly: await typed(
        "t-nada",
        "agora@exemplo.com",
        "pode responder em agora@exemplo.com.",
      ),
    }).toEqual({
      typed: true,
      onlyTheAgent: false,
      noThread: false,
      onlyInContext: false,
      insideAnother: false,
      whole: true,
      thisTurnOnly: true,
    });
  });
});

// ── the turn ────────────────────────────────────────────────────────────────────────────────────

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let INSTANCE = 0;
const GUARD_MODEL = "guard-judge";
const INBOX = 40;

// The team's account: an email inbox, the contacts and the conversations the case lands in.
function teamAccount() {
  const book = contactBook();
  const convs: Array<{ id: number; contactId: number; attrs: unknown }> = [];
  const sent: Array<{
    id: number;
    content: string;
    private: boolean;
    to: string | null;
  }> = [];
  const client = {
    ...book.client,
    conversationUrl: (id: number) => `https://cw.example/conversations/${id}`,
    getInbox: async () => ({
      id: INBOX,
      name: "E-mail SAC",
      channel_type: "Channel::Email",
    }),
    getContact: async (id: number) => {
      const r = book.rows.find((c) => c.id === id);
      return r
        ? {
            id,
            name: null,
            email: r.email,
            phoneNumber: null,
            identifier: r.identifier,
          }
        : null;
    },
    listContactConversations: async (contactId: number) =>
      convs
        .filter((c) => c.contactId === contactId)
        .map((c) => ({
          id: c.id,
          inboxId: INBOX,
          status: "open",
          customAttributes: c.attrs as Record<string, unknown>,
        })),
    createConversation: async (p: {
      contactId: number;
      customAttributes: unknown;
    }) => {
      const c = {
        id: 900 + convs.length,
        contactId: p.contactId,
        attrs: p.customAttributes,
      };
      convs.push(c);
      return { id: c.id, inboxId: INBOX, status: "open", canReply: true };
    },
    getConversation: async (id: number) => ({
      id,
      inbox_id: INBOX,
      status: "open",
      meta: { sender: { id: convs.find((c) => c.id === id)?.contactId } },
    }),
    unassignConversation: async () => ({}),
    assignTeam: async () => ({}),
    sendMessageAsAdmin: async (
      id: number,
      content: string,
      o: { private: boolean },
    ) => {
      const contactId = convs.find((c) => c.id === id)?.contactId;
      const to = book.rows.find((r) => r.id === contactId)?.email ?? null;
      sent.push({ id, content, private: o.private, to });
      return {};
    },
    listLabels: async () => [],
  } as unknown as ChatwootClient;
  return { client, book, convs, sent };
}

// The agent's model: asked by the user, it opens the case; told the result, it answers.
function escalatingModel(
  opts: { openingViolates?: boolean; email?: string } = {},
) {
  const offered: string[][] = [];
  // The case tool's arguments as offered, and what the tool answered.
  const caseArgs: string[][] = [];
  const answers: string[] = [];
  const agent = {
    bindTools(tools: Array<{ name: string; schema?: { shape?: object } }>) {
      offered.push(tools.map((t) => t.name));
      const caseTool = tools.find((t) => t.name === "open_case_in_inbox");
      if (caseTool) caseArgs.push(Object.keys(caseTool.schema?.shape ?? {}));
      return {
        async invoke(messages: BaseMessage[]) {
          const last = messages.at(-1);
          if (last?.getType() === "tool") answers.push(String(last.content));
          if (last?.getType() === "human")
            return new AIMessage({
              content: "",
              tool_calls: [
                {
                  id: "k1",
                  name: "open_case_in_inbox",
                  args: {
                    reason: "quer renegociar a fatura",
                    customer_message: "Recebemos seu pedido.",
                    ...(opts.email ? { email: opts.email } : {}),
                  },
                },
              ],
            });
          return new AIMessage(
            "Abri seu atendimento, a equipe responde por e-mail.",
          );
        },
      };
    },
  };
  // The guardrails' judge flags the case's opening when told to; everything else passes.
  const judge = guardrailModel(async (messages: { content: unknown }[]) => {
    const judged = messages.map((x) => String(x.content ?? "")).join("\n");
    const violated =
      !!opts.openingViolates && judged.includes("Recebemos seu pedido.");
    return {
      content: JSON.stringify({
        violated,
        categories: violated ? ["competitor_mentions"] : [],
        rationale: "",
        suggestedReply: null,
      }),
    };
  });
  const make = (args: { model?: string }) =>
    (args?.model === GUARD_MODEL ? judge : agent) as unknown as BaseChatModel;
  return { make, offered, caseArgs, answers };
}

let tenantId = 0n;
let agentCase = 0n;
let agentPlain = 0n;
let agentGuarded = 0n;
let ctx: TenantContext;

describe.skipIf(!dbUp)("a case opened from the client channel", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "CCC", slug: `ccc-${process.pid}` },
      })
    ).id;
    ctx = { tenantId, userId: null, role: "TENANT_ADMIN" };
    const deployment = await suDb.chatwootDeployment.create({
      data: {
        tenantId,
        baseUrl: "https://cw.example",
        adminToken: encryptJson("adm"),
      },
    });
    INSTANCE = Number(
      (
        await suDb.chatwootInstance.create({
          data: {
            tenantId,
            deploymentId: deployment.id,
            accountId: 1,
            serverKey: `cw.example-${process.pid}`,
          },
        })
      ).id,
    );
    const vault = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    const mk = (name: string, settings: object) =>
      suDb.agent
        .create({
          data: {
            tenantId,
            name,
            systemPrompt: "x",
            modelConfig: {
              provider: "openai",
              model: "gpt-6-luna",
              credentialRef: `vault:${vault.id}`,
            },
            settings: settings as never,
          },
        })
        .then((a) => a.id);
    agentCase = await mk("com caso", {
      crossInboxCase: { targetInboxId: INBOX, targetInstanceId: INSTANCE },
    });
    agentPlain = await mk("sem caso", {});
    const off = {
      enabled: false,
      action: "template",
      templateMessage: "x",
      checks: {},
    };
    agentGuarded = await mk("caso com guardrail", {
      crossInboxCase: { targetInboxId: INBOX, targetInstanceId: INSTANCE },
      guardrails: {
        enabled: true,
        provider: "openai",
        model: GUARD_MODEL,
        credentialRef: `vault:${vault.id}`,
        competitors: ["Concorrente"],
        input: off,
        output: {
          enabled: true,
          action: "template",
          templateMessage: "[bloqueado]",
          checks: {
            toxicity: false,
            unsafeContent: false,
            competitorMentions: true,
            promptAdherence: false,
            answerRelevance: false,
          },
        },
      },
    });
  });

  afterAll(async () => {
    if (tenantId) await suDb.tenant.deleteMany({ where: { id: tenantId } });
    await appDb.$disconnect();
    await suDb.$disconnect();
  });

  const turn = (
    agentId: bigint,
    m: ReturnType<typeof escalatingModel>,
    account: ReturnType<typeof teamAccount>,
    user: Record<string, string>,
    threadId?: string,
    message = "quero falar com alguém do financeiro",
  ) =>
    runClientTurn({
      ctx,
      agentId,
      threadId,
      user: { id: "u-1", ...user },
      message,
      clientTools: [],
      base: appDb,
      deps: {
        makeModel: m.make as never,
        checkpointer: new MemorySaver(),
        loadChatwootClient: async (_t, instanceId) => {
          expect(Number(instanceId)).toBe(INSTANCE);
          return account.client;
        },
      },
    });

  test("the case opens for the host's user, in the team's inbox, and the thread records it", async () => {
    const m = escalatingModel();
    const account = teamAccount();
    const r = await turn(agentCase, m, account, {
      name: "Ana",
      email: "ana@exemplo.com",
    });
    expect(r).toMatchObject({ status: "done" });
    expect(account.book.rows).toHaveLength(1);
    expect(account.book.rows[0]?.email).toBe("ana@exemplo.com");
    expect(account.convs).toHaveLength(1);
    expect(account.sent.find((s) => !s.private)?.content).toContain(
      "Recebemos seu pedido.",
    );
    const thread = await suDb.detachedThread.findUniqueOrThrow({
      where: { threadId: r.threadId },
      select: { caseInstanceId: true, caseConversationId: true },
    });
    expect(Number(thread.caseInstanceId)).toBe(INSTANCE);
    expect(thread.caseConversationId).toBe(900);
  });

  test("the thread adds to its case while the email holds, and opens a new one once it changed", async () => {
    const account = teamAccount();
    const first = await turn(agentCase, escalatingModel(), account, {
      email: "ana@exemplo.com",
    });
    const recorded = await suDb.detachedThread.findUniqueOrThrow({
      where: { threadId: first.threadId },
      select: { caseEmail: true },
    });
    expect(recorded.caseEmail).toBe("ana@exemplo.com");
    await turn(
      agentCase,
      escalatingModel(),
      account,
      { email: "ana@exemplo.com" },
      first.threadId,
    );
    expect(account.convs).toHaveLength(1);
    // The contact already carries the new address (a call that changed it failed after the
    // write), so only the address recorded with the case says it changed.
    const row = account.book.rows[0];
    if (row) row.email = "ana.b@exemplo.com";
    await turn(
      agentCase,
      escalatingModel(),
      account,
      { email: "ana.b@exemplo.com" },
      first.threadId,
    );
    expect(account.convs).toHaveLength(2);
  });

  test("a thread adds only to the case it opened: another thread's open case is left alone", async () => {
    const account = teamAccount();
    await turn(agentCase, escalatingModel(), account, {
      email: "bia@exemplo.com",
    });
    expect(account.convs).toHaveLength(1);
    await turn(agentCase, escalatingModel(), account, {
      email: "bia@exemplo.com",
    });
    expect(account.convs).toHaveLength(2);
  });

  test("the email the host states is refreshed on the person, and an omitted one is not cleared", async () => {
    await turn(agentCase, escalatingModel(), teamAccount(), {
      email: "ana.nova@exemplo.com",
    });
    await turn(agentCase, escalatingModel(), teamAccount(), {});
    const person = await suDb.externalUser.findFirstOrThrow({
      where: { tenantId, externalId: "u-1" },
      select: { email: true },
    });
    expect(person.email).toBe("ana.nova@exemplo.com");
  });

  test("an opening the output policy refuses is not sent, and the case still opens", async () => {
    const account = teamAccount();
    const r = await turn(
      agentGuarded,
      escalatingModel({ openingViolates: true }),
      account,
      { email: "ana@exemplo.com" },
    );
    expect(r.status).toBe("done");
    expect(account.convs).toHaveLength(1);
    expect(account.sent.filter((x) => !x.private)).toEqual([]);
  });

  test("two people's escalations in one account share one queue: they can resolve to one contact", async () => {
    const loaded = await loadDetachedConfig({
      ctx,
      agentId: agentCase,
      threadId: "x",
      base: appDb,
    });
    const people = await Promise.all(
      ["q-1", "q-2"].map((externalId) =>
        suDb.externalUser.create({
          data: { tenantId, channel: "client", externalId },
          select: { id: true },
        }),
      ),
    );
    const keys = await Promise.all(
      people.map(async (p) => {
        const d = await detachedCaseFor({
          ctx,
          base: appDb,
          loaded,
          threadId: `t-${p.id}`,
          externalUserId: p.id,
          turnId: "t",
          loadClient: async () => teamAccount().client,
        });
        return d?.serialKey;
      }),
    );
    expect(keys[0]).toBeDefined();
    expect(keys[0]).toBe(keys[1]);
  });

  test("an anonymous visitor's case goes to the address they typed, on a contact of their own, marked unverified", async () => {
    const m = escalatingModel({ email: "visita@exemplo.com" });
    const account = teamAccount();
    const r = await turn(
      agentCase,
      m,
      account,
      { id: "anon:1:AAAAAAAAAAAAAAAAAAAAAA" },
      undefined,
      "quero falar com alguém, meu e-mail é visita@exemplo.com",
    );
    const thread = await suDb.detachedThread.findUniqueOrThrow({
      where: { threadId: r.threadId },
      select: { caseEmail: true },
    });
    expect({
      offersEmail: m.caseArgs[0]?.includes("email"),
      contacts: account.book.rows.map((c) => c.email),
      marked: account.book.marked.map(([, a]) => a),
      cases: account.convs.length,
      opening: account.sent.find((x) => !x.private)?.to,
      unverifiedNote: account.sent.some(
        (x) =>
          x.private &&
          x.content.includes("visita@exemplo.com") &&
          x.content.includes("not verified"),
      ),
      caseEmail: thread.caseEmail,
    }).toEqual({
      offersEmail: true,
      contacts: ["visita@exemplo.com"],
      marked: [{ [UNVERIFIED_EMAIL_ATTRIBUTE]: true }],
      cases: 1,
      opening: "visita@exemplo.com",
      unverifiedNote: true,
      caseEmail: "visita@exemplo.com",
    });
  });

  test("an anonymous visitor's address the model made up, or none at all, opens nothing", async () => {
    const invented = escalatingModel({ email: "inventado@exemplo.com" });
    const account = teamAccount();
    await turn(
      agentCase,
      invented,
      account,
      { id: "anon:1:BBBBBBBBBBBBBBBBBBBBBB" },
      undefined,
      "quero falar com alguém",
    );
    const none = escalatingModel();
    await turn(
      agentCase,
      none,
      account,
      { id: "anon:1:CCCCCCCCCCCCCCCCCCCCCC" },
      undefined,
      "quero falar com alguém",
    );
    expect({
      contacts: account.book.rows.length,
      cases: account.convs.length,
      invented: invented.answers[0]?.includes("did not write that address"),
      none: none.answers[0]?.includes("Ask the user for the email address"),
    }).toEqual({ contacts: 0, cases: 0, invented: true, none: true });
  });

  test("an address someone the team knows holds is refused to an anonymous visitor", async () => {
    const m = escalatingModel({ email: "cliente@exemplo.com" });
    const account = teamAccount();
    account.book.rows.push({
      id: 77,
      email: "cliente@exemplo.com",
      identifier: null,
    });
    await turn(
      agentCase,
      m,
      account,
      { id: "anon:1:DDDDDDDDDDDDDDDDDDDDDD" },
      undefined,
      "sou eu, cliente@exemplo.com, quero falar com alguém",
    );
    expect({
      cases: account.convs.length,
      answer: m.answers[0]?.includes("sign in"),
    }).toEqual({ cases: 0, answer: true });
  });

  test("a signed-in user's case takes no address from the model", async () => {
    const m = escalatingModel({ email: "outro@exemplo.com" });
    const account = teamAccount();
    await turn(agentCase, m, account, { email: "ana@exemplo.com" });
    expect({
      offersEmail: m.caseArgs[0]?.includes("email"),
      opening: account.sent.find((x) => !x.private)?.to,
      unverifiedNote: account.sent.some((x) =>
        x.content.includes("not verified"),
      ),
    }).toEqual({
      offersEmail: false,
      opening: "ana@exemplo.com",
      unverifiedNote: false,
    });
  });

  test("an agent with no destination inbox is not offered the tool", async () => {
    const m = escalatingModel();
    await turn(agentPlain, m, teamAccount(), {}).catch(() => undefined);
    expect(m.offered.flat()).not.toContain("open_case_in_inbox");
  });
});
