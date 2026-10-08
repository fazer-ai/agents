import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { computeConfigIssues } from "@/modules/agents/config-health";
import {
  authorizeContact,
  type ContactAuthStage,
  contactAuthFlowEvent,
} from "@/modules/contact-auth/service";
import {
  CONTACT_AUTH_DEFAULTS,
  type ContactAuthConfig,
  contactAuthHasEndpointStage,
  contactAuthHasRuleStage,
  parseContactAuthRule,
  readContactAuthConfig,
} from "@/modules/contact-auth/settings";
import { clearContactAuthState } from "@/modules/contact-auth/state";
import { seedChatwootInstance } from "../utils/chatwoot";

// ── THE GATE IN TWO STAGES ──
//
// The rule decides first and hands what it allows to the endpoint, under an explicit flag, so a url
// stored beside a rule without the flag is never asked. Each stage is asked at its own position by
// the callers; `both` is the whole gate in one call.

const GROUP_RULE = { kind: "conversation_type", type: "group" };

describe("reading the two new fields", () => {
  test("the endpoint after the rule only on an explicit true", () => {
    for (const v of [undefined, null, "true", 1, {}]) {
      expect(
        readContactAuthConfig({ contactAuth: { askEndpointAfterRule: v } })
          .askEndpointAfterRule,
      ).toBe(false);
    }
    expect(
      readContactAuthConfig({ contactAuth: { askEndpointAfterRule: true } })
        .askEndpointAfterRule,
    ).toBe(true);
  });

  test("the denial's note stays on unless switched off with an explicit false", () => {
    for (const v of [undefined, null, "false", 0, {}]) {
      expect(
        readContactAuthConfig({ contactAuth: { operatorNoteEnabled: v } })
          .operatorNoteEnabled,
      ).toBe(true);
    }
    expect(
      readContactAuthConfig({ contactAuth: { operatorNoteEnabled: false } })
        .operatorNoteEnabled,
    ).toBe(false);
    expect(CONTACT_AUTH_DEFAULTS.operatorNoteEnabled).toBe(true);
    expect(CONTACT_AUTH_DEFAULTS.askEndpointAfterRule).toBe(false);
  });

  test("which stages an agent has", () => {
    const rule = parseContactAuthRule(GROUP_RULE);
    const at = (over: Partial<ContactAuthConfig>) => ({
      ...CONTACT_AUTH_DEFAULTS,
      enabled: true,
      ...over,
    });
    // The endpoint alone, and the gate with neither (the fail-closed `not_configured`).
    expect(contactAuthHasRuleStage(at({ url: "https://x.test/a" }))).toBe(
      false,
    );
    expect(contactAuthHasEndpointStage(at({ url: "https://x.test/a" }))).toBe(
      true,
    );
    expect(contactAuthHasEndpointStage(at({}))).toBe(true);
    // The rule alone, a url beside it included.
    expect(contactAuthHasRuleStage(at({ rule }))).toBe(true);
    expect(
      contactAuthHasEndpointStage(at({ rule, url: "https://x.test/a" })),
    ).toBe(false);
    // Both, under the flag. With no url the endpoint stage still exists, and refuses as unconfigured.
    expect(
      contactAuthHasEndpointStage(at({ rule, askEndpointAfterRule: true })),
    ).toBe(true);
  });
});

describe("the editor's warnings follow the endpoint stage", () => {
  const base = {
    contactAuthEnabled: true,
    contactAuthDenyMessage: "x",
    contactAuthHandoffEnabled: false,
  };
  const keys = (input: Record<string, unknown>) =>
    computeConfigIssues(input as never)
      .map((i) => i.key)
      .filter((k) => k.startsWith("contactAuth"));

  test("a rule with the endpoint after it and no url is an unconfigured endpoint", () => {
    expect(keys({ ...base, contactAuthRuleOnly: false })).toContain(
      "contactAuthNoUrl",
    );
    expect(keys({ ...base, contactAuthRuleOnly: true })).not.toContain(
      "contactAuthNoUrl",
    );
  });

  test("the unlock and handoff conflict is about a real request when the endpoint follows the rule", () => {
    const unlock = {
      ...base,
      contactAuthUrl: "https://x.test/a",
      contactAuthIncludeMessageText: true,
      contactAuthHandoffEnabled: true,
    };
    expect(keys({ ...unlock, contactAuthRuleOnly: false })).toContain(
      "contactAuthUnlockHandoff",
    );
    expect(keys({ ...unlock, contactAuthRuleOnly: true })).not.toContain(
      "contactAuthUnlockHandoff",
    );
  });
});

