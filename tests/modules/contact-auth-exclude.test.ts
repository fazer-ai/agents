import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import { PrismaClient } from "@/../generated/prisma/client";
import { agentUpdateAudit } from "@/modules/agents/audit-projection";
import { assertSettingsContactAuthRule } from "@/modules/agents/service";
import { BEHAVIOR_PATCH_ARGS_SHAPE } from "@/modules/agents/settings-schema";
import { settingsForStorage } from "@/modules/agents/settings-storage";
import { contactAuthNoteText } from "@/modules/chatwoot/webhook";
import {
  evaluateContactAuthRule,
  RULE_EXCLUDED,
  type RuleFacts,
} from "@/modules/contact-auth/rule";
import { authorizeContact } from "@/modules/contact-auth/service";
import {
  CONTACT_AUTH_DEFAULTS,
  type ContactAuthConfig,
  type ContactAuthRule,
  parseContactAuthRule,
  readContactAuthConfig,
} from "@/modules/contact-auth/settings";
import { clearContactAuthState } from "@/modules/contact-auth/state";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";

// ── SERVE EVERYONE EXCEPT ──
//
// A rule's `effect: "exclude"` inverts what a match means: the agent serves every conversation the conditions do NOT match, and refuses the ones they do, through the same refusal path. A condition with nothing to read is unmet, so a contact the list cannot compare is not on it and is served: the `no_identity` of a plain allowlist does not reach an exclusion list.

const STAFF = {
  kind: "allowlist",
  phones: ["+55 (11) 98888-7777", "+55 21 97777-6666"],
  identifiers: ["staff-7"],
  effect: "exclude",
};

const facts = (over: Partial<RuleFacts> = {}): RuleFacts => ({
  phone: null,
  identifier: null,
  conversationType: null,
  labels: [],
  conversationAttributes: {},
  contactAttributes: {},
  ...over,
});

function rule(raw: unknown): ContactAuthRule {
  const r = parseContactAuthRule(raw);
  if (!r) throw new Error(`expected a valid rule: ${JSON.stringify(raw)}`);
  return r;
}

describe("parsing the effect", () => {
  test("exclude is kept on the rule, and serve is the default written as no key", () => {
    expect(rule(STAFF)).toEqual({
      kind: "allowlist",
      phones: ["5511988887777", "5521977776666"],
      identifiers: ["staff-7"],
      effect: "exclude",
    });
    expect(rule({ ...STAFF, effect: "serve" })).not.toHaveProperty("effect");
    expect(rule({ ...STAFF, effect: undefined })).not.toHaveProperty("effect");
    expect(
      rule({
        kind: "any",
        conditions: [{ kind: "label", label: "Equipe" }],
        effect: "exclude",
      }),
    ).toEqual({
      kind: "any",
      conditions: [{ kind: "label", label: "equipe" }],
      effect: "exclude",
    });
  });

  test("any other effect reads the whole rule as absent", () => {
    for (const effect of ["deny", "EXCLUDE", true, 1, ""]) {
      expect(parseContactAuthRule({ ...STAFF, effect })).toBeNull();
    }
    // NOTE: the config reader agrees: the enabled gate then has no rule, the fail-closed `not_configured`.
    expect(
      readContactAuthConfig({
        contactAuth: { enabled: true, rule: { ...STAFF, effect: "deny" } },
      }).rule,
    ).toBeNull();
  });

  test("an effect inside a combination's condition is refused, not ignored", () => {
    expect(
      parseContactAuthRule({
        kind: "any",
        conditions: [{ kind: "label", label: "equipe", effect: "exclude" }],
      }),
    ).toBeNull();
    expect(
      parseContactAuthRule({
        kind: "any",
        conditions: [{ kind: "label", label: "equipe", effect: "serve" }],
      }),
    ).toBeNull();
  });
});

