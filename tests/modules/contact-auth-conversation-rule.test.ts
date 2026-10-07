import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { agentUpdateAudit } from "@/modules/agents/audit-projection";
import { assertSettingsContactAuthRule } from "@/modules/agents/service";
import { contactAuthNoteText } from "@/modules/chatwoot/webhook";
import {
  evaluateContactAuthRule,
  RULE_CONVERSATION_TYPE,
  RULE_LABEL,
  RULE_NONE_MET,
  type RuleFacts,
  ruleReadsConversation,
} from "@/modules/contact-auth/rule";
import {
  authorizeContact,
  RULE_NOT_LISTED,
  RULE_UNMET,
} from "@/modules/contact-auth/service";
import {
  CONTACT_AUTH_ALLOWLIST_MAX,
  CONTACT_AUTH_DEFAULTS,
  CONTACT_AUTH_RULE_CONDITIONS_MAX,
  type ContactAuthConfig,
  type ContactAuthRule,
  parseContactAuthRule,
} from "@/modules/contact-auth/settings";
import { clearContactAuthState } from "@/modules/contact-auth/state";
import { seedChatwootInstance } from "../utils/chatwoot";

// ── WHICH CONVERSATIONS AN AGENT ACTS ON ──
//
// The gate's local rule could only read the contact (a list, an attribute). The conversation type and
// the labels are what an operator reaches for when an agent should act on part of an inbox: only the
// WhatsApp groups, only conversations carrying a label. Both come from the mirror, so the endpoint is
// still never asked, and conditions combine under `all` / `any`.

describe("parsing the new conditions", () => {
  test("a conversation type is group or individual, nothing else", () => {
    expect(
      parseContactAuthRule({ kind: "conversation_type", type: "group" }),
    ).toEqual({ kind: "conversation_type", type: "group" });
    expect(
      parseContactAuthRule({ kind: "conversation_type", type: "individual" }),
    ).toEqual({ kind: "conversation_type", type: "individual" });
    for (const type of ["Group", "groups", "", null, 1, undefined]) {
      expect(
        parseContactAuthRule({ kind: "conversation_type", type }),
      ).toBeNull();
    }
  });

  test("a label is trimmed and lowercased, as Chatwoot stores it", () => {
    expect(parseContactAuthRule({ kind: "label", label: "  VIP " })).toEqual({
      kind: "label",
      label: "vip",
    });
    for (const label of ["", "   ", null, 42, "x".repeat(256), "a\nb"]) {
      expect(parseContactAuthRule({ kind: "label", label })).toBeNull();
    }
  });

  test("all / any hold a list of plain conditions", () => {
    expect(
      parseContactAuthRule({
        kind: "all",
        conditions: [
          { kind: "conversation_type", type: "group" },
          { kind: "label", label: "Suporte" },
          { kind: "attribute", scope: "contact", key: "plano" },
          { kind: "allowlist", phones: ["+55 11 98888-7777"] },
        ],
      }),
    ).toEqual({
      kind: "all",
      conditions: [
        { kind: "conversation_type", type: "group" },
        { kind: "label", label: "suporte" },
        { kind: "attribute", scope: "contact", key: "plano" },
        { kind: "allowlist", phones: ["5511988887777"], identifiers: [] },
      ],
    });
    expect(
      parseContactAuthRule({
        kind: "any",
        conditions: [{ kind: "label", label: "a" }],
      }),
    ).toEqual({ kind: "any", conditions: [{ kind: "label", label: "a" }] });
  });

  test("one bad condition refuses the whole combination", () => {
    const good = { kind: "label", label: "a" };
    for (const bad of [
      { kind: "label", label: "" },
      { kind: "conversation_type", type: "channel" },
      { kind: "allowlist", phones: [] },
      { kind: "nope" },
      null,
      "label",
    ]) {
      expect(
        parseContactAuthRule({ kind: "all", conditions: [good, bad] }),
      ).toBeNull();
    }
  });

  test("the combination is bounded: not empty, not nested, not oversized", () => {
    expect(parseContactAuthRule({ kind: "all", conditions: [] })).toBeNull();
    expect(parseContactAuthRule({ kind: "any" })).toBeNull();
    expect(
      parseContactAuthRule({ kind: "any", conditions: { kind: "label" } }),
    ).toBeNull();
    // One level only: a combination inside a combination is refused, not flattened.
    expect(
      parseContactAuthRule({
        kind: "all",
        conditions: [
          { kind: "any", conditions: [{ kind: "label", label: "a" }] },
        ],
      }),
    ).toBeNull();
    const label = (i: number) => ({ kind: "label", label: `l${i}` });
    const max = Array.from(
      { length: CONTACT_AUTH_RULE_CONDITIONS_MAX },
      (_, i) => label(i),
    );
    expect(parseContactAuthRule({ kind: "any", conditions: max })).not.toBe(
      null,
    );
    expect(
      parseContactAuthRule({
        kind: "any",
        conditions: [...max, label(CONTACT_AUTH_RULE_CONDITIONS_MAX)],
      }),
    ).toBeNull();
  });

  test("the list cap counts every list in the rule together", () => {
    const ids = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => `id-${from + i}`);
    const half = CONTACT_AUTH_ALLOWLIST_MAX / 2;
    expect(
      parseContactAuthRule({
        kind: "any",
        conditions: [
          { kind: "allowlist", identifiers: ids(0, half) },
          { kind: "allowlist", identifiers: ids(half, half) },
        ],
      }),
    ).not.toBeNull();
    expect(
      parseContactAuthRule({
        kind: "any",
        conditions: [
          { kind: "allowlist", identifiers: ids(0, half) },
          { kind: "allowlist", identifiers: ids(half, half + 1) },
        ],
      }),
    ).toBeNull();
  });

  test("the write boundary refuses what the reader would drop", () => {
    expect(() =>
      assertSettingsContactAuthRule(
        { contactAuth: { rule: { kind: "all", conditions: [] } } },
        {},
      ),
    ).toThrow("contactAuth.rule");
    assertSettingsContactAuthRule(
      {
        contactAuth: {
          rule: {
            kind: "all",
            conditions: [
              { kind: "conversation_type", type: "group" },
              { kind: "label", label: "triagem" },
            ],
          },
        },
      },
      {},
    );
  });
});

