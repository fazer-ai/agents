import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { assertSettingsContactAuthRule } from "@/modules/agents/service";
import { contactAuthNoteText } from "@/modules/chatwoot/webhook";
import {
  contactAuthIdentityHash,
  contactAuthPolicyHash,
} from "@/modules/contact-auth/grants";
import {
  authorizeContact,
  contactAuthFlowEvent,
  RULE_NOT_LISTED,
  RULE_UNMET,
} from "@/modules/contact-auth/service";
import {
  CONTACT_AUTH_ALLOWLIST_MAX,
  CONTACT_AUTH_DEFAULTS,
  type ContactAuthConfig,
  type ContactAuthRule,
  parseContactAuthRule,
  readContactAuthConfig,
} from "@/modules/contact-auth/settings";
import { clearContactAuthState } from "@/modules/contact-auth/state";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { agentSettingsGet, agentSettingsSet } from "@/modules/mcp/write";
import { seedChatwootInstance } from "../utils/chatwoot";

// ── A VERDICT FROM DATA WE ALREADY HOLD (issue #646) ──
//
// The gate had one way to decide: POST the identity to an operator-hosted endpoint. For a pilot list
// of five numbers, or "serve the contacts whose plan is active", that endpoint is an availability
// dependency with nothing to add. A local rule decides from the mirror instead, under the same
// fail-closed contract, and with it the endpoint is never asked. The endpoint double below counts
// its own calls, so "never asked" is a number.

describe("parsing a rule", () => {
  test("an allowlist keeps phones as digits and identifiers as typed, deduplicated", () => {
    expect(
      parseContactAuthRule({
        kind: "allowlist",
        phones: ["+55 (11) 98888-7777", "5511988887777", "+1 415 555 0100"],
        identifiers: [" cli-42 ", "cli-42"],
      }),
    ).toEqual({
      kind: "allowlist",
      phones: ["5511988887777", "14155550100"],
      identifiers: ["cli-42"],
    });
  });

  test("one bad entry refuses the whole rule rather than shrinking it", () => {
    // A list that "sort of" parses would read as a gate the operator did not write.
    for (const phones of [["1234567"], ["1234567890123456"], [42], ["  "]]) {
      expect(parseContactAuthRule({ kind: "allowlist", phones })).toBeNull();
    }
    expect(
      parseContactAuthRule({
        kind: "allowlist",
        identifiers: ["x".repeat(201)],
      }),
    ).toBeNull();
    // A valid entry beside the bad one does not rescue the list.
    expect(
      parseContactAuthRule({
        kind: "allowlist",
        phones: ["+5511988887777", "123"],
      }),
    ).toBeNull();
    // Nor does a valid other half rescue a half that is not a list.
    expect(
      parseContactAuthRule({
        kind: "allowlist",
        phones: "5511988887777",
        identifiers: ["cli-42"],
      }),
    ).toBeNull();
  });

  test("an empty list and an oversized list are refused", () => {
    expect(
      parseContactAuthRule({ kind: "allowlist", phones: [], identifiers: [] }),
    ).toBeNull();
    const many = Array.from(
      { length: CONTACT_AUTH_ALLOWLIST_MAX + 1 },
      (_, i) => `id-${i}`,
    );
    expect(
      parseContactAuthRule({ kind: "allowlist", identifiers: many }),
    ).toBeNull();
    expect(
      parseContactAuthRule({
        kind: "allowlist",
        identifiers: many.slice(0, CONTACT_AUTH_ALLOWLIST_MAX),
      }),
    ).not.toBeNull();
  });

  test("an attribute rule is the tool precondition's own shape", () => {
    expect(
      parseContactAuthRule({
        kind: "attribute",
        scope: "contact",
        key: "plano",
        equals: "ativo",
      }),
    ).toEqual({
      kind: "attribute",
      scope: "contact",
      key: "plano",
      equals: "ativo",
    });
    expect(
      parseContactAuthRule({ kind: "attribute", scope: "lead", key: "x" }),
    ).toBeNull();
    expect(parseContactAuthRule({ kind: "label", label: "vip" })).toBeNull();
  });

  test("the config reader carries the rule, and a bad one reads as none", () => {
    const rule = { kind: "allowlist", phones: ["+5511988887777"] };
    expect(
      readContactAuthConfig({ contactAuth: { enabled: true, rule } }).rule,
    ).toEqual({
      kind: "allowlist",
      phones: ["5511988887777"],
      identifiers: [],
    });
    expect(
      readContactAuthConfig({
        contactAuth: { enabled: true, rule: { kind: "allowlist" } },
      }).rule,
    ).toBeNull();
    expect(readContactAuthConfig({}).rule).toBeNull();
  });
});

