import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { formatVaultRef } from "@/client/lib/credentialRef";
import type { TenantContext } from "@/lib/tenancy";
import {
  configHealthAfterWrite,
  readAgentConfigHealth,
} from "@/modules/agents/config-health-read";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { agentConfigHealth } from "@/modules/mcp/read";
import { agentSettingsSet } from "@/modules/mcp/write";

// The same warnings the console's editor panel computes, asked for by something that is not a
// browser. Issue #467.
//
// The state under test is the one the issue reports and the one this product actually produces: an
// onboarding driven through MCP wires a credential whose secret was never filled (credential_create
// leaves exactly that), and switches guardrails on. Both are silent at runtime — the pending
// credential fails at first use, and the guardrail block is skipped entirely, so every message goes
// out unscreened while the switch reads "on" — and until this module existed neither was COMPUTED
// anywhere off the editor page.
//
// The seed builds those states through the vault the way the product does (a `pending` row, and a
// live entry to prove the reading distinguishes them), then asks the three surfaces this change
// adds: the module, the MCP read tool, and what a write reports back about what it just left behind.

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
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

let tenantId = 0n;
let otherTenantId = 0n;
let brokenAgent = 0n;
let healthyAgent = 0n;
let degradedAgent = 0n;
let failingAgent = 0n;
let ragAgent = 0n;
let unconfiguredAgent = 0n;
let chatwootAgent = 0n;
let otherAgent = 0n;
let pendingRef = "";
let liveRef = "";

function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

function principal(t: bigint): VerifiedToken {
  return {
    userId: 1n,
    tenantId: t,
    role: "TENANT_ADMIN",
    scopes: ["mcp:read", "mcp:write"],
    clientId: "c",
    jti: "j",
  };
}