describe("which rules read the conversation", () => {
  test("the conversation's own facts, alone or inside a combination", () => {
    const yes: unknown[] = [
      { kind: "conversation_type", type: "group" },
      { kind: "label", label: "a" },
      { kind: "attribute", scope: "conversation", key: "k" },
      {
        kind: "any",
        conditions: [
          { kind: "allowlist", identifiers: ["x"] },
          { kind: "label", label: "a" },
        ],
      },
    ];
    const no: unknown[] = [
      { kind: "allowlist", identifiers: ["x"] },
      { kind: "attribute", scope: "contact", key: "k" },
      {
        kind: "all",
        conditions: [
          { kind: "allowlist", identifiers: ["x"] },
          { kind: "attribute", scope: "contact", key: "k" },
        ],
      },
    ];
    for (const r of yes) {
      expect(
        ruleReadsConversation(parseContactAuthRule(r) as ContactAuthRule),
      ).toBe(true);
    }
    for (const r of no) {
      expect(
        ruleReadsConversation(parseContactAuthRule(r) as ContactAuthRule),
      ).toBe(false);
    }
  });
});

function facts(over: Partial<RuleFacts> = {}): RuleFacts {
  return {
    phone: null,
    identifier: null,
    conversationType: null,
    labels: [],
    conversationAttributes: {},
    contactAttributes: {},
    ...over,
  };
}

function rule(raw: unknown): ContactAuthRule {
  const r = parseContactAuthRule(raw);
  if (!r) throw new Error(`fixture rule did not parse: ${JSON.stringify(raw)}`);
  return r;
}