describe("the write boundary", () => {
  test("a malformed rule is refused, a valid one and null are not", () => {
    expect(() =>
      assertSettingsContactAuthRule(
        { contactAuth: { rule: { kind: "allowlist", phones: [] } } },
        {},
      ),
    ).toThrow("contactAuth.rule");
    expect(() =>
      assertSettingsContactAuthRule(
        { contactAuth: { rule: { kind: "label", label: "vip" } } },
        {},
      ),
    ).toThrow("contactAuth.rule");
    assertSettingsContactAuthRule(
      { contactAuth: { rule: { kind: "allowlist", identifiers: ["a"] } } },
      {},
    );
    assertSettingsContactAuthRule({ contactAuth: { rule: null } }, {});
    assertSettingsContactAuthRule({ contactAuth: { enabled: true } }, {});
  });

  test("an unchanged bad rule stored some other way does not block an unrelated write", () => {
    const stored = { contactAuth: { rule: { kind: "allowlist", phones: [] } } };
    assertSettingsContactAuthRule(stored, stored);
  });
});

describe("the operator note names the rule, not an external check", () => {
  test("not listed", () => {
    const note = contactAuthNoteText(
      { outcome: "denied", reason: RULE_NOT_LISTED },
      true,
      "sent",
    );
    expect(note).toContain("regra do agente");
    expect(note).toContain("não estão na lista");
    expect(note).not.toContain("verificação externa");
    expect(note).toContain("aberta para atendimento humano");
  });

  test("attribute unmet", () => {
    const note = contactAuthNoteText(
      { outcome: "denied", reason: RULE_UNMET },
      false,
      "none",
    );
    expect(note).toContain("atributo exigido");
    expect(note).toContain("Nenhum aviso foi enviado");
  });

  test("an endpoint refusal still reads as the external check", () => {
    expect(
      contactAuthNoteText(
        { outcome: "denied", endpointReason: "inadimplente" },
        false,
      ),
    ).toContain("verificação externa");
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

const AUTH_URL = "https://203.0.113.9:9443/check";

let tenantId = 0n;
let instanceId = 0n;
let agentId = 0n;
let listedContact = 0n;
let neighbourContact = 0n;
let noCountryContact = 0n;
let identifiedContact = 0n;
let emailOnlyContact = 0n;
let bareContact = 0n;
let markedConversation = 0n;
let unmarkedConversation = 0n;

// Allows everybody and counts, so every "the endpoint was not asked" below is a zero.
function endpoint() {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response('{"authorized":true}', { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function cfg(
  rule: ContactAuthRule | null,
  over: Partial<ContactAuthConfig> = {},
): ContactAuthConfig {
  return {
    ...CONTACT_AUTH_DEFAULTS,
    enabled: true,
    url: AUTH_URL,
    rule,
    ...over,
  };
}

let seq = 0;
async function ask(
  config: ContactAuthConfig,
  contact: bigint,
  fetchImpl: typeof fetch,
  conversationDbId: bigint | null = null,
) {
  seq += 1;
  return authorizeContact({
    tenantId,
    agentId,
    contactDbId: contact,
    conversationDbId,
    conversationId: 6460,
    inboxId: 64,
    channelType: "Channel::Whatsapp",
    messageText: null,
    requestKey: `rule:${seq}`,
    cfg: config,
    base: appDb,
    fetchImpl,
  });
}

const LIST = parseContactAuthRule({
  kind: "allowlist",
  phones: ["+55 (11) 98888-7777"],
  identifiers: ["cli-42"],
}) as ContactAuthRule;

describe.skipIf(!dbUp)("a local rule decides without the endpoint", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "CAR", slug: `car-${process.pid}` },
    });
    tenantId = t.id;
    instanceId = (
      await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 64,
        baseUrl: "https://203.0.113.64:9",
      })
    ).id;
    agentId = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Porteira",
          systemPrompt: "x",
          modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        },
      })
    ).id;
    let cw = 6400;
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
    listedContact = await contact({
      phone: "+5511988887777",
      customAttributes: { plano: "ativo" },
    });
    neighbourContact = await contact({
      phone: "+5511988887778",
      customAttributes: { plano: "cancelado" },
    });
    noCountryContact = await contact({ phone: "11988887777" });
    identifiedContact = await contact({ attributes: { identifier: "cli-42" } });
    emailOnlyContact = await contact({ email: "a@example.com" });
    bareContact = await contact({});
    const conv = async (id: number, attrs: Record<string, string>) =>
      (
        await suDb.conversation.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: id,
            status: "pending",
            threadId: `${tenantId}:${instanceId}:${id}`,
            contactId: bareContact,
            customAttributes: attrs,
          },
        })
      ).id;
    markedConversation = await conv(6461, { liberado: "sim" });
    unmarkedConversation = await conv(6462, {});
  });

  afterAll(async () => {
    if (!dbUp) return;
    clearContactAuthState();
    await suDb.contactAuthGrant.deleteMany({ where: { tenantId } });
    await suDb.conversation.deleteMany({ where: { tenantId } });
    await suDb.contact.deleteMany({ where: { tenantId } });
    await suDb.auditLog.deleteMany({ where: { tenantId } });
    await suDb.agent.deleteMany({ where: { tenantId } });
    await suDb.chatwootInstance.deleteMany({ where: { tenantId } });
    await suDb.tenant.delete({ where: { id: tenantId } });
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("a listed phone is served, compared by digits, and the endpoint is never asked", async () => {
    const ep = endpoint();
    const r = await ask(cfg(LIST), listedContact, ep.fetchImpl);
    expect(r.outcome).toBe("allowed");
    expect(ep.calls).toHaveLength(0);
  });

  test("a neighbouring number and the same number without the country code are refused", async () => {
    const ep = endpoint();
    for (const c of [neighbourContact, noCountryContact]) {
      const r = await ask(cfg(LIST), c, ep.fetchImpl);
      expect(r.outcome).toBe("denied");
      expect(r.reason).toBe(RULE_NOT_LISTED);
    }
    // The endpoint would have said yes: the rule, not the url, decided.
    expect(ep.calls).toHaveLength(0);
  });

  test("a listed identifier is served", async () => {
    const ep = endpoint();
    expect(
      (await ask(cfg(LIST), identifiedContact, ep.fetchImpl)).outcome,
    ).toBe("allowed");
    expect(ep.calls).toHaveLength(0);
  });

  test("an email-only contact has nothing the list compares: refused, not asked", async () => {
    const ep = endpoint();
    const r = await ask(cfg(LIST), emailOnlyContact, ep.fetchImpl);
    expect(r).toMatchObject({ outcome: "denied", reason: RULE_NOT_LISTED });
    expect(ep.calls).toHaveLength(0);
  });

  test("a contact with no identity at all stays no_identity", async () => {
    const ep = endpoint();
    const r = await ask(cfg(LIST), bareContact, ep.fetchImpl);
    expect(r.outcome).toBe("no_identity");
    expect(ep.calls).toHaveLength(0);
  });

  test("a contact attribute equal to the value serves; a different one refuses", async () => {
    const ep = endpoint();
    const rule = parseContactAuthRule({
      kind: "attribute",
      scope: "contact",
      key: "plano",
      equals: "ativo",
    }) as ContactAuthRule;
    expect((await ask(cfg(rule), listedContact, ep.fetchImpl)).outcome).toBe(
      "allowed",
    );
    const r = await ask(cfg(rule), neighbourContact, ep.fetchImpl);
    expect(r).toMatchObject({ outcome: "denied", reason: RULE_UNMET });
    // Absent altogether.
    expect(
      (await ask(cfg(rule), identifiedContact, ep.fetchImpl)).outcome,
    ).toBe("denied");
    expect(ep.calls).toHaveLength(0);
  });

  test("a conversation attribute serves a contact with no identity at all", async () => {
    // The widget visitor on a conversation an operator marked: the case the attribute rule is for,
    // and the reason it is decided before the identity check.
    const ep = endpoint();
    const rule = parseContactAuthRule({
      kind: "attribute",
      scope: "conversation",
      key: "liberado",
    }) as ContactAuthRule;
    expect(
      (await ask(cfg(rule), bareContact, ep.fetchImpl, markedConversation))
        .outcome,
    ).toBe("allowed");
    expect(
      (await ask(cfg(rule), bareContact, ep.fetchImpl, unmarkedConversation))
        .outcome,
    ).toBe("denied");
    // No conversation row to read: an empty bag, which refuses.
    expect(
      (await ask(cfg(rule), bareContact, ep.fetchImpl, null)).outcome,
    ).toBe("denied");
    expect(ep.calls).toHaveLength(0);
  });

  test("under mode once, a rule neither reads nor writes a stored verdict", async () => {
    const ep = endpoint();
    // A grant the endpoint gave this contact earlier, under exactly this policy.
    const config = cfg(LIST, { mode: "once" });
    await suDb.contactAuthGrant.create({
      data: {
        tenantId,
        agentId,
        contactId: neighbourContact,
        // The hash the reuse path would match, so a read WOULD find it: the assertion below is
        // about the rule not reading, not about a grant that could never match.
        identityHash: contactAuthIdentityHash({
          phone: "+5511988887778",
          email: null,
          identifier: null,
        }),
        policyHash: contactAuthPolicyHash(config, null),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const refused = await ask(config, neighbourContact, ep.fetchImpl);
    expect(refused.outcome).toBe("denied");
    expect(refused.reused).toBeUndefined();
    const served = await ask(config, listedContact, ep.fetchImpl);
    expect(served.outcome).toBe("allowed");
    expect(
      await suDb.contactAuthGrant.count({
        where: { tenantId, contactId: listedContact },
      }),
    ).toBe(0);
    expect(ep.calls).toHaveLength(0);
  });

  test("taking a number off the list refuses its very next message", async () => {
    const ep = endpoint();
    expect((await ask(cfg(LIST), listedContact, ep.fetchImpl)).outcome).toBe(
      "allowed",
    );
    const shorter = parseContactAuthRule({
      kind: "allowlist",
      identifiers: ["cli-42"],
    }) as ContactAuthRule;
    expect((await ask(cfg(shorter), listedContact, ep.fetchImpl)).outcome).toBe(
      "denied",
    );
  });

  test("without a rule the endpoint answers as before", async () => {
    const ep = endpoint();
    expect((await ask(cfg(null), neighbourContact, ep.fetchImpl)).outcome).toBe(
      "allowed",
    );
    expect(ep.calls).toHaveLength(1);
  });

  test("the flow line carries the rule's code and no phone", async () => {
    const ep = endpoint();
    const r = await ask(cfg(LIST), neighbourContact, ep.fetchImpl);
    const line = JSON.stringify(contactAuthFlowEvent(r));
    expect(line).toContain(RULE_NOT_LISTED);
    expect(line).not.toContain("98888");
    expect(line).not.toContain("cli-42");
  });

  describe("over MCP", () => {
    const principal = (): VerifiedToken => ({
      userId: 1n,
      tenantId,
      role: "TENANT_ADMIN",
      scopes: ["mcp:read", "mcp:write"],
      clientId: "c",
      jti: "j",
    });

    test("a rule is written, read back normalized, and a bad one is refused", async () => {
      const set = await agentSettingsSet(
        principal(),
        {
          agent_id: String(agentId),
          contactAuth: {
            enabled: true,
            rule: { kind: "allowlist", phones: ["+55 (11) 98888-7777"] },
          },
          dry_run: false,
        },
        { base: appDb },
      );
      expect(set.ok).toBe(true);
      const got = await agentSettingsGet(
        principal(),
        { agent_id: String(agentId) },
        { base: appDb },
      );
      expect(got.ok).toBe(true);
      if (got.ok) {
        const ca = (got.data.settings as Record<string, unknown>)
          .contactAuth as Record<string, unknown>;
        expect(ca.rule).toEqual({
          kind: "allowlist",
          phones: ["5511988887777"],
          identifiers: [],
        });
      }
      const bad = await agentSettingsSet(
        principal(),
        {
          agent_id: String(agentId),
          contactAuth: { rule: { kind: "allowlist", phones: ["123"] } },
          dry_run: false,
        },
        { base: appDb },
      );
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error).toContain("contactAuth.rule");
      const row = await suDb.agent.findUniqueOrThrow({
        where: { id: agentId },
        select: { settings: true },
      });
      expect(readContactAuthConfig(row.settings).rule).toEqual({
        kind: "allowlist",
        phones: ["5511988887777"],
        identifiers: [],
      });
      const cleared = await agentSettingsSet(
        principal(),
        {
          agent_id: String(agentId),
          contactAuth: { rule: null },
          dry_run: false,
        },
        { base: appDb },
      );
      expect(cleared.ok).toBe(true);
      const after = await suDb.agent.findUniqueOrThrow({
        where: { id: agentId },
        select: { settings: true },
      });
      expect(readContactAuthConfig(after.settings).rule).toBeNull();
    });
  });
});
