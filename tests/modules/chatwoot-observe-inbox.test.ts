import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import { deleteAgent, updateAgent } from "@/modules/agents/service";
import {
  type ChatwootClient,
  createChatwootClient,
} from "@/modules/chatwoot/client";
import {
  bindInbox,
  observeInbox,
  reconnectChatwootInstance,
  reconnectInbox,
  softDisconnectChatwootInstance,
  unobserveInbox,
} from "@/modules/chatwoot/management";
import { seedChatwootInstance } from "../utils/chatwoot";

// The OBSERVER binding (issue #476): a monitoring agent attached to an inbox on the fork as an
// observer, next to — never instead of — the responder. What is asserted is what Chatwoot was told
// and what the row says afterwards, against a fake that personifies the fork's
// `Api::V1::Accounts::Inboxes::AgentBotObserversController` (fazer-ai/chatwoot#453): POST is
// idempotent, DELETE answers 404 for a bot that was not observing, and a Chatwoot without the route
// answers 404 to the POST as well.

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

function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

function fakeChatwoot(opts: {
  observerRoute: boolean;
  observing: Set<string>;
  // Inboxes Chatwoot no longer has: 404 on their inbox and on the attach alike.
  gone?: Set<number>;
  // Bots an operator deleted out of band: gone from the list `ensureAgentBot` self-heals against,
  // and every inbox they were attached to is detached with them.
  deletedBots?: Set<number>;
  // Where this fake's provisioning counter starts. A second fake in the same test would otherwise
  // hand out the id the first one already used, and a "replacement" equal to the bot it replaces
  // proves nothing.
  firstBot?: number;
  // Runs inside the attach AFTER Chatwoot applied it and before it answers: what lands (or fails)
  // in that window, on our side.
  onAttach?: () => Promise<void>;
  // The same hook on the responder's attach (`set_agent_bot`).
  onSetAgentBot?: () => Promise<void>;
  // Which bot answers each inbox, as Chatwoot has it: the responder's half of `observing`.
  answering?: Map<number, number>;
}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const created: number[] = [];
  let nextBot = opts.firstBot ?? 70;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const json = (status: number, body: unknown) =>
      ({
        ok: status < 300,
        status,
        text: async () => JSON.stringify(body),
      }) as unknown as Response;
    if (path.endsWith("/agent_bots") && method === "POST") {
      nextBot += 1;
      created.push(nextBot);
      return json(200, {
        id: nextBot,
        access_token: `tok-${nextBot}`,
        secret: `sec-${nextBot}`,
      });
    }
    if (path.endsWith("/agent_bots") && method === "GET") {
      const live = [71, 72, 73, ...created].filter(
        (id) => !opts.deletedBots?.has(id),
      );
      return json(
        200,
        [...new Set(live)].map((id) => ({ id })),
      );
    }
    const one = path.match(/\/inboxes\/(\d+)$/);
    if (one && method === "GET") {
      if (opts.gone?.has(Number(one[1])))
        return json(404, { error: "Resource could not be found" });
      return json(200, { id: Number(one[1]) });
    }
    const add = path.match(/\/inboxes\/(\d+)\/agent_bot_observers$/);
    if (add && method === "POST") {
      if (!opts.observerRoute || opts.gone?.has(Number(add[1])))
        return json(404, { error: "Resource could not be found" });
      const key = `${add[1]}:${(init?.body && JSON.parse(init.body as string).agent_bot) ?? ""}`;
      opts.observing.add(key);
      if (opts.onAttach) await opts.onAttach();
      return json(200, { id: 1, name: "Observadora" });
    }
    const setBot = path.match(/\/inboxes\/(\d+)\/set_agent_bot$/);
    if (setBot && method === "POST") {
      const body = init?.body
        ? (JSON.parse(init.body as string) as { agent_bot?: number })
        : {};
      if (body.agent_bot) {
        opts.answering?.set(Number(setBot[1]), body.agent_bot);
      }
      if (opts.onSetAgentBot) await opts.onSetAgentBot();
      return json(200, {});
    }
    const remove = path.match(/\/inboxes\/(\d+)\/agent_bot_observers\/(\d+)$/);
    if (remove && method === "DELETE") {
      const key = `${remove[1]}:${remove[2]}`;
      if (!opts.observing.delete(key))
        return json(404, { error: "Resource could not be found" });
      return json(200, {});
    }
    return json(200, {});
  }) as unknown as typeof fetch;
  const makeClient = (cfg: ConstructorParameters<typeof ChatwootClient>[0]) =>
    createChatwootClient(cfg, {
      fetchImpl,
      assertSafe: async (u: string) => new URL(u),
    });
  return { calls, makeClient };
}

let tenantId = 0n;
let instanceId = 0n;
let inboxRowId = 0n;
let otherInboxRowId = 0n;
let monitoringAgent = 0n;
let productionAgent = 0n;
const INBOX_ID = 91;
const OTHER_INBOX_ID = 92;