describe("the decision table", () => {
  const GROUP = rule({ kind: "conversation_type", type: "group" });
  const INDIVIDUAL = rule({ kind: "conversation_type", type: "individual" });

  test("the conversation type comes from the mirror, then from the @g.us identifier", () => {
    expect(
      evaluateContactAuthRule(GROUP, facts({ conversationType: "group" })),
    ).toEqual({ outcome: "allowed" });
    expect(
      evaluateContactAuthRule(GROUP, facts({ conversationType: "individual" })),
    ).toEqual({ outcome: "denied", reason: RULE_CONVERSATION_TYPE });
    // The mirror never heard about the type: the group contact's identifier still tells.
    expect(
      evaluateContactAuthRule(
        GROUP,
        facts({ identifier: "120363000000000000@g.us" }),
      ),
    ).toEqual({ outcome: "allowed" });
    expect(
      evaluateContactAuthRule(
        INDIVIDUAL,
        facts({ identifier: "120363000000000000@g.us" }),
      ),
    ).toEqual({ outcome: "denied", reason: RULE_CONVERSATION_TYPE });
    expect(
      evaluateContactAuthRule(INDIVIDUAL, facts({ identifier: "cli-42" })),
    ).toEqual({ outcome: "allowed" });
    // A stated type wins over the identifier.
    expect(
      evaluateContactAuthRule(
        INDIVIDUAL,
        facts({
          conversationType: "individual",
          identifier: "120363000000000000@g.us",
        }),
      ),
    ).toEqual({ outcome: "allowed" });
    // A suffix is the whole rule: something merely containing it is not a group.
    expect(
      evaluateContactAuthRule(GROUP, facts({ identifier: "x@g.us.example" })),
    ).toEqual({ outcome: "denied", reason: RULE_CONVERSATION_TYPE });
  });

  test("a label matches case-insensitively, and only a label the conversation carries", () => {
    const VIP = rule({ kind: "label", label: "VIP" });
    expect(evaluateContactAuthRule(VIP, facts({ labels: ["vip"] }))).toEqual({
      outcome: "allowed",
    });
    expect(
      evaluateContactAuthRule(VIP, facts({ labels: ["Vip", "x"] })),
    ).toEqual({ outcome: "allowed" });
    expect(
      evaluateContactAuthRule(VIP, facts({ labels: ["vip-2", "vi"] })),
    ).toEqual({ outcome: "denied", reason: RULE_LABEL });
    expect(evaluateContactAuthRule(VIP, facts())).toEqual({
      outcome: "denied",
      reason: RULE_LABEL,
    });
  });

  test("all needs every condition and names the first that failed", () => {
    const r = rule({
      kind: "all",
      conditions: [
        { kind: "conversation_type", type: "group" },
        { kind: "label", label: "suporte" },
      ],
    });
    expect(
      evaluateContactAuthRule(
        r,
        facts({ conversationType: "group", labels: ["suporte"] }),
      ),
    ).toEqual({ outcome: "allowed" });
    expect(
      evaluateContactAuthRule(r, facts({ conversationType: "group" })),
    ).toEqual({ outcome: "denied", reason: RULE_LABEL });
    expect(
      evaluateContactAuthRule(
        r,
        facts({ conversationType: "individual", labels: ["suporte"] }),
      ),
    ).toEqual({ outcome: "denied", reason: RULE_CONVERSATION_TYPE });
  });

  test("any needs one condition", () => {
    const r = rule({
      kind: "any",
      conditions: [
        { kind: "label", label: "a" },
        { kind: "allowlist", phones: ["+5511988887777"] },
        { kind: "attribute", scope: "contact", key: "plano", equals: "ativo" },
      ],
    });
    expect(evaluateContactAuthRule(r, facts({ labels: ["a"] }))).toEqual({
      outcome: "allowed",
    });
    expect(
      evaluateContactAuthRule(r, facts({ phone: "+55 11 98888-7777" })),
    ).toEqual({ outcome: "allowed" });
    expect(
      evaluateContactAuthRule(
        r,
        facts({ contactAttributes: { plano: "ativo" } }),
      ),
    ).toEqual({ outcome: "allowed" });
    expect(
      evaluateContactAuthRule(
        r,
        facts({ labels: ["b"], contactAttributes: { plano: "x" } }),
      ),
    ).toEqual({ outcome: "denied", reason: RULE_NONE_MET });
  });

  test("the two existing kinds keep their codes", () => {
    expect(
      evaluateContactAuthRule(
        rule({ kind: "allowlist", identifiers: ["cli-42"] }),
        facts({ identifier: "cli-43" }),
      ),
    ).toEqual({ outcome: "denied", reason: RULE_NOT_LISTED });
    expect(
      evaluateContactAuthRule(
        rule({ kind: "attribute", scope: "conversation", key: "k" }),
        facts(),
      ),
    ).toEqual({ outcome: "denied", reason: RULE_UNMET });
  });
});

describe("the operator note names what failed", () => {
  test("type, label and none of the conditions", () => {
    const type = contactAuthNoteText(
      { outcome: "denied", reason: RULE_CONVERSATION_TYPE },
      true,
    );
    expect(type).toContain("regra do agente");
    expect(type).toContain("tipo de conversa");
    expect(type).not.toContain("verificação externa");
    expect(
      contactAuthNoteText({ outcome: "denied", reason: RULE_LABEL }, false),
    ).toContain("etiqueta");
    expect(
      contactAuthNoteText({ outcome: "denied", reason: RULE_NONE_MET }, false),
    ).toContain("nenhuma das condições");
  });
});