describe("what an exclusion decides", () => {
  const staff = rule(STAFF);

  test("a listed phone is refused, by digits, however it was typed", () => {
    for (const phone of [
      "+5511988887777",
      "5511988887777",
      "+55 11 98888-7777",
      "(55) 11-98888 7777",
    ]) {
      expect(evaluateContactAuthRule(staff, facts({ phone }))).toEqual({
        outcome: "denied",
        reason: RULE_EXCLUDED,
      });
    }
    expect(
      evaluateContactAuthRule(staff, facts({ identifier: "staff-7" })).outcome,
    ).toBe("denied");
  });

  test("an unlisted phone, a suffix of a listed one, and nothing to compare are all served", () => {
    for (const f of [
      facts({ phone: "+5511988887778" }),
      facts({ phone: "11988887777" }),
      facts({ identifier: "cli-42" }),
      facts(),
    ]) {
      expect(evaluateContactAuthRule(staff, f)).toEqual({ outcome: "allowed" });
    }
  });

  test("every kind inverts: attribute, label, conversation type, and a combination", () => {
    const pro = rule({
      kind: "attribute",
      scope: "contact",
      key: "tipo_contato",
      equals: "profissional",
      effect: "exclude",
    });
    expect(
      evaluateContactAuthRule(
        pro,
        facts({ contactAttributes: { tipo_contato: "profissional" } }),
      ).outcome,
    ).toBe("denied");
    expect(
      evaluateContactAuthRule(
        pro,
        facts({ contactAttributes: { tipo_contato: "cliente" } }),
      ).outcome,
    ).toBe("allowed");
    const groups = rule({
      kind: "conversation_type",
      type: "group",
      effect: "exclude",
    });
    expect(
      evaluateContactAuthRule(groups, facts({ conversationType: "group" }))
        .outcome,
    ).toBe("denied");
    expect(
      evaluateContactAuthRule(groups, facts({ conversationType: "individual" }))
        .outcome,
    ).toBe("allowed");
    const label = rule({ kind: "label", label: "equipe", effect: "exclude" });
    expect(
      evaluateContactAuthRule(label, facts({ labels: ["Equipe"] })).outcome,
    ).toBe("denied");
    // `any` under exclude: out when any matches. `all` under exclude: out only when all match.
    const conditions = [
      { kind: "label", label: "equipe" },
      { kind: "conversation_type", type: "group" },
    ];
    const anyOut = rule({ kind: "any", conditions, effect: "exclude" });
    const allOut = rule({ kind: "all", conditions, effect: "exclude" });
    const labelledChat = facts({
      labels: ["equipe"],
      conversationType: "individual",
    });
    expect(evaluateContactAuthRule(anyOut, labelledChat).outcome).toBe(
      "denied",
    );
    expect(evaluateContactAuthRule(allOut, labelledChat).outcome).toBe(
      "allowed",
    );
    expect(
      evaluateContactAuthRule(
        allOut,
        facts({ labels: ["equipe"], conversationType: "group" }),
      ),
    ).toEqual({ outcome: "denied", reason: RULE_EXCLUDED });
  });

  test("without the effect the same rule still serves only what it lists", () => {
    const pilots = rule({ ...STAFF, effect: undefined });
    expect(
      evaluateContactAuthRule(pilots, facts({ phone: "+5511988887777" }))
        .outcome,
    ).toBe("allowed");
    expect(
      evaluateContactAuthRule(pilots, facts({ phone: "+5511988887778" }))
        .outcome,
    ).toBe("denied");
  });
});