describe.skipIf(!dbUp)("the observer binding", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "OBS", slug: `obs-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 41,
      baseUrl: "https://chat.observe.example",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    monitoringAgent = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Observadora",
          systemPrompt: "Você observa.",
          modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
          mode: "monitoring",
        },
      })
    ).id;
    productionAgent = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Atendente",
          systemPrompt: "Você atende.",
          modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
          mode: "production",
        },
      })
    ).id;
    inboxRowId = (
      await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: INBOX_ID,
          name: "SAC",
        },
      })
    ).id;
    otherInboxRowId = (
      await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: OTHER_INBOX_ID,
          name: "Vendas",
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (!dbUp) return;
    for (const table of [
      "inbox_observers",
      "inboxes",
      "chatwoot_agent_bots",
      "agents",
      "chatwoot_instances",
      "chatwoot_deployments",
    ]) {
      await suDb
        .$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = ${tenantId}`)
        .catch(() => {});
    }
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  async function observerRows(inbox: bigint) {
    return suDb.inboxObserver.findMany({
      where: { tenantId, inboxId: inbox },
      select: { agentId: true },
    });
  }

  test("only a monitoring agent observes", async () => {
    const cw = fakeChatwoot({ observerRoute: true, observing: new Set() });
    await expect(
      observeInbox(ctx(tenantId), inboxRowId, productionAgent, cw, appDb),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(cw.calls).toEqual([]);
    expect(await observerRows(inboxRowId)).toEqual([]);
  });

  test("observing provisions the persona's bot once and attaches it as an observer, never as the responder", async () => {
    const observing = new Set<string>();
    const cw = fakeChatwoot({ observerRoute: true, observing });
    const dto = await observeInbox(
      ctx(tenantId),
      inboxRowId,
      monitoringAgent,
      cw,
      appDb,
    );
    expect(dto.agentId).toBeNull();
    expect(dto.observerAgentIds).toEqual([String(monitoringAgent)]);
    const attach = cw.calls.filter((c) => /agent_bot_observers$/.test(c.path));
    expect(attach.length).toBe(1);
    expect(attach[0]?.method).toBe("POST");
    expect(
      attach[0]?.path.endsWith(`/inboxes/${INBOX_ID}/agent_bot_observers`),
    ).toBe(true);
    expect(attach[0]?.body).toEqual({ agent_bot: 71 });
    expect(cw.calls.some((c) => c.path.endsWith("/set_agent_bot"))).toBe(false);
    expect(observing.has(`${INBOX_ID}:71`)).toBe(true);

    // A second inbox on the same instance reuses the bot: one persona, one bot, N inboxes.
    const again = await observeInbox(
      ctx(tenantId),
      otherInboxRowId,
      monitoringAgent,
      cw,
      appDb,
    );
    expect(again.observerAgentIds).toEqual([String(monitoringAgent)]);
    const created = cw.calls.filter(
      (c) => c.path.endsWith("/agent_bots") && c.method === "POST",
    );
    expect(created.length).toBe(1);

    // Idempotent: observing again asks the fork again (its POST is idempotent, and that is what
    // repairs an attach whose answer was lost) and creates neither a row nor a bot.
    const attaches = cw.calls.filter((c) =>
      /agent_bot_observers$/.test(c.path),
    ).length;
    await observeInbox(ctx(tenantId), inboxRowId, monitoringAgent, cw, appDb);
    expect((await observerRows(inboxRowId)).length).toBe(1);
    expect(
      cw.calls.filter((c) => /agent_bot_observers$/.test(c.path)).length,
    ).toBe(attaches + 1);
    expect(
      cw.calls.filter(
        (c) => c.path.endsWith("/agent_bots") && c.method === "POST",
      ).length,
    ).toBe(1);
  });

  test("an observing agent cannot leave monitoring until it stops observing", async () => {
    let caught: unknown;
    try {
      await updateAgent(
        ctx(tenantId),
        monitoringAgent,
        { mode: "production" },
        appDb,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).statusCode).toBe(422);
    expect((caught as AppError).translationKey).toBe(
      "errors.agentObservesInboxes",
    );
    // Anything but the mode is still the agent's to change.
    const renamed = await updateAgent(
      ctx(tenantId),
      monitoringAgent,
      { name: "Observadora" },
      appDb,
    );
    expect(renamed.mode).toBe("monitoring");

    // The refusal is about the mode being SAVED, not about the move: a promotion that landed inside
    // an attach window leaves a production observer, and asking only "is it leaving monitoring"
    // would wave every later write through.
    await suDb.agent.update({
      where: { id: monitoringAgent },
      data: { mode: "production" },
    });
    try {
      let second: unknown;
      try {
        await updateAgent(
          ctx(tenantId),
          monitoringAgent,
          { mode: "test" },
          appDb,
        );
      } catch (e) {
        second = e;
      }
      expect((second as AppError).translationKey).toBe(
        "errors.agentObservesInboxes",
      );
    } finally {
      await suDb.agent.update({
        where: { id: monitoringAgent },
        data: { mode: "monitoring" },
      });
    }
  });

  test("an observing agent cannot be deleted either", async () => {
    let caught: unknown;
    try {
      await deleteAgent(ctx(tenantId), monitoringAgent, appDb);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).statusCode).toBe(422);
    expect((caught as AppError).translationKey).toBe(
      "errors.agentObservesInboxes",
    );
    expect((await observerRows(inboxRowId)).length).toBe(1);
  });

  test("an attach whose answer was lost is taken back, and the retry attaches and writes the row", async () => {
    const fila = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 95,
        name: "Fila",
      },
    });
    const observing = new Set<string>();
    // Chatwoot applied the attach; the answer never came back.
    const lost = fakeChatwoot({
      observerRoute: true,
      observing,
      onAttach: async () => {
        throw new Error("socket hang up");
      },
    });
    await expect(
      observeInbox(ctx(tenantId), fila.id, monitoringAgent, lost, appDb),
    ).rejects.toMatchObject({
      statusCode: 502,
      translationKey: "errors.chatwootBindFailed",
    });
    // Taken back: an attachment no row names would observe past the mode and deletion refusals, and
    // nothing here could name it afterwards.
    expect(observing.size).toBe(0);
    expect(await observerRows(fila.id)).toEqual([]);
    // The retry: the POST is idempotent on the fork, and the row follows.
    const cw = fakeChatwoot({ observerRoute: true, observing });
    const dto = await observeInbox(
      ctx(tenantId),
      fila.id,
      monitoringAgent,
      cw,
      appDb,
    );
    expect(
      cw.calls.filter((c) => /agent_bot_observers$/.test(c.path)).length,
    ).toBe(1);
    expect(dto.observerAgentIds).toEqual([String(monitoringAgent)]);
    expect(observing.size).toBe(1);
    await unobserveInbox(ctx(tenantId), fila.id, monitoringAgent, cw, appDb);
  });

  test("where a bind and an observe of the same agent race past their checks, the responder wins, from either side", async () => {
    const vendas = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 97,
        name: "Vendas",
      },
    });
    // The observe side: a bind of the same agent lands while Chatwoot is attaching the observer.
    const observing = new Set<string>();
    const raced = fakeChatwoot({
      observerRoute: true,
      observing,
      onAttach: async () => {
        await suDb.inbox.update({
          where: { id: vendas.id },
          data: { agentId: monitoringAgent },
        });
      },
    });
    const dto = await observeInbox(
      ctx(tenantId),
      vendas.id,
      monitoringAgent,
      raced,
      appDb,
    );
    expect(dto.agentId).toBe(String(monitoringAgent));
    expect(dto.observerAgentIds).toEqual([]);
    expect(await observerRows(vendas.id)).toEqual([]);
    // ...and the attachment the fork was left holding is taken back.
    expect(observing.size).toBe(0);
    await suDb.inbox.update({
      where: { id: vendas.id },
      data: { agentId: null },
    });

    // The bind side: an observe of the same agent lands while Chatwoot is attaching the responder.
    await suDb.$executeRawUnsafe(
      `DELETE FROM audit_logs WHERE tenant_id = ${tenantId} AND target = 'inbox:${vendas.id}'`,
    );
    const binding = fakeChatwoot({
      observerRoute: true,
      observing,
      onSetAgentBot: async () => {
        // The concurrent observe: attached on the fork, and its row written.
        observing.add("97:71");
        await suDb.inboxObserver.create({
          data: { tenantId, inboxId: vendas.id, agentId: monitoringAgent },
        });
      },
    });
    const bound = await bindInbox(
      ctx(tenantId),
      vendas.id,
      monitoringAgent,
      binding,
      appDb,
    );
    expect(bound.agentId).toBe(String(monitoringAgent));
    expect(bound.observerAgentIds).toEqual([]);
    expect(await observerRows(vendas.id)).toEqual([]);
    const retired = await suDb.auditLog.findFirst({
      where: {
        tenantId,
        action: "inbox.unobserve",
        target: `inbox:${vendas.id}`,
      },
      select: { before: true, after: true },
    });
    expect(retired?.before).toEqual({
      observerAgentIds: [String(monitoringAgent)],
    });
    expect(retired?.after).toEqual({ observerAgentIds: [] });
    expect(observing.size).toBe(0);
    await bindInbox(ctx(tenantId), vendas.id, null, binding, appDb);
  });

  test("an agent deleted while its attach is in flight: the attach is taken back, and the observe answers not found", async () => {
    const efemera = await suDb.agent.create({
      data: {
        tenantId,
        name: "Efêmera",
        systemPrompt: "x",
        mode: "monitoring",
      },
      select: { id: true },
    });
    // Its own inbox: an inbox takes ONE watcher, and the fixtures' two already have theirs.
    const spare = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: OTHER_INBOX_ID + 10,
        name: "Efêmera",
      },
      select: { id: true },
    });
    const observing = new Set<string>();
    const cw = fakeChatwoot({
      observerRoute: true,
      observing,
      onAttach: async () => {
        // `deleteAgent` refuses only while a row exists, and the row is not written yet.
        await deleteAgent(ctx(tenantId), efemera.id, appDb);
      },
    });
    await expect(
      observeInbox(ctx(tenantId), spare.id, efemera.id, cw, appDb),
    ).rejects.toMatchObject({
      statusCode: 404,
      translationKey: "errors.agentNotFound",
    });
    expect(observing.size).toBe(0);
    expect(
      await suDb.inboxObserver.count({ where: { agentId: efemera.id } }),
    ).toBe(0);
  });

  // A PROMOTION INSIDE THE ATTACH WINDOW (issue #476 review, round 25). Left unanswered it puts the
  // fork's attachment on an agent that ANSWERS, with no row naming it — and the receiver, finding
  // neither a row nor a monitoring mode, reads that route as the responder's and folds the message
  // in a second time. The mode is re-asked under the agent's row lock, the same lock `updateAgent`
  // takes, so whichever of the two commits first the other sees it.
  test("an agent promoted while its attach is in flight: the attach is taken back, and the observe is refused", async () => {
    const promovida = await suDb.agent.create({
      data: {
        tenantId,
        name: "Promovida",
        systemPrompt: "x",
        mode: "monitoring",
      },
      select: { id: true },
    });
    const spare = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: OTHER_INBOX_ID + 11,
        name: "Promovida",
      },
      select: { id: true },
    });
    const observing = new Set<string>();
    const cw = fakeChatwoot({
      observerRoute: true,
      observing,
      onAttach: async () => {
        // `updateAgent` refuses only while a row exists, and the row is not written yet.
        await updateAgent(
          ctx(tenantId),
          promovida.id,
          { mode: "production" },
          appDb,
        );
      },
    });
    await expect(
      observeInbox(ctx(tenantId), spare.id, promovida.id, cw, appDb),
    ).rejects.toMatchObject({
      statusCode: 422,
      translationKey: "errors.observerNotMonitoring",
    });
    expect(observing.size).toBe(0);
    expect(
      await suDb.inboxObserver.count({ where: { agentId: promovida.id } }),
    ).toBe(0);
  });

  // ONE BOT SERVES EVERY INBOX THIS AGENT WATCHES, so a bot deleted out of band takes them all down
  // together — and the reconcile, which asks whether the BOT exists, would report the untouched ones
  // active once the replacement is provisioned (issue #476 review, round 26).
  test("re-observing after the shared bot was deleted reattaches every inbox this agent watches", async () => {
    const vigia = await suDb.agent.create({
      data: {
        tenantId,
        name: "Vigia N",
        systemPrompt: "x",
        mode: "monitoring",
      },
      select: { id: true },
    });
    const a = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: OTHER_INBOX_ID + 20,
        name: "A",
      },
      select: { id: true, chatwootInboxId: true },
    });
    const b = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: OTHER_INBOX_ID + 21,
        name: "B",
      },
      select: { id: true, chatwootInboxId: true },
    });
    const observing = new Set<string>();
    const cw = fakeChatwoot({ observerRoute: true, observing });
    await observeInbox(ctx(tenantId), a.id, vigia.id, cw, appDb);
    await observeInbox(ctx(tenantId), b.id, vigia.id, cw, appDb);
    expect(observing.size).toBe(2);

    // The bot deleted out of band: every attachment of that persona goes with it.
    observing.clear();
    const botRow = await suDb.chatwootAgentBot.findFirstOrThrow({
      where: { tenantId, chatwootInstanceId: instanceId, agentId: vigia.id },
      select: { chatwootAgentBotId: true },
    });
    const healed = fakeChatwoot({
      observerRoute: true,
      observing,
      deletedBots: new Set([botRow.chatwootAgentBotId]),
      firstBot: 80,
    });
    // Observing ONE of them again is the Reconnect the console offers.
    await observeInbox(ctx(tenantId), a.id, vigia.id, healed, appDb);
    const newBot = await suDb.chatwootAgentBot.findFirstOrThrow({
      where: { tenantId, chatwootInstanceId: instanceId, agentId: vigia.id },
      select: { chatwootAgentBotId: true },
    });
    expect(newBot.chatwootAgentBotId).not.toBe(botRow.chatwootAgentBotId);
    expect(observing).toEqual(
      new Set([
        `${a.chatwootInboxId}:${newBot.chatwootAgentBotId}`,
        `${b.chatwootInboxId}:${newBot.chatwootAgentBotId}`,
      ]),
    );

    await unobserveInbox(ctx(tenantId), a.id, vigia.id, healed, appDb);
    await unobserveInbox(ctx(tenantId), b.id, vigia.id, healed, appDb);
  });

  // ONE AGENT CAN HOLD BOTH ROLES: a monitoring agent may be the responder of one inbox (#209's
  // first rung) while watching another, and the bot the two share is the one the Reconnect replaces
  // (issue #476 review, round 28).
  test("re-observing also puts the replaced bot back on the inboxes this agent answers", async () => {
    const dupla = await suDb.agent.create({
      data: { tenantId, name: "Dupla", systemPrompt: "x", mode: "monitoring" },
      select: { id: true },
    });
    const watched = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: OTHER_INBOX_ID + 30,
        name: "Observada",
      },
      select: { id: true, chatwootInboxId: true },
    });
    const answered = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: OTHER_INBOX_ID + 31,
        name: "Respondida",
      },
      select: { id: true, chatwootInboxId: true },
    });
    const observing = new Set<string>();
    const answering = new Map<number, number>();
    const cw = fakeChatwoot({ observerRoute: true, observing, answering });
    await observeInbox(ctx(tenantId), watched.id, dupla.id, cw, appDb);
    await bindInbox(ctx(tenantId), answered.id, dupla.id, cw, appDb);
    const botRow = await suDb.chatwootAgentBot.findFirstOrThrow({
      where: { tenantId, chatwootInstanceId: instanceId, agentId: dupla.id },
      select: { chatwootAgentBotId: true },
    });
    expect(answering.get(answered.chatwootInboxId)).toBe(
      botRow.chatwootAgentBotId,
    );

    // The bot deleted out of band takes BOTH attachments with it.
    observing.clear();
    answering.clear();
    const healed = fakeChatwoot({
      observerRoute: true,
      observing,
      answering,
      deletedBots: new Set([botRow.chatwootAgentBotId]),
      firstBot: 90,
    });
    await observeInbox(ctx(tenantId), watched.id, dupla.id, healed, appDb);
    const newBot = await suDb.chatwootAgentBot.findFirstOrThrow({
      where: { tenantId, chatwootInstanceId: instanceId, agentId: dupla.id },
      select: { chatwootAgentBotId: true },
    });
    expect(newBot.chatwootAgentBotId).not.toBe(botRow.chatwootAgentBotId);
    expect(observing).toEqual(
      new Set([`${watched.chatwootInboxId}:${newBot.chatwootAgentBotId}`]),
    );
    // The one the reconcile would otherwise have gone on calling active.
    expect(answering.get(answered.chatwootInboxId)).toBe(
      newBot.chatwootAgentBotId,
    );

    await unobserveInbox(ctx(tenantId), watched.id, dupla.id, healed, appDb);
    await bindInbox(ctx(tenantId), answered.id, null, healed, appDb);
  });

  // THE RETIRING DETACH IS POST-COMMIT AND OUTSIDE EVERY LOCK, so the pair it retired can be
  // OBSERVING AGAIN by the time it reaches Chatwoot: bind A as responder (retiring its observer
  // row), bind somebody else, observe A again — all three can commit while this call is in flight.
  // The stale DELETE would then take away the NEW, valid attachment, and what it leaves is worse
  // than what it repairs: a committed observer row that bot-status reports active while Chatwoot
  // delivers it nothing, invisible to a reconcile that asks whether the BOT exists.
  test("a retiring detach re-reads the binding and skips one that stands again", async () => {
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: `Retomada ${process.pid}`,
        systemPrompt: "…",
        modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
        enabled: true,
        mode: "monitoring",
      },
      select: { id: true },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: OTHER_INBOX_ID + 47,
        name: "Retomada",
      },
      select: { id: true, chatwootInboxId: true },
    });
    const observing = new Set<string>();
    const cw = fakeChatwoot({ observerRoute: true, observing });
    await observeInbox(ctx(tenantId), inbox.id, agent.id, cw, appDb);
    const attached = new Set(observing);
    expect(attached.size).toBe(1);

    // The whole interleaving, staged rather than raced. `bindInbox` REFUSES an agent that already
    // observes the inbox, so the retire path is only reachable when the observe commits after that
    // check: the row is removed before it runs and put back straight after, which is the window the
    // refusal cannot see. The transaction then retires that row, and the re-observe lands once more
    // between the commit and the detach — staged on the recheck's own read, the statement whose
    // answer the fix depends on.
    await suDb.inboxObserver.deleteMany({ where: { inboxId: inbox.id } });
    const reObserve = () =>
      suDb.inboxObserver.create({
        data: { tenantId, inboxId: inbox.id, agentId: agent.id },
      });
    let passedCheck = false;
    let staged = false;
    // biome-ignore lint/suspicious/noExplicitAny: proxying Prisma's client surface
    const wrap = (target: any): any =>
      new Proxy(target, {
        get(t, prop, recv) {
          if (prop === "$extends")
            return (...a: unknown[]) => wrap(t.$extends(...a));
          if (prop === "$transaction")
            return (fn: (tx: unknown) => unknown, ...rest: unknown[]) =>
              t.$transaction((tx: unknown) => fn(wrap(tx)), ...rest);
          if (prop !== "inboxObserver") return Reflect.get(t, prop, recv);
          const delegate = Reflect.get(t, prop, recv);
          return new Proxy(delegate, {
            get(d, k, r) {
              const inner = Reflect.get(d, k, r);
              const call = (args: unknown) =>
                (inner as (a: unknown) => Promise<unknown>).call(d, args);
              // The pre-check: answer it honestly (no row), then let the observe commit.
              if (k === "findFirst")
                return async (args: unknown) => {
                  const res = await call(args);
                  if (!passedCheck) {
                    passedCheck = true;
                    await reObserve();
                  }
                  return res;
                };
              // The post-commit recheck: the re-observe lands just before it.
              if (k === "count")
                return async (args: unknown) => {
                  if (!staged) {
                    staged = true;
                    await reObserve();
                  }
                  return call(args);
                };
              return inner;
            },
          });
        },
      });

    try {
      await bindInbox(
        ctx(tenantId),
        inbox.id,
        agent.id,
        cw,
        wrap(appDb) as PrismaClient,
      );
      // The attachment the re-observe depends on is still on Chatwoot.
      expect(observing).toEqual(attached);
      expect(await observerRows(inbox.id)).toEqual([{ agentId: agent.id }]);
    } finally {
      await suDb.inboxObserver.deleteMany({ where: { inboxId: inbox.id } });
      await suDb.inbox.delete({ where: { id: inbox.id } });
      await suDb.agent.delete({ where: { id: agent.id } });
    }
  });

  // THE REPAIR TRAVELS WITH THE REPLACEMENT, whichever call makes it (issue #476 review, round 29).
  // A RECONNECT on the inbox this persona answers replaces the shared bot exactly as an observe
  // does, and the inbox it WATCHES went down with the old one.
  test("reconnecting the answered inbox puts the replaced bot back on the watched one", async () => {
    const ambos = await suDb.agent.create({
      data: { tenantId, name: "Ambos", systemPrompt: "x", mode: "monitoring" },
      select: { id: true },
    });
    const watched = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: OTHER_INBOX_ID + 40,
        name: "Vigiada",
      },
      select: { id: true, chatwootInboxId: true },
    });
    const answered = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: OTHER_INBOX_ID + 41,
        name: "Atendida",
      },
      select: { id: true, chatwootInboxId: true },
    });
    const observing = new Set<string>();
    const answering = new Map<number, number>();
    const cw = fakeChatwoot({ observerRoute: true, observing, answering });
    await observeInbox(ctx(tenantId), watched.id, ambos.id, cw, appDb);
    await bindInbox(ctx(tenantId), answered.id, ambos.id, cw, appDb);
    const botRow = await suDb.chatwootAgentBot.findFirstOrThrow({
      where: { tenantId, chatwootInstanceId: instanceId, agentId: ambos.id },
      select: { chatwootAgentBotId: true },
    });

    observing.clear();
    answering.clear();
    const healed = fakeChatwoot({
      observerRoute: true,
      observing,
      answering,
      deletedBots: new Set([botRow.chatwootAgentBotId]),
      firstBot: 100,
    });
    // The Reconnect the console offers for the ANSWERED inbox — not an observe at all.
    await reconnectInbox(ctx(tenantId), answered.id, healed, appDb);
    const newBot = await suDb.chatwootAgentBot.findFirstOrThrow({
      where: { tenantId, chatwootInstanceId: instanceId, agentId: ambos.id },
      select: { chatwootAgentBotId: true },
    });
    expect(newBot.chatwootAgentBotId).not.toBe(botRow.chatwootAgentBotId);
    expect(answering.get(answered.chatwootInboxId)).toBe(
      newBot.chatwootAgentBotId,
    );
    // The one the reconcile would otherwise have gone on calling active.
    expect(observing).toEqual(
      new Set([`${watched.chatwootInboxId}:${newBot.chatwootAgentBotId}`]),
    );

    await unobserveInbox(ctx(tenantId), watched.id, ambos.id, healed, appDb);
    await bindInbox(ctx(tenantId), answered.id, null, healed, appDb);
  });

  // A REATTACHMENT THAT FAILED IS REPAIRABLE (issue #476 review, round 30). Gated on the bot id
  // having changed, the propagation is a one-shot: the retry finds the row already carrying the new
  // id and reattaches nothing, so the operator's second click would be a no-op on the very inbox the
  // first one missed. The reconnect re-asserts every attachment whether or not the bot needed
  // replacing, which is what makes the repair reachable.
  test("a reconnect re-asserts the persona's other attachments even when the bot did not change", async () => {
    const persona = await suDb.agent.create({
      data: {
        tenantId,
        name: "Persona",
        systemPrompt: "x",
        mode: "monitoring",
      },
      select: { id: true },
    });
    const watched = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: OTHER_INBOX_ID + 50,
        name: "Vigiada R",
      },
      select: { id: true, chatwootInboxId: true },
    });
    const answered = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: OTHER_INBOX_ID + 51,
        name: "Atendida R",
      },
      select: { id: true, chatwootInboxId: true },
    });
    const observing = new Set<string>();
    const answering = new Map<number, number>();
    const cw = fakeChatwoot({ observerRoute: true, observing, answering });
    await observeInbox(ctx(tenantId), watched.id, persona.id, cw, appDb);
    await bindInbox(ctx(tenantId), answered.id, persona.id, cw, appDb);
    const bot = await suDb.chatwootAgentBot.findFirstOrThrow({
      where: { tenantId, chatwootInstanceId: instanceId, agentId: persona.id },
      select: { chatwootAgentBotId: true },
    });

    // The bot is alive, so nothing is replaced — and the watched inbox's attachment is missing
    // anyway, which is the state a reattachment that failed leaves behind.
    observing.clear();
    await reconnectInbox(ctx(tenantId), answered.id, cw, appDb);
    expect(
      await suDb.chatwootAgentBot.count({
        where: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: persona.id,
          chatwootAgentBotId: bot.chatwootAgentBotId,
        },
      }),
    ).toBe(1);
    expect(observing).toEqual(
      new Set([`${watched.chatwootInboxId}:${bot.chatwootAgentBotId}`]),
    );

    await unobserveInbox(ctx(tenantId), watched.id, persona.id, cw, appDb);
    await bindInbox(ctx(tenantId), answered.id, null, cw, appDb);
  });

  // A STALE LIST MAY NOT UNDO A REMOVAL (issue #476 review, round 30). The lists the propagation
  // reads are one round trip old by the time the loop reaches the last of them, and an unobserve
  // that completed in that window would otherwise be undone here — leaving Chatwoot with an
  // attachment no row records, which is a removed observer still receiving every event.
  test("a binding removed while the propagation runs is not reattached", async () => {
    const fugaz = await suDb.agent.create({
      data: { tenantId, name: "Fugaz", systemPrompt: "x", mode: "monitoring" },
      select: { id: true },
    });
    const bound = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: OTHER_INBOX_ID + 60,
        name: "Fugaz atendida",
      },
      select: { id: true, chatwootInboxId: true },
    });
    // Two watched inboxes, in id order: the first one's reattach is the window the second's removal
    // lands in.
    const first = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: OTHER_INBOX_ID + 61,
        name: "Fugaz 1",
      },
      select: { id: true, chatwootInboxId: true },
    });
    const second = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: OTHER_INBOX_ID + 62,
        name: "Fugaz 2",
      },
      select: { id: true, chatwootInboxId: true },
    });
    const observing = new Set<string>();
    const setup = fakeChatwoot({ observerRoute: true, observing });
    await bindInbox(ctx(tenantId), bound.id, fugaz.id, setup, appDb);
    await observeInbox(ctx(tenantId), first.id, fugaz.id, setup, appDb);
    await observeInbox(ctx(tenantId), second.id, fugaz.id, setup, appDb);

    observing.clear();
    const cw = fakeChatwoot({
      observerRoute: true,
      observing,
      onAttach: async () => {
        // The unobserve of the SECOND one completing inside the first one's reattach.
        await suDb.inboxObserver.deleteMany({ where: { inboxId: second.id } });
      },
    });
    // The repair path, which re-asserts every attachment of this persona.
    await reconnectInbox(ctx(tenantId), bound.id, cw, appDb);
    expect(
      [...observing].filter((k) => k.startsWith(`${first.chatwootInboxId}:`))
        .length,
    ).toBe(1);
    // Re-read before its own call, so the row that went in the window is not put back.
    expect(
      [...observing].filter((k) => k.startsWith(`${second.chatwootInboxId}:`))
        .length,
    ).toBe(0);

    await unobserveInbox(ctx(tenantId), first.id, fugaz.id, cw, appDb);
    await bindInbox(ctx(tenantId), bound.id, null, cw, appDb);
  });

  // A COMPENSATION MAY NOT PULL WHAT A COMMITTED ROW DEPENDS ON (issue #476 review, round 29). Two
  // first-time observes of the same pair share one idempotent attachment upstream; if one commits
  // and the other then fails, the loser's rollback would strip the winner's.
  test("a failed observe leaves the attachment a row committed meanwhile depends on", async () => {
    const vigia = await suDb.agent.create({
      data: {
        tenantId,
        name: "Vigia C",
        systemPrompt: "x",
        mode: "monitoring",
      },
      select: { id: true },
    });
    const spare = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: OTHER_INBOX_ID + 42,
        name: "Concorrida",
      },
      select: { id: true, chatwootInboxId: true },
    });
    const observing = new Set<string>();
    const cw = fakeChatwoot({
      observerRoute: true,
      observing,
      onAttach: async () => {
        // The other call's row, committed while this one's attach is in flight. Written directly:
        // what is under test is the compensation, not a second observe's own path.
        await suDb.inboxObserver.upsert({
          where: { tenantId_inboxId: { tenantId, inboxId: spare.id } },
          create: { tenantId, inboxId: spare.id, agentId: vigia.id },
          update: {},
        });
        // ...and then this call fails to persist.
        await softDisconnectChatwootInstance(ctx(tenantId), instanceId, appDb);
      },
    });
    try {
      await expect(
        observeInbox(ctx(tenantId), spare.id, vigia.id, cw, appDb),
      ).rejects.toMatchObject({ statusCode: 409 });
      // The attachment stands, because the committed row needs it.
      expect(observing.size).toBe(1);
    } finally {
      // The disconnect above is account-wide: every test after this one reads it.
      await reconnectChatwootInstance(ctx(tenantId), instanceId, appDb);
      await suDb.inboxObserver.deleteMany({ where: { inboxId: spare.id } });
    }
  });

  test("a re-submitted observe whose answer is lost leaves the attachment it did not create", async () => {
    const observing = new Set<string>();
    const cw = fakeChatwoot({ observerRoute: true, observing });
    await observeInbox(ctx(tenantId), inboxRowId, monitoringAgent, cw, appDb);
    expect(observing.size).toBe(1);

    const lost = fakeChatwoot({
      observerRoute: true,
      observing,
      onAttach: async () => {
        throw new Error("socket hang up");
      },
    });
    await expect(
      observeInbox(ctx(tenantId), inboxRowId, monitoringAgent, lost, appDb),
    ).rejects.toMatchObject({ statusCode: 502 });
    // The rollback takes back what THIS call attached, and this call attached nothing.
    expect(observing.size).toBe(1);
    expect((await observerRows(inboxRowId)).length).toBe(1);
  });

  // A RE-OBSERVE that meets a disconnect must leave the binding it found: the disconnect keeps the
  // observers it finds, and stripping one here would leave the console reporting a watcher that
  // receives nothing (the reconcile asks whether the BOT exists, not whether it is attached).
  test("a re-observe refused by a disconnect leaves the attachment it found", async () => {
    const observing = new Set<string>();
    const cw0 = fakeChatwoot({ observerRoute: true, observing });
    await observeInbox(ctx(tenantId), inboxRowId, monitoringAgent, cw0, appDb);
    expect(observing.size).toBe(1);

    const cw = fakeChatwoot({
      observerRoute: true,
      observing,
      onAttach: async () => {
        await softDisconnectChatwootInstance(
          ctx(tenantId),
          instanceId,
          appDb,
          cw,
        );
      },
    });
    await expect(
      observeInbox(ctx(tenantId), inboxRowId, monitoringAgent, cw, appDb),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(observing.size).toBe(1);
    expect((await observerRows(inboxRowId)).length).toBe(1);

    await reconnectChatwootInstance(ctx(tenantId), instanceId, appDb);
  });

  test("an inbox takes ONE watcher: a second agent is refused, and its attachment taken back", async () => {
    const second = await suDb.agent.create({
      data: {
        tenantId,
        name: "Segunda observadora",
        systemPrompt: "x",
        mode: "monitoring",
      },
      select: { id: true },
    });
    const observing = new Set<string>();
    const cw = fakeChatwoot({ observerRoute: true, observing });
    await observeInbox(ctx(tenantId), inboxRowId, monitoringAgent, cw, appDb);
    expect(observing.size).toBe(1);

    await expect(
      observeInbox(ctx(tenantId), inboxRowId, second.id, cw, appDb),
    ).rejects.toMatchObject({
      statusCode: 422,
      translationKey: "errors.inboxAlreadyObserved",
    });
    expect((await observerRows(inboxRowId)).length).toBe(1);
    expect(observing.size).toBe(1);
  });

  test("the responder binding refuses an agent that observes the inbox, and observing refuses the responder", async () => {
    const cw = fakeChatwoot({ observerRoute: true, observing: new Set() });
    await suDb.inbox.update({
      where: { id: otherInboxRowId },
      data: { agentId: productionAgent },
    });
    await expect(
      observeInbox(ctx(tenantId), otherInboxRowId, productionAgent, cw, appDb),
    ).rejects.toMatchObject({ statusCode: 422 });
    await suDb.inbox.update({
      where: { id: otherInboxRowId },
      data: { agentId: null },
    });
    // The monitoring agent observes `otherInbox` since the previous case; binding it as the
    // responder THERE is refused. Elsewhere it may be the responder: bound, it reads everything
    // and answers nothing — the mode an operator flips a bound agent into (#209's first rung) —
    // so the observer binding is not the only door for it.
    await expect(
      bindInbox(ctx(tenantId), otherInboxRowId, monitoringAgent, cw, appDb),
    ).rejects.toMatchObject({ statusCode: 422 });
    const elsewhere = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 96,
        name: "Vendas",
      },
    });
    const bound = await bindInbox(
      ctx(tenantId),
      elsewhere.id,
      monitoringAgent,
      cw,
      appDb,
    );
    expect(bound.agentId).toBe(String(monitoringAgent));
    expect(cw.calls.some((c) => c.path.endsWith("/set_agent_bot"))).toBe(true);
    const unbound = await bindInbox(
      ctx(tenantId),
      elsewhere.id,
      null,
      cw,
      appDb,
    );
    expect(unbound.agentId).toBeNull();
  });

  test("a Chatwoot without the observer route is reported as such, and nothing is recorded", async () => {
    const cw = fakeChatwoot({ observerRoute: false, observing: new Set() });
    const third = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 93,
        name: "Suporte",
      },
    });
    let caught: unknown;
    try {
      await observeInbox(ctx(tenantId), third.id, monitoringAgent, cw, appDb);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).statusCode).toBe(502);
    expect((caught as AppError).translationKey).toBe(
      "errors.chatwootObserverUnsupported",
    );
    // The inbox was asked before the route was blamed, and the row written ahead of the attach
    // went with the refusal.
    expect(
      cw.calls.some(
        (c) => c.method === "GET" && c.path.endsWith("/inboxes/93"),
      ),
    ).toBe(true);
    expect(await observerRows(third.id)).toEqual([]);
  });

  test("an inbox gone upstream is reported as gone, not as a Chatwoot without the route", async () => {
    const stale = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 94,
        name: "Apagada",
      },
    });
    const cw = fakeChatwoot({
      observerRoute: true,
      observing: new Set(),
      gone: new Set([94]),
    });
    let caught: unknown;
    try {
      await observeInbox(ctx(tenantId), stale.id, monitoringAgent, cw, appDb);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).statusCode).toBe(404);
    expect((caught as AppError).translationKey).toBe("errors.inboxGoneRemote");
    expect(await observerRows(stale.id)).toEqual([]);
  });

  test("unobserving detaches the bot and forgets the row; a bot Chatwoot no longer lists as observing is already the state asked for", async () => {
    const observing = new Set<string>([`${INBOX_ID}:71`]);
    const cw = fakeChatwoot({ observerRoute: true, observing });
    const dto = await unobserveInbox(
      ctx(tenantId),
      inboxRowId,
      monitoringAgent,
      cw,
      appDb,
    );
    expect(dto.observerAgentIds).toEqual([]);
    const detached = cw.calls.filter((c) => c.method === "DELETE");
    expect(detached.length).toBe(1);
    expect(
      detached[0]?.path.endsWith(`/inboxes/${INBOX_ID}/agent_bot_observers/71`),
    ).toBe(true);
    expect(observing.size).toBe(0);
    expect(await observerRows(inboxRowId)).toEqual([]);

    // Not observing any more: the fork is asked again all the same (its 404 is the state asked
    // for), the row records nothing, and the inbox is answered — an attachment no row names is one
    // unobserve away.
    const asked = cw.calls.filter((c) => c.method === "DELETE").length;
    const audits = await suDb.auditLog.count({
      where: {
        tenantId,
        action: "inbox.unobserve",
        target: `inbox:${inboxRowId}`,
      },
    });
    const again = await unobserveInbox(
      ctx(tenantId),
      inboxRowId,
      monitoringAgent,
      cw,
      appDb,
    );
    expect(again.observerAgentIds).toEqual([]);
    expect(cw.calls.filter((c) => c.method === "DELETE").length).toBe(
      asked + 1,
    );
    expect(
      await suDb.auditLog.count({
        where: {
          tenantId,
          action: "inbox.unobserve",
          target: `inbox:${inboxRowId}`,
        },
      }),
    ).toBe(audits);

    // Detached out of band on Chatwoot (its DELETE answers 404): the local row still clears.
    expect((await observerRows(otherInboxRowId)).length).toBe(1);
    const gone = await unobserveInbox(
      ctx(tenantId),
      otherInboxRowId,
      monitoringAgent,
      cw,
      appDb,
    );
    expect(gone.observerAgentIds).toEqual([]);
  });

  test("an account disconnected while the attach is in flight: the attach is taken back too", async () => {
    const observing = new Set<string>();
    const cw = fakeChatwoot({
      observerRoute: true,
      observing,
      onAttach: async () => {
        // The disconnect lands between the remote attach and the row: it refuses this observe, and
        // deliberately keeps the observers it finds — so an attachment no row names would survive it.
        await softDisconnectChatwootInstance(
          ctx(tenantId),
          instanceId,
          appDb,
          cw,
        );
      },
    });
    await expect(
      observeInbox(ctx(tenantId), inboxRowId, monitoringAgent, cw, appDb),
    ).rejects.toMatchObject({
      statusCode: 409,
      translationKey: "errors.chatwootAccountDisconnected",
    });
    expect(observing.size).toBe(0);
    expect((await observerRows(inboxRowId)).length).toBe(0);

    await reconnectChatwootInstance(ctx(tenantId), instanceId, appDb);
  });

  // The disconnect unbinds every RESPONDER and detaches its bot, because a bot left on an inbox
  // owns every conversation that starts there. An observer owns nothing, so there is nothing to
  // hand back: the disconnect leaves it where Chatwoot has it, the webhook ignores the account
  // either way, and a reconnect finds it observing without a second attach.
  test("a disconnect leaves the observers where Chatwoot has them, and a reconnect finds them there", async () => {
    const observing = new Set<string>();
    const cw = fakeChatwoot({ observerRoute: true, observing });
    await observeInbox(ctx(tenantId), inboxRowId, monitoringAgent, cw, appDb);
    expect(observing.size).toBe(1);
    const before = cw.calls.length;

    expect(
      await softDisconnectChatwootInstance(
        ctx(tenantId),
        instanceId,
        appDb,
        cw,
      ),
    ).toBe(true);
    expect((await observerRows(inboxRowId)).length).toBe(1);
    expect(observing.size).toBe(1);
    expect(
      cw.calls
        .slice(before)
        .filter((c) => c.path.includes("agent_bot_observers")),
    ).toEqual([]);

    await reconnectChatwootInstance(ctx(tenantId), instanceId, appDb);
    expect((await observerRows(inboxRowId)).length).toBe(1);
    expect(
      cw.calls
        .slice(before)
        .filter((c) => c.path.includes("agent_bot_observers")),
    ).toEqual([]);
  });
});