describe("the audit trail", () => {
  // A list inside a combination is still a list of people, and the trail is append-only.
  test("a list inside a combination is recorded by shape, never by entries", () => {
    const row = (phones: string[]) => ({
      settings: {
        contactAuth: {
          enabled: true,
          rule: {
            kind: "any",
            conditions: [
              { kind: "label", label: "vip" },
              { kind: "allowlist", phones, identifiers: ["cli-42"] },
            ],
          },
        },
      },
    });
    const audit = agentUpdateAudit(
      row(["+5511988887777"]),
      row(["+5511977776666"]),
    );
    const text = JSON.stringify(audit);
    expect(text).not.toContain("988887777");
    expect(text).not.toContain("977776666");
    expect(text).not.toContain("cli-42");
    expect(text).toContain('"label":"vip"');
    if (!audit) throw new Error("expected an audit row");
    const after = (audit.after as Record<string, Record<string, unknown>>)
      .contactAuth;
    expect(after?.rule).toEqual({
      kind: "any",
      conditions: [
        { kind: "label", label: "vip" },
        {
          kind: "allowlist",
          phones: 1,
          identifiers: 1,
          entriesChanged: true,
        },
      ],
    });
  });
});

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
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantId = 0n;
let instanceId = 0n;
let agentId = 0n;
let groupContact = 0n;
let personContact = 0n;
let bareContact = 0n;
let groupConv = 0n;
let legacyGroupConv = 0n;
let personConv = 0n;
let labelledConv = 0n;