describe("every write path keeps the effect", () => {
  test("the MCP argument parse does not drop it, on a plain rule or a combination", () => {
    const args = z.object(BEHAVIOR_PATCH_ARGS_SHAPE);
    const plain = args.parse({ contactAuth: { rule: STAFF } });
    expect(
      (plain.contactAuth as Record<string, Record<string, unknown>>).rule
        ?.effect,
    ).toBe("exclude");
    const combo = args.parse({
      contactAuth: {
        rule: {
          kind: "any",
          conditions: [{ kind: "label", label: "equipe" }],
          effect: "exclude",
        },
      },
    });
    expect(
      (combo.contactAuth as Record<string, Record<string, unknown>>).rule
        ?.effect,
    ).toBe("exclude");
    expect(
      args.safeParse({ contactAuth: { rule: { ...STAFF, effect: "deny" } } })
        .success,
    ).toBe(false);
  });

  test("the write boundary accepts it and refuses a bad one", () => {
    assertSettingsContactAuthRule({ contactAuth: { rule: STAFF } }, {});
    expect(() =>
      assertSettingsContactAuthRule(
        { contactAuth: { rule: { ...STAFF, effect: "deny" } } },
        {},
      ),
    ).toThrow("contactAuth.rule");
  });

  test("storage writes the read form with the effect on it", () => {
    const stored = settingsForStorage({
      contactAuth: { enabled: true, rule: STAFF },
    }) as { contactAuth: { rule: unknown } };
    expect(stored.contactAuth.rule).toEqual({
      kind: "allowlist",
      phones: ["5511988887777", "5521977776666"],
      identifiers: ["staff-7"],
      effect: "exclude",
    });
  });

  test("an explicit serve is stored as no key, and swapping it for an omitted one audits nothing", () => {
    const stored = settingsForStorage({
      contactAuth: { enabled: true, rule: { ...STAFF, effect: "serve" } },
    }) as { contactAuth: { rule: Record<string, unknown> } };
    expect(stored.contactAuth.rule).not.toHaveProperty("effect");
    const row = (rule: unknown) => ({
      settings: { contactAuth: { enabled: true, rule } },
    });
    expect(
      agentUpdateAudit(
        row({ ...STAFF, effect: "serve" }),
        row({ ...STAFF, effect: undefined }),
      ),
    ).toBeNull();
  });

  test("turning a list into an exclusion is an audited change, still without the numbers", () => {
    const row = (effect?: string) => ({
      settings: {
        contactAuth: {
          enabled: true,
          rule: { ...STAFF, ...(effect ? { effect } : { effect: undefined }) },
        },
      },
    });
    const audit = agentUpdateAudit(row(), row("exclude"));
    if (!audit) throw new Error("expected an audit row");
    const text = JSON.stringify(audit);
    expect(text).not.toContain("988887777");
    expect(text).not.toContain("staff-7");
    const after = (audit.after as Record<string, Record<string, unknown>>)
      .contactAuth;
    expect(after?.rule).toEqual({
      kind: "allowlist",
      phones: 2,
      identifiers: 1,
      effect: "exclude",
    });
  });

  test("the operator note says the conversation was excluded by the rule", () => {
    const note = contactAuthNoteText(
      { outcome: "denied", reason: RULE_EXCLUDED },
      true,
      "none",
    );
    expect(note).toContain("excluída pela regra do agente");
    expect(note).not.toContain("verificação externa");
    expect(note).toContain("aberta para atendimento humano");
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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const AUTH_URL = "https://203.0.113.71:9443/check";

let tenantId = 0n;
let agentId = 0n;
let staffContact = 0n;
let customerContact = 0n;
let emailOnlyContact = 0n;
let bareContact = 0n;

function endpoint() {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response('{"authorized":true}', { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function cfg(over: Partial<ContactAuthConfig> = {}): ContactAuthConfig {
  return {
    ...CONTACT_AUTH_DEFAULTS,
    enabled: true,
    url: AUTH_URL,
    rule: rule(STAFF),
    ...over,
  };
}

let seq = 0;
function ask(
  config: ContactAuthConfig,
  contact: bigint,
  fetchImpl: typeof fetch,
) {
  seq += 1;
  return authorizeContact({
    tenantId,
    agentId,
    contactDbId: contact,
    conversationDbId: null,
    conversationId: 7710,
    inboxId: 77,
    channelType: "Channel::Whatsapp",
    messageText: null,
    requestKey: `exclude:${seq}`,
    stage: "both",
    cfg: config,
    base: appDb,
    fetchImpl,
  });
}

describe.skipIf(!dbUp)("an exclusion list at the gate", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "CAX", slug: `cax-${process.pid}` },
    });
    tenantId = t.id;
    const instanceId = (
      await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 77,
        baseUrl: "https://203.0.113.77:9",
      })
    ).id;
    agentId = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Recepção",
          systemPrompt: "x",
          modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        },
      })
    ).id;
    let cw = 7700;
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
    staffContact = await contact({ phone: "+55 11 98888-7777" });
    customerContact = await contact({ phone: "+5511988887778" });
    emailOnlyContact = await contact({ email: "lead@example.com" });
    bareContact = await contact({});
  });

  afterAll(async () => {
    if (!dbUp) return;
    clearContactAuthState();
    await suDb.contactAuthGrant.deleteMany({ where: { tenantId } });
    await suDb.contact.deleteMany({ where: { tenantId } });
    await suDb.agent.deleteMany({ where: { tenantId } });
    await suDb.chatwootInstance.deleteMany({ where: { tenantId } });
    await suDb.tenant.delete({ where: { id: tenantId } });
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("a listed staff number is refused at the rule, and the endpoint is never asked", async () => {
    const ep = endpoint();
    const r = await ask(
      cfg({ askEndpointAfterRule: true }),
      staffContact,
      ep.fetchImpl,
    );
    expect(r).toMatchObject({
      outcome: "denied",
      reason: RULE_EXCLUDED,
      stage: "rule",
    });
    expect(ep.calls).toHaveLength(0);
  });

  test("an unlisted number is served by the rule alone, and handed to the endpoint when asked", async () => {
    const alone = endpoint();
    expect(await ask(cfg(), customerContact, alone.fetchImpl)).toMatchObject({
      outcome: "allowed",
      stage: "rule",
    });
    expect(alone.calls).toHaveLength(0);
    const twoStages = endpoint();
    expect(
      await ask(
        cfg({ askEndpointAfterRule: true }),
        customerContact,
        twoStages.fetchImpl,
      ),
    ).toMatchObject({ outcome: "allowed", stage: "endpoint" });
    expect(twoStages.calls).toHaveLength(1);
  });

  test("a contact with no phone and no identifier is not on the list: served, not no_identity", async () => {
    const ep = endpoint();
    for (const c of [bareContact, emailOnlyContact]) {
      expect(await ask(cfg(), c, ep.fetchImpl)).toMatchObject({
        outcome: "allowed",
        stage: "rule",
      });
    }
    expect(ep.calls).toHaveLength(0);
    // NOTE: the same contact under a plain allowlist still has nothing to verify.
    expect(
      (
        await ask(
          cfg({ rule: rule({ ...STAFF, effect: undefined }) }),
          bareContact,
          ep.fetchImpl,
        )
      ).outcome,
    ).toBe("no_identity");
  });
});