describe("the flow line says which stage answered", () => {
  test("stage is carried when set, and only then", () => {
    const line = (stage?: "rule" | "endpoint") =>
      contactAuthFlowEvent({
        outcome: "denied",
        shared: false,
        reason: "rule_label",
        ...(stage ? { stage } : {}),
      }).detail as Record<string, unknown>;
    expect(line("rule").stage).toBe("rule");
    expect(line("endpoint").stage).toBe("endpoint");
    expect("stage" in line()).toBe(false);
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
let contactId = 0n;
let groupConv = 0n;
let personConv = 0n;

function endpoint(authorized: boolean) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ authorized }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function cfg(over: Partial<ContactAuthConfig>): ContactAuthConfig {
  return {
    ...CONTACT_AUTH_DEFAULTS,
    enabled: true,
    url: "https://203.0.113.9:9443/check",
    rule: parseContactAuthRule(GROUP_RULE),
    ...over,
  };
}

let seq = 0;
function ask(
  config: ContactAuthConfig,
  conversationDbId: bigint,
  stage: ContactAuthStage,
  fetchImpl: typeof fetch,
  requestKey?: string,
) {
  seq += 1;
  return authorizeContact({
    tenantId,
    agentId,
    contactDbId: contactId,
    conversationDbId,
    conversationId: 7870,
    inboxId: 87,
    channelType: "Channel::Whatsapp",
    messageText: null,
    requestKey: requestKey ?? `stages:${seq}`,
    stage,
    cfg: config,
    base: appDb,
    fetchImpl,
  });
}

describe.skipIf(!dbUp)("asking each stage", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "CA-STAGES", slug: `ca-stages-${process.pid}` },
    });
    tenantId = t.id;
    instanceId = (
      await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 87,
        baseUrl: "https://203.0.113.87:9",
      })
    ).id;
    agentId = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Etapas",
          systemPrompt: "x",
          modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        },
      })
    ).id;
    // A contact the endpoint can ask about (a phone), so the endpoint stage is reachable.
    contactId = (
      await suDb.contact.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootContactId: 8700,
          phone: "+5511977770000",
        },
      })
    ).id;
    let id = 7871;
    const conv = async (conversationType: string) =>
      (
        await suDb.conversation.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: id,
            status: "pending",
            threadId: `${tenantId}:${instanceId}:${id++}`,
            contactId,
            conversationType,
          },
        })
      ).id;
    groupConv = await conv("group");
    personConv = await conv("individual");
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

  test("both: a rule refusal never reaches the endpoint", async () => {
    const ep = endpoint(true);
    const v = await ask(
      cfg({ askEndpointAfterRule: true }),
      personConv,
      "both",
      ep.fetchImpl,
    );
    expect(v).toMatchObject({ outcome: "denied", stage: "rule" });
    expect(ep.calls).toHaveLength(0);
  });

  test("both: a rule allow is handed to the endpoint, whose verdict stands", async () => {
    const yes = endpoint(true);
    expect(
      await ask(
        cfg({ askEndpointAfterRule: true }),
        groupConv,
        "both",
        yes.fetchImpl,
      ),
    ).toMatchObject({ outcome: "allowed", stage: "endpoint" });
    expect(yes.calls).toHaveLength(1);
    const no = endpoint(false);
    expect(
      await ask(
        cfg({ askEndpointAfterRule: true }),
        groupConv,
        "both",
        no.fetchImpl,
      ),
    ).toMatchObject({ outcome: "denied", stage: "endpoint" });
    expect(no.calls).toHaveLength(1);
  });

  test("without the flag the rule alone decides, a url beside it included", async () => {
    const ep = endpoint(false);
    expect(await ask(cfg({}), groupConv, "both", ep.fetchImpl)).toMatchObject({
      outcome: "allowed",
      stage: "rule",
    });
    expect(ep.calls).toHaveLength(0);
  });

  test("the rule stage asks the rule only, even when an endpoint follows", async () => {
    const ep = endpoint(false);
    const config = cfg({ askEndpointAfterRule: true });
    // An allow at the rule position is not the gate's answer yet, and costs no call.
    expect(await ask(config, groupConv, "rule", ep.fetchImpl)).toMatchObject({
      outcome: "allowed",
      stage: "rule",
    });
    expect(await ask(config, personConv, "rule", ep.fetchImpl)).toMatchObject({
      outcome: "denied",
      stage: "rule",
    });
    expect(ep.calls).toHaveLength(0);
  });

  test("the rule stage with no rule set has nothing to refuse", async () => {
    const ep = endpoint(false);
    expect(
      await ask(cfg({ rule: null }), personConv, "rule", ep.fetchImpl),
    ).toMatchObject({ outcome: "allowed", stage: "rule" });
    expect(ep.calls).toHaveLength(0);
  });

  test("the endpoint stage skips the rule the caller already asked", async () => {
    // The rule would refuse this conversation; at the endpoint position it is not asked again.
    const ep = endpoint(true);
    expect(
      await ask(
        cfg({ askEndpointAfterRule: true }),
        personConv,
        "endpoint",
        ep.fetchImpl,
      ),
    ).toMatchObject({ outcome: "allowed", stage: "endpoint" });
    expect(ep.calls).toHaveLength(1);
  });

  test("the endpoint stage after a rule with no url is the fail-closed not_configured", async () => {
    const ep = endpoint(true);
    expect(
      await ask(
        cfg({ askEndpointAfterRule: true, url: null }),
        groupConv,
        "both",
        ep.fetchImpl,
      ),
    ).toMatchObject({
      outcome: "error",
      reason: "not_configured",
      stage: "endpoint",
    });
  });

  // The webhook asks the endpoint stage while a late update of the same message asks the whole gate
  // (the media pass): one question to the operator's endpoint, so one request, whichever stage each
  // caller named.
  test("two callers asking the endpoint at once, by different stages, share one request", async () => {
    for (const config of [
      cfg({ rule: null }),
      cfg({ askEndpointAfterRule: true }),
    ]) {
      // A fresh latch per shape: the endpoint answers only after both callers are in.
      let calls = 0;
      let release: () => void = () => {};
      const latch = new Promise<void>((r) => {
        release = r;
      });
      const slow = (async () => {
        calls += 1;
        await latch;
        return new Response('{"authorized":true}', { status: 200 });
      }) as unknown as typeof fetch;
      const key = `coalesce:${seq}`;
      const both = ask(config, groupConv, "both", slow, key);
      const endpointOnly = ask(config, groupConv, "endpoint", slow, key);
      await new Promise((r) => setTimeout(r, 50));
      release();
      const [a, b] = await Promise.all([both, endpointOnly]);
      expect(calls).toBe(1);
      expect([a.outcome, b.outcome]).toEqual(["allowed", "allowed"]);
      expect([a.shared, b.shared].filter(Boolean)).toHaveLength(1);
    }
  });

  test("under once, only the endpoint's allow is stored, never the rule's", async () => {
    const ruleOnly = endpoint(true);
    await ask(cfg({ mode: "once" }), groupConv, "both", ruleOnly.fetchImpl);
    expect(
      await suDb.contactAuthGrant.count({ where: { tenantId, contactId } }),
    ).toBe(0);
    const ep = endpoint(true);
    await ask(
      cfg({ mode: "once", askEndpointAfterRule: true }),
      groupConv,
      "both",
      ep.fetchImpl,
    );
    expect(ep.calls).toHaveLength(1);
    expect(
      await suDb.contactAuthGrant.count({ where: { tenantId, contactId } }),
    ).toBe(1);
    // The stored allow answers the endpoint stage, and the rule still runs in front of it.
    const again = endpoint(true);
    expect(
      await ask(
        cfg({ mode: "once", askEndpointAfterRule: true }),
        groupConv,
        "both",
        again.fetchImpl,
      ),
    ).toMatchObject({ outcome: "allowed", reused: true, stage: "endpoint" });
    expect(again.calls).toHaveLength(0);
    expect(
      await ask(
        cfg({ mode: "once", askEndpointAfterRule: true }),
        personConv,
        "both",
        again.fetchImpl,
      ),
    ).toMatchObject({ outcome: "denied", stage: "rule" });
  });
});