function endpoint() {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response('{"authorized":true}', { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function cfg(raw: unknown): ContactAuthConfig {
  return {
    ...CONTACT_AUTH_DEFAULTS,
    enabled: true,
    url: "https://203.0.113.9:9443/check",
    rule: rule(raw),
  };
}

let seq = 0;
async function ask(
  config: ContactAuthConfig,
  contact: bigint,
  conversationDbId: bigint | null,
  fetchImpl: typeof fetch,
  requestKey?: string,
) {
  seq += 1;
  return authorizeContact({
    tenantId,
    agentId,
    contactDbId: contact,
    conversationDbId,
    conversationId: 7860,
    inboxId: 86,
    channelType: "Channel::Whatsapp",
    messageText: null,
    requestKey: requestKey ?? `conv-rule:${seq}`,
    cfg: config,
    base: appDb,
    fetchImpl,
  });
}

describe.skipIf(!dbUp)(
  "the gate reads the conversation's type and labels",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "CAR-CONV", slug: `car-conv-${process.pid}` },
      });
      tenantId = t.id;
      instanceId = (
        await seedChatwootInstance(suDb, {
          tenantId,
          accountId: 86,
          baseUrl: "https://203.0.113.86:9",
        })
      ).id;
      agentId = (
        await suDb.agent.create({
          data: {
            tenantId,
            name: "Escopo",
            systemPrompt: "x",
            modelConfig: { provider: "openai", model: "gpt-4o-mini" },
          },
        })
      ).id;
      let cw = 8600;
      const contact = async (data: Record<string, unknown>) =>
        (
          await suDb.contact.create({
            data: {
              tenantId,
              chatwootInstanceId: instanceId,
              chatwootContactId: cw++,
              ...data,
            },
          })
        ).id;
      // A group contact has no phone and no email: the identity gate would call it `no_identity`.
      groupContact = await contact({
        name: "Cliente + fazer.ai",
        attributes: { identifier: "120363000000000001@g.us" },
      });
      personContact = await contact({ phone: "+5511988887777" });
      bareContact = await contact({});
      let id = 7861;
      const conv = async (data: Record<string, unknown>) =>
        (
          await suDb.conversation.create({
            data: {
              tenantId,
              chatwootInstanceId: instanceId,
              chatwootConversationId: id,
              status: "pending",
              threadId: `${tenantId}:${instanceId}:${id++}`,
              ...data,
            },
          })
        ).id;
      groupConv = await conv({
        contactId: groupContact,
        conversationType: "group",
        labels: ["suporte"],
      });
      legacyGroupConv = await conv({ contactId: groupContact });
      personConv = await conv({
        contactId: personContact,
        conversationType: "individual",
        labels: ["vip"],
      });
      labelledConv = await conv({ contactId: bareContact, labels: ["vip"] });
    });

    afterAll(async () => {
      if (!dbUp) return;
      clearContactAuthState();
      await suDb.contactAuthGrant.deleteMany({ where: { tenantId } });
      await suDb.conversation.deleteMany({ where: { tenantId } });
      await suDb.contact.deleteMany({ where: { tenantId } });
      await suDb.agent.deleteMany({ where: { tenantId } });
      await suDb.chatwootInstance.deleteMany({ where: { tenantId } });
      await suDb.tenant.delete({ where: { id: tenantId } });
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    test("a group conversation is served with no contact identity, and the endpoint is never asked", async () => {
      const ep = endpoint();
      const GROUP = cfg({ kind: "conversation_type", type: "group" });
      const g = await ask(GROUP, groupContact, groupConv, ep.fetchImpl);
      expect(g.outcome).toBe("allowed");
      const legacy = await ask(
        GROUP,
        groupContact,
        legacyGroupConv,
        ep.fetchImpl,
      );
      expect(legacy.outcome).toBe("allowed");
      const p = await ask(GROUP, personContact, personConv, ep.fetchImpl);
      expect(p.outcome).toBe("denied");
      expect(p.reason).toBe(RULE_CONVERSATION_TYPE);
      expect(ep.calls.length).toBe(0);
    });

    test("a label is read from the conversation row", async () => {
      const ep = endpoint();
      const VIP = cfg({ kind: "label", label: "vip" });
      expect(
        (await ask(VIP, bareContact, labelledConv, ep.fetchImpl)).outcome,
      ).toBe("allowed");
      const g = await ask(VIP, groupContact, groupConv, ep.fetchImpl);
      expect(g.outcome).toBe("denied");
      expect(g.reason).toBe(RULE_LABEL);
      // A caller with no conversation row reads no labels and refuses.
      expect((await ask(VIP, bareContact, null, ep.fetchImpl)).outcome).toBe(
        "denied",
      );
      expect(ep.calls.length).toBe(0);
    });

    test("all and any decide over the same row", async () => {
      const ep = endpoint();
      const both = cfg({
        kind: "all",
        conditions: [
          { kind: "conversation_type", type: "group" },
          { kind: "label", label: "suporte" },
        ],
      });
      expect(
        (await ask(both, groupContact, groupConv, ep.fetchImpl)).outcome,
      ).toBe("allowed");
      const legacy = await ask(
        both,
        groupContact,
        legacyGroupConv,
        ep.fetchImpl,
      );
      expect(legacy.outcome).toBe("denied");
      expect(legacy.reason).toBe(RULE_LABEL);
      const either = cfg({
        kind: "any",
        conditions: [
          { kind: "label", label: "vip" },
          { kind: "allowlist", phones: ["+5511999990000"] },
        ],
      });
      expect(
        (await ask(either, personContact, personConv, ep.fetchImpl)).outcome,
      ).toBe("allowed");
      const none = await ask(either, groupContact, groupConv, ep.fetchImpl);
      expect(none.outcome).toBe("denied");
      expect(none.reason).toBe(RULE_NONE_MET);
      expect(ep.calls.length).toBe(0);
    });

    test("two conversations of one contact asking at once do not share a verdict", async () => {
      // Same contact, same request key, two conversations: one labelled, one not. A flight keyed by the
      // contact alone would hand the first answer to the second.
      const VIP = cfg({ kind: "label", label: "suporte" });
      const ep = endpoint();
      const [a, b] = await Promise.all([
        ask(VIP, groupContact, groupConv, ep.fetchImpl, "inbox"),
        ask(VIP, groupContact, legacyGroupConv, ep.fetchImpl, "inbox"),
      ]);
      expect(a.outcome).toBe("allowed");
      expect(b.outcome).toBe("denied");
    });

    test("a local condition never stores a grant", async () => {
      const ep = endpoint();
      const once = {
        ...cfg({ kind: "conversation_type", type: "group" }),
        mode: "once" as const,
      };
      const r = await ask(once, groupContact, groupConv, ep.fetchImpl);
      expect(r.outcome).toBe("allowed");
      expect(await suDb.contactAuthGrant.count({ where: { tenantId } })).toBe(
        0,
      );
      // Control: the same contact through the endpoint under `once` does store one, so the zero above
      // is about the rule and not about a table this connection cannot see.
      const viaEndpoint = { ...once, rule: null };
      expect(
        (await ask(viaEndpoint, groupContact, groupConv, ep.fetchImpl)).outcome,
      ).toBe("allowed");
      expect(ep.calls.length).toBe(1);
      expect(await suDb.contactAuthGrant.count({ where: { tenantId } })).toBe(
        1,
      );
    });
  },
);