describe.skipIf(!dbUp)("agent configuration health", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "CH", slug: `ch-${process.pid}` },
      })
    ).id;
    otherTenantId = (
      await suDb.tenant.create({
        data: { name: "CHB", slug: `ch-b-${process.pid}` },
      })
    ).id;
    // A reference-only entry: `credential_create` over MCP writes exactly this, and the operator is
    // supposed to fill the secret afterwards. Nothing on the MCP path ever said they had not.
    const pending = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "stt-key",
        kind: "generic",
        secret: encryptJson({}),
        status: "pending",
      },
    });
    pendingRef = formatVaultRef(String(pending.id));
    const live = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "model-key",
        kind: "generic",
        secret: encryptJson("sk-live"),
      },
    });
    liveRef = formatVaultRef(String(live.id));

    brokenAgent = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Broken",
          systemPrompt: "x",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: liveRef,
          },
          settings: {
            // On, with no key. `prepare.ts` gates the analysis on `enabled && credentialRef`, so the
            // block never runs, nothing is written at runtime, and the agent answers normally.
            guardrails: { enabled: true },
            // Wired to the reference-only entry above.
            stt: { enabled: true, credentialRef: pendingRef },
          },
        },
        select: { id: true },
      })
    ).id;
    healthyAgent = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Healthy",
          systemPrompt: "x",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: liveRef,
          },
          // STT ships ON by default (STT_DEFAULTS), so an agent that never configured it is an agent
          // with a credentialled feature and no credential. Switched off here on purpose: this row
          // exists to prove a clean answer is reachable at all.
          settings: { stt: { enabled: false } },
        },
        select: { id: true },
      })
    ).id;
    // Nothing blocking, one feature that is on and cannot run. This row exists for one question the
    // other two cannot answer: whether `healthy` means "answers at all" or "does what it is
    // configured to do". Without it, the broken agent's blocking issue answers for both.
    degradedAgent = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Degraded",
          systemPrompt: "x",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: liveRef,
          },
          settings: { stt: { enabled: true, credentialRef: pendingRef } },
        },
        select: { id: true },
      })
    ).id;
    // Guardrails ON and CREDENTIALLED, with analyses that could not run. This is the state the
    // configuration alone cannot see: a retired model id, a parameter the vendor rejects and a
    // chronic timeout are all valid configuration until the call is made, and the pass is fail-open.
    failingAgent = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Failing screen",
          systemPrompt: "x",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: liveRef,
          },
          settings: {
            guardrails: { enabled: true, credentialRef: liveRef },
            stt: { enabled: false },
          },
        },
        select: { id: true },
      })
    ).id;
    await suDb.executionLog.createMany({
      data: [
        {
          tenantId,
          turnId: `ch-g1-${process.pid}`,
          agentId: failingAgent,
          stage: "guardrail",
          level: "warn",
          status: "error",
          source: "inbox",
          errorMessage: "401 incorrect api key provided",
          createdAt: new Date(Date.now() - 90 * 60_000),
        },
        {
          tenantId,
          turnId: `ch-g2-${process.pid}`,
          agentId: failingAgent,
          stage: "guardrail",
          level: "warn",
          status: "error",
          source: "inbox",
          errorMessage: "400 temperature is not supported",
          createdAt: new Date(Date.now() - 5 * 60_000),
        },
      ],
    });
    // A knowledge base this agent is granted, holding a document nobody indexed. Two fields of the
    // input come from two different services here (the tenant's embedding credential and the agent's
    // RAG grant), and the answer depends on BOTH: with embedding unusable the reading is supposed to
    // roll every per-base prompt up into the one issue that names the real blocker.
    const kb = await suDb.knowledgeBase.create({
      data: { tenantId, name: "Catálogo" },
      select: { id: true },
    });
    await suDb.knowledgeDocument.create({
      data: {
        tenantId,
        knowledgeBaseId: kb.id,
        title: "tabela.pdf",
        sourceType: "import",
        content: "x",
        status: "UNINDEXED",
      },
    });
    ragAgent = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "RAG",
          systemPrompt: "x",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: liveRef,
          },
          settings: { stt: { enabled: false } },
        },
        select: { id: true },
      })
    ).id;
    await suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId: ragAgent,
        source: "RAG",
        knowledgeBaseIds: [kb.id],
        enabledTools: [],
      },
    });
    // `modelConfig: {}` is storable BY DESIGN (validateModelConfigForWrite: "unconfigured — the agent
    // simply won't run until set"), and an agent created over REST or MCP without one lands exactly
    // there. Nothing else is on, so this row answers one question: does a reading that finds no
    // problems mean the agent works.
    unconfiguredAgent = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Unconfigured",
          systemPrompt: "x",
          modelConfig: {},
          settings: { stt: { enabled: false } },
        },
        select: { id: true },
      })
    ).id;
    // An agent bound to an inbox on a Chatwoot nobody can reach. The reader absorbs that failure per
    // account and answers with a SHORT LIST, which is indistinguishable from "no inbox answers out
    // of hours" — the exact case `unchecked` exists to name.
    const deployment = await suDb.chatwootDeployment.create({
      data: {
        tenantId,
        baseUrl: `http://127.0.0.1:9/p${process.pid}`,
        adminToken: encryptJson("nope"),
      },
    });
    const cwInstance = await suDb.chatwootInstance.create({
      data: {
        tenantId,
        deploymentId: deployment.id,
        accountId: 1,
        serverKey: `http://127.0.0.1:9/p${process.pid}`,
        accountName: "unreachable",
      },
    });
    chatwootAgent = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Bound to a dead Chatwoot",
          systemPrompt: "x",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: liveRef,
          },
          settings: { stt: { enabled: false } },
        },
        select: { id: true },
      })
    ).id;
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: cwInstance.id,
        chatwootInboxId: 4242,
        name: "mirror",
        agentId: chatwootAgent,
      },
    });
    otherAgent = (
      await suDb.agent.create({
        data: {
          tenantId: otherTenantId,
          name: "Theirs",
          systemPrompt: "x",
          modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    for (const tid of [tenantId, otherTenantId]) {
      if (!tid) continue;
      for (const table of [
        "execution_logs",
        "inboxes",
        "chatwoot_instances",
        "chatwoot_deployments",
        "audit_logs",
        "agents",
        "vault_entries",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tid}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  describe("readAgentConfigHealth", () => {
    test("guardrails on with no credential is reported, as blocking", async () => {
      const health = await readAgentConfigHealth(ctx(tenantId), brokenAgent, {
        base: appDb,
      });
      const guardrails = health.issues.find((i) => i.key === "guardrails");
      expect(guardrails?.severity).toBe("blocking");
      // The sentence, not just the key: a caller that is not the console has nothing else to read.
      expect(guardrails?.message).toContain("unscreened");
      expect(health.healthy).toBe(false);
      expect(health.counts.blocking).toBeGreaterThanOrEqual(1);
    });

    test("a credential referenced but never filled is told apart from a missing one", async () => {
      const health = await readAgentConfigHealth(ctx(tenantId), brokenAgent, {
        base: appDb,
      });
      const stt = health.issues.find((i) => i.key === "stt");
      expect(stt?.pending).toBe(true);
      expect(stt?.unresolved).toBeUndefined();
      // The fix is to fill the secret in place, so the caller is handed the entry to fill.
      expect(stt?.vaultId).toBe(pendingRef.replace("vault:", ""));
      expect(stt?.severity).toBe("degraded");
    });

    // The line between the two severities that stop an install, stated where it is decided. A
    // reading that only counted blocking issues would call this agent healthy while every voice note
    // a customer sends goes untranscribed.
    test("a feature that is on and cannot run is enough to be unhealthy", async () => {
      const health = await readAgentConfigHealth(ctx(tenantId), degradedAgent, {
        base: appDb,
      });
      expect(health.counts.blocking).toBe(0);
      expect(health.counts.degraded).toBeGreaterThanOrEqual(1);
      expect(health.healthy).toBe(false);
    });

    // Configuration alone cannot answer this one, so it is the check that proves the reading takes
    // the live measurement rather than only walking the settings bag. Suppressed while a credential
    // verdict is live (with no key the runtime writes no failure rows at all), which is why this
    // agent has one.
    test("a credentialled guardrail that could not run is reported, with the count and the cause", async () => {
      const health = await readAgentConfigHealth(ctx(tenantId), failingAgent, {
        base: appDb,
      });
      const failing = health.issues.find((i) => i.key === "guardrailsFailing");
      expect(failing?.severity).toBe("blocking");
      expect(failing?.message).toContain("2");
      expect(failing?.message).toContain("400 temperature is not supported");
      expect(health.issues.some((i) => i.key === "guardrails")).toBe(false);
      expect(health.unchecked).toEqual([]);
    });

    // The other half of the same seam: the reading is not taken when the screen is off, so an agent
    // with guardrails disabled carries no count and asks the log nothing.
    test("with guardrails off there is no failure line", async () => {
      const health = await readAgentConfigHealth(ctx(tenantId), healthyAgent, {
        base: appDb,
      });
      expect(health.issues.some((i) => i.key === "guardrailsFailing")).toBe(
        false,
      );
    });

    // The tenant has no embedding credential, so the per-base "index me" prompts roll up into the
    // one issue that names what is actually blocking them. Both halves of that answer are wiring
    // this module owns: the grant comes from the agent, the credential from the tenant.
    test("an unindexed base points at the embedding credential, not at itself", async () => {
      const health = await readAgentConfigHealth(ctx(tenantId), ragAgent, {
        base: appDb,
      });
      const embedding = health.issues.find((i) => i.key === "embedding");
      expect(embedding).toBeDefined();
      expect(health.issues.some((i) => i.key === "knowledge")).toBe(false);
      expect(health.counts.degraded).toBeGreaterThanOrEqual(1);
      // The tenant has no embedding credential at all, which is a different fix from one that was
      // deleted or never filled — and the three states are three sentences. Asserted because the key
      // alone survives the reading passing any garbage ref through: an unresolvable one raises the
      // same key from the same line.
      expect(embedding?.pending).toBeUndefined();
      expect(embedding?.unresolved).toBeUndefined();
    });

    // The line `healthy` draws, tested from the side that makes it dangerous: a reading with nothing
    // to report on an agent that answers nobody. The credential check cannot raise this — it asks
    // whether a CONFIGURED provider has a key, and there is no provider to ask about.
    test("an agent with no model at all is not healthy", async () => {
      const health = await readAgentConfigHealth(
        ctx(tenantId),
        unconfiguredAgent,
        { base: appDb },
      );
      const unset = health.issues.find((i) => i.key === "modelNotRunnable");
      expect(unset?.severity).toBe("blocking");
      // The sentence a caller acts on, not just the key.
      expect(unset?.message).toContain("cannot be built");
      expect(health.healthy).toBe(false);
    });

    // A per-account failure is absorbed INSIDE the reader, so the outer catch never sees it and the
    // list comes back short rather than rejected. Without the count travelling out of that reader,
    // this call would report a complete, clean answer about a server it never reached.
    test("a Chatwoot it could not reach lands in unchecked, not in silence", async () => {
      const health = await readAgentConfigHealth(ctx(tenantId), chatwootAgent, {
        base: appDb,
      });
      expect(health.unchecked).toContain("chatwootOutOfOffice");
      expect(health.issues.some((i) => i.key.startsWith("outOfHours"))).toBe(
        false,
      );
    });

    test("an agent with nothing wrong comes back healthy and empty", async () => {
      const health = await readAgentConfigHealth(ctx(tenantId), healthyAgent, {
        base: appDb,
      });
      expect(health.issues).toEqual([]);
      expect(health.healthy).toBe(true);
      expect(health.counts).toEqual({ blocking: 0, degraded: 0, advisory: 0 });
    });

    test("the sentence follows the requested language", async () => {
      const en = await readAgentConfigHealth(ctx(tenantId), brokenAgent, {
        base: appDb,
        locale: "en",
      });
      const pt = await readAgentConfigHealth(ctx(tenantId), brokenAgent, {
        base: appDb,
        locale: "pt-BR",
      });
      const of = (h: typeof en) =>
        h.issues.find((i) => i.key === "guardrails")?.message ?? "";
      expect(of(en)).not.toBe("");
      expect(of(pt)).not.toBe("");
      expect(of(pt)).not.toBe(of(en));
    });

    // The half a clean answer cannot state on its own. Both live readings fail as an EMPTY result,
    // which is indistinguishable from "nothing to report", so skipping them has to be visible.
    test("the cheap variant names the checks it did not take", async () => {
      const full = await readAgentConfigHealth(ctx(tenantId), brokenAgent, {
        base: appDb,
      });
      expect(full.unchecked).toEqual([]);
      const cheap = await readAgentConfigHealth(ctx(tenantId), brokenAgent, {
        base: appDb,
        live: false,
      });
      expect(cheap.unchecked).toContain("chatwootOutOfOffice");
      // Guardrails are ON for this agent, so its health reading is one of the skipped ones.
      expect(cheap.unchecked).toContain("guardrailHealth");
    });

    test("another tenant's agent is not readable", async () => {
      await expect(
        readAgentConfigHealth(ctx(tenantId), otherAgent, { base: appDb }),
      ).rejects.toThrow(/not found/i);
    });
  });

  // The transport the issue is actually about: an install done entirely through MCP, with the
  // console never opened.
  describe("agent_config_health (MCP)", () => {
    test("the tool returns the same list the editor would have shown", async () => {
      const r = await agentConfigHealth(
        principal(tenantId),
        { agent_id: String(brokenAgent) },
        { base: appDb },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const health = r.data.health as {
        healthy: boolean;
        issues: { key: string; severity: string; message: string }[];
      };
      expect(health.healthy).toBe(false);
      expect(health.issues.map((i) => i.key)).toContain("guardrails");
      expect(health.issues.every((i) => i.message.length > 0)).toBe(true);
    });

    test("the read gate applies before any of it", async () => {
      const r = await agentConfigHealth(
        { ...principal(tenantId), scopes: [] },
        { agent_id: String(brokenAgent) },
        { base: appDb },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("insufficient_scope");
    });
  });

  // The earlier half of the same answer: a write that CREATES a known-bad state says so, at the
  // moment the caller could still fix it in the same breath.
  describe("config health on a write", () => {
    test("enabling the contact gate with no endpoint comes back on the write", async () => {
      const r = await agentSettingsSet(
        principal(tenantId),
        {
          agent_id: String(healthyAgent),
          // Storable and fail-closed: the reader normalizes a missing URL to null and leaves `enabled`
          // alone, and the runtime then refuses every message. Nothing about the write says so.
          // `includeMessageText` is on so the same write also leaves an ADVISORY behind (the unlock
          // flow and the handoff, which ships on, want opposite things from a refusal) — the next
          // test is about what happens to that one.
          contactAuth: { enabled: true, includeMessageText: true },
          dry_run: false,
        },
        { base: appDb },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const health = r.data.configHealth as {
        healthy: boolean;
        issues: { key: string; severity: string }[];
        unchecked: string[];
      };
      expect(health.healthy).toBe(false);
      const noUrl = health.issues.find((i) => i.key === "contactAuthNoUrl");
      expect(noUrl?.severity).toBe("blocking");
      // A write never waits on Chatwoot, and says so rather than implying it looked.
      expect(health.unchecked).toContain("chatwootOutOfOffice");
    });

    // The write has already COMMITTED by the time this runs, so a rejection here would replace a
    // successful apply with an error — and the client reading that error retries, duplicating a
    // create, a clone or an import. Driven through the failure the reviewer named (an agent read
    // that rejects), which is what an id nobody can resolve produces.
    test("a health read that fails does not turn a successful write into an error", async () => {
      const after = await configHealthAfterWrite(
        ctx(tenantId),
        99_999_999_999n,
        appDb,
      );
      expect(after.configHealth.healthy).toBeNull();
      expect(after.configHealth.unchecked).toContain("configHealth");
      // Absent, never clean: an empty issue list next to `healthy: null` says nobody looked.
      expect(after.configHealth.issues).toEqual([]);
    });

    test("advisory issues are counted but do not ride along on a write", async () => {
      // The gate above is still enabled from the previous test, forwarding the message text while
      // the handoff (on by default) gives the conversation away on the first refusal: that raises
      // `contactAuthUnlockHandoff`, which is advisory — two legitimate switches, not damage.
      const after = await configHealthAfterWrite(
        ctx(tenantId),
        healthyAgent,
        appDb,
      );
      expect(after.configHealth.counts.advisory).toBeGreaterThanOrEqual(1);
      expect(
        after.configHealth.issues.some((i) => i.severity === "advisory"),
      ).toBe(false);
    });
  });
});
