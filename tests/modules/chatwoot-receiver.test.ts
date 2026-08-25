import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { loadChatwootClient } from "@/modules/chatwoot/instance";
import { mirrorChatwootEvent } from "@/modules/chatwoot/mirror";
import {
  heldByAnotherParty,
  normalizeChatwootEvent,
  shouldBotHandle,
} from "@/modules/chatwoot/normalize";
import { ensureAgentBot } from "@/modules/chatwoot/provisioning";
import {
  invalidateRouteTokenCache,
  noteRouteTokenLookup,
  ROUTE_TOKEN_CACHE_TTL_MS,
  ROUTE_TOKEN_REFRESH_WAIT_MS,
  writeRouteTokenCache,
} from "@/modules/chatwoot/route-token-cache";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import {
  outOfHoursGate,
  receiveChatwootWebhook,
  recordAndProcessChatwootDelivery,
} from "@/modules/chatwoot/webhook";
import {
  CHATWOOT_WEBHOOK_MOUNT,
  chatwootOutgoingUrl,
} from "@/modules/chatwoot/webhook-mount";
import {
  generateRouteToken,
  hashRouteToken,
} from "@/modules/webhooks/inbound/route-token";
import { seedChatwootInstance, withRunNamespace } from "../utils/chatwoot";

// ── mount constant + outgoing_url derivation (unit) ──
describe("chatwoot webhook mount", () => {
  test("the mount constant is the canonical receiver path", () => {
    expect(CHATWOOT_WEBHOOK_MOUNT).toBe("/api/v1/chatwoot/webhook");
  });
  test("outgoing_url derives from the mount constant; trailing slash trimmed", () => {
    expect(chatwootOutgoingUrl("http://localhost:3000", "tok")).toBe(
      "http://localhost:3000/api/v1/chatwoot/webhook/tok",
    );
    expect(chatwootOutgoingUrl("https://x/", "tok")).toBe(
      "https://x/api/v1/chatwoot/webhook/tok",
    );
  });
});

// ── reactive availability gate (unit) ──
describe("outOfHoursGate", () => {
  // Mon 09:00-17:00 UTC. 2024-01-08 is a Monday; 2024-01-07 a Sunday → fixed instants, no real clock.
  const HOURS = {
    windows: [{ day: 1, start: "09:00", end: "17:00" }],
    exceptions: [],
    timezone: "UTC",
  };
  const MON_MIDDAY = new Date("2024-01-08T12:00:00Z"); // open
  const MON_NIGHT = new Date("2024-01-08T20:00:00Z"); // closed
  const SUNDAY = new Date("2024-01-07T12:00:00Z"); // closed (no Sunday window)

  test("no schedule / empty windows → always on (never silenced)", () => {
    expect(outOfHoursGate(null, MON_NIGHT, false)).toEqual({
      silence: false,
      postNote: false,
    });
    expect(
      outOfHoursGate(
        { windows: [], exceptions: [], timezone: "UTC" },
        MON_NIGHT,
        false,
      ),
    ).toEqual({ silence: false, postNote: false });
  });

  test("inside the window → responds (no silence, no note)", () => {
    expect(outOfHoursGate(HOURS, MON_MIDDAY, false)).toEqual({
      silence: false,
      postNote: false,
    });
  });

  test("outside the window, notice not yet sent → silence + post the one-shot note", () => {
    expect(outOfHoursGate(HOURS, MON_NIGHT, false)).toEqual({
      silence: true,
      postNote: true,
    });
    expect(outOfHoursGate(HOURS, SUNDAY, false)).toEqual({
      silence: true,
      postNote: true,
    });
  });

  test("outside the window, notice already sent → silence WITHOUT re-posting (anti-spam)", () => {
    expect(outOfHoursGate(HOURS, MON_NIGHT, true)).toEqual({
      silence: true,
      postNote: false,
    });
  });
});

// ── attribution gate with bot identity (unit) ──
// The assignee half on its own, because the console asks it WITHOUT the status clause: which
// ownership action to offer is a question about who holds the conversation, and `pending` is both the
// AI's own state and the state a takeover leaves behind.
describe("heldByAnotherParty", () => {
  test("nobody, or our own bot, is not another party", () => {
    expect(
      heldByAnotherParty({ assigneeType: null }, { ourAgentBotId: 9 }),
    ).toBe(false);
    expect(
      heldByAnotherParty(
        { assigneeType: "AgentBot", assigneeId: 9 },
        { ourAgentBotId: 9 },
      ),
    ).toBe(false);
  });
  // The case a browser-side `assigneeType === "User"` test reads backwards, and the reason this is
  // resolved server-side at all: the inbox's own agent cannot answer here either, so the console has
  // to offer the hand-back rather than "handoff to human".
  test("a DIFFERENT AgentBot is another party", () => {
    expect(
      heldByAnotherParty(
        { assigneeType: "AgentBot", assigneeId: 7 },
        { ourAgentBotId: 9 },
      ),
    ).toBe(true);
  });
  test("a human is another party, and an unknown bot id is not", () => {
    expect(
      heldByAnotherParty(
        { assigneeType: "User", assigneeId: 1 },
        { ourAgentBotId: 9 },
      ),
    ).toBe(true);
    // Same direction shouldBotHandle takes: an id we cannot compare is not evidence of a stranger.
    expect(
      heldByAnotherParty(
        { assigneeType: "AgentBot", assigneeId: null },
        { ourAgentBotId: 9 },
      ),
    ).toBe(false);
  });
  // Status is deliberately absent: a resolved conversation nobody holds must not read as held.
  test("a resolved conversation with no assignee is nobody's", () => {
    expect(heldByAnotherParty({ assigneeType: null })).toBe(false);
  });
});

describe("shouldBotHandle with ourAgentBotId", () => {
  test("acts when unassigned or assigned to our own bot", () => {
    expect(
      shouldBotHandle(
        { assigneeType: null, status: "pending" },
        { ourAgentBotId: 9 },
      ),
    ).toBe(true);
    expect(
      shouldBotHandle(
        { assigneeType: "AgentBot", status: "pending", assigneeId: 9 },
        { ourAgentBotId: 9 },
      ),
    ).toBe(true);
  });
  test("stays silent when a DIFFERENT AgentBot owns the conversation", () => {
    expect(
      shouldBotHandle(
        { assigneeType: "AgentBot", status: "pending", assigneeId: 7 },
        { ourAgentBotId: 9 },
      ),
    ).toBe(false);
  });
  test("does not exclude when the assignee bot id is unknown", () => {
    expect(
      shouldBotHandle(
        { assigneeType: "AgentBot", status: "pending", assigneeId: null },
        { ourAgentBotId: 9 },
      ),
    ).toBe(true);
  });
  test("a human assignee still silences regardless of bot id", () => {
    expect(
      shouldBotHandle(
        { assigneeType: "User", status: "pending", assigneeId: 1 },
        { ourAgentBotId: 9 },
      ),
    ).toBe(false);
  });
});

// The table above proves the FUNCTION. It cannot prove that the callers ask it the question they
// think they are asking, and that is where this defect lived: `ourAgentBotId` alone does not buy the
// strict gate, because the exclusion branch also needs `assigneeId` to compare against. Hand it only
// half the pair and it degrades, silently, into the loose attribution-only gate — every AgentBot
// reads as ours. Three call sites shipped that way (issue #210).
//
// So the rule is per call site, and it is read off the source rather than restated here: any call
// that asks "is it OURS" must also supply the id that answers it. The other half — that the scoped
// SELECT feeding the literal actually carries the column — needs no assertion, because a missing
// `assigneeId` on a Prisma select makes the property access a type error.
describe("every strict ownership check is given the id it compares", () => {
  const FILES = [
    "src/graph/nudge.ts",
    "src/graph/runtime.ts",
    "src/modules/chatwoot/webhook.ts",
    "src/modules/conversations/reengage.ts",
    "src/modules/debounce/handler.ts",
    "src/modules/followups/eligibility.ts",
  ];

  // Walks the argument list instead of matching it: a regex over the call would read whichever
  // `assigneeId` happens to sit nearby (the SELECT above it, the next call) and pass on a site that
  // never received one.
  function callsIn(src: string): Array<{ state: string; opts: string }> {
    const out: Array<{ state: string; opts: string }> = [];
    const NAME = "shouldBotHandle(";
    for (
      let at = src.indexOf(NAME);
      at !== -1;
      at = src.indexOf(NAME, at + 1)
    ) {
      // NOTE: An import or a mention in prose is not a call.
      if (/[.\w]/.test(src[at - 1] ?? "")) continue;
      let depth = 0;
      let i = at + NAME.length - 1;
      const args: string[] = [];
      let start = i + 1;
      for (; i < src.length; i++) {
        const c = src[i];
        if (c === "(" || c === "{" || c === "[") depth++;
        else if (c === ")" || c === "}" || c === "]") {
          depth--;
          if (depth === 0) {
            args.push(src.slice(start, i));
            break;
          }
        } else if (c === "," && depth === 1) {
          args.push(src.slice(start, i));
          start = i + 1;
        }
      }
      out.push({ state: args[0] ?? "", opts: args[1] ?? "" });
    }
    return out;
  }

  const sites = FILES.flatMap((file) =>
    callsIn(readFileSync(file, "utf8")).map((c, i) => ({
      ...c,
      where: `${file} #${i + 1}`,
    })),
  );
  const strict = sites.filter((c) => /\bourAgentBotId\b/.test(c.opts));

  // NOTE: A parser that finds nothing would report every rule as satisfied, so pin the shape of
  // what it found: the loose call in `eligibility.ts` is the one site that deliberately asks the
  // other question, and it has to survive the filter as evidence that the filter discriminates.
  test("the source walk finds the calls it is meant to police", () => {
    expect(sites.length).toBeGreaterThanOrEqual(8);
    expect(strict.length).toBeGreaterThanOrEqual(7);
    expect(sites.length - strict.length).toBeGreaterThanOrEqual(1);
  });

  test.each(strict.map((c) => [c.where, c.state] as const))(
    "%s passes assigneeId",
    (_where, state) => {
      expect(state).toMatch(/\bassigneeId\b/);
    },
  );
});

// ── receiver pipeline (real DB) ──
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

const SECRET = "bot-webhook-secret";
const NOW = 1_700_000_000;
const sign = (ts: number, body: string) =>
  `sha256=${createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex")}`;
const headersFrom = (h: Record<string, string>) => (name: string) =>
  h[name.toLowerCase()] ?? null;
const signedHeaders = (body: string, ts = NOW, delivery = "uuid-1") =>
  headersFrom({
    "x-chatwoot-signature": sign(ts, body),
    "x-chatwoot-timestamp": String(ts),
    "x-chatwoot-delivery": delivery,
  });

let tenantId = 0n;
let instanceId = 0n;
let routeToken = "";

describe.skipIf(!dbUp)("chatwoot webhook receiver", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "CW", slug: `cw-${process.pid}` },
    });
    tenantId = t.id;
    const { token, hash } = generateRouteToken();
    routeToken = token;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 1,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const agent = await suDb.agent.create({
      data: { tenantId, name: "Atendente", systemPrompt: "x" },
    });
    // The route token now resolves a per-persona Agent Bot (id 9), not the instance.
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: 9,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson(SECRET),
        webhookRouteTokenHash: hash,
        name: "Atendente",
      },
    });
  });

  test("rejects an unknown route token with 401", async () => {
    await expect(
      receiveChatwootWebhook({
        routeToken: "not-a-real-token",
        rawBody: "{}",
        getHeader: () => null,
        base: appDb,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  test("rejects an invalid HMAC signature with 401 (uniform)", async () => {
    const body = JSON.stringify({ event: "conversation_updated", id: 1 });
    await expect(
      receiveChatwootWebhook({
        routeToken,
        rawBody: body,
        getHeader: headersFrom({
          "x-chatwoot-signature": "sha256=deadbeef",
          "x-chatwoot-timestamp": String(NOW),
          "x-chatwoot-delivery": "uuid-bad",
        }),
        nowSeconds: NOW,
        base: appDb,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  test("queues a signed event and processes it to PROCESSED", async () => {
    const body = JSON.stringify({
      event: "message_created",
      id: 1001,
      content: "olá",
      message_type: "incoming",
      private: false,
      conversation: {
        id: 42,
        inbox_id: 7,
        status: "pending",
        meta: { assignee_type: null, assignee: null },
      },
    });
    const r = await receiveChatwootWebhook({
      routeToken,
      rawBody: body,
      getHeader: signedHeaders(body, NOW, "uuid-ok"),
      nowSeconds: NOW,
      base: appDb,
    });
    expect(r.outcome).toBe("queued");
    expect(r.tenantId).toBe(tenantId);
    expect(r.agentBotId).toBe(9);
    expect(r.normalized?.conversationId).toBe(42);

    const proc = await recordAndProcessChatwootDelivery({
      tenantId,
      instanceId: r.instanceId as bigint,
      deliveryId: r.deliveryId as string,
      agentBotId: r.agentBotId ?? null,
      normalized: r.normalized as NonNullable<typeof r.normalized>,
      base: appDb,
    });
    expect(proc).toBe("processed");

    const row = await suDb.chatwootWebhookDelivery.findFirstOrThrow({
      where: { chatwootInstanceId: instanceId, deliveryId: "uuid-ok" },
    });
    expect(row.status).toBe("PROCESSED");
    expect(row.processedAt).not.toBeNull();
    expect(row.event).toBe("message_created");

    // Mirror: the conversation was upserted with status + inbox FK + thread key.
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 42 },
      include: { inbox: true },
    });
    expect(conv.status).toBe("pending");
    expect(conv.threadId).toBe(`${tenantId}:${instanceId}:42`);
    expect(conv.inbox?.chatwootInboxId).toBe(7);
  });

  test("is idempotent on the delivery UUID (duplicate, single row, safe reprocess)", async () => {
    const body = JSON.stringify({
      event: "conversation_updated",
      id: 43,
      inbox_id: 7,
      status: "pending",
      meta: { assignee_type: "AgentBot", assignee: { id: 9 } },
    });
    const headers = signedHeaders(body, NOW, "uuid-dup");
    const first = await receiveChatwootWebhook({
      routeToken,
      rawBody: body,
      getHeader: headers,
      nowSeconds: NOW,
      base: appDb,
    });
    const second = await receiveChatwootWebhook({
      routeToken,
      rawBody: body,
      getHeader: headers,
      nowSeconds: NOW,
      base: appDb,
    });
    // The ack writes nothing now, so BOTH deliveries are simply "received". Idempotency is asserted
    // where it actually lives: on the detached path, which every redelivery runs.
    expect(first.outcome).toBe("queued");
    expect(second.outcome).toBe("queued");
    expect(second.deliveryId).toBe(first.deliveryId as string);

    expect(
      await recordAndProcessChatwootDelivery({
        tenantId,
        instanceId: first.instanceId as bigint,
        deliveryId: first.deliveryId as string,
        agentBotId: first.agentBotId ?? null,
        normalized: first.normalized as NonNullable<typeof first.normalized>,
        base: appDb,
      }),
    ).toBe("processed");

    // Second run of the SAME delivery: the unique keeps one row and the CAS refuses the reprocess.
    expect(
      await recordAndProcessChatwootDelivery({
        tenantId,
        instanceId: second.instanceId as bigint,
        deliveryId: second.deliveryId as string,
        agentBotId: second.agentBotId ?? null,
        normalized: second.normalized as NonNullable<typeof second.normalized>,
        base: appDb,
      }),
    ).toBe("skipped");
  });

  // ── the ack's own budget (issue #225) ──

  test("the ack asks Postgres nothing once the route token is resolved", async () => {
    const body = JSON.stringify({
      event: "conversation_updated",
      id: 47,
      inbox_id: 7,
      status: "pending",
      meta: { assignee_type: "AgentBot", assignee: { id: 9 } },
    });
    // Warm the resolution the way real traffic does.
    await receiveChatwootWebhook({
      routeToken,
      rawBody: body,
      getHeader: signedHeaders(body, NOW, "uuid-warm"),
      nowSeconds: NOW,
      base: appDb,
    });

    // Chatwoot escalates the conversation when the ack is slow, and every query on this path is an
    // interactive transaction competing for a pool shared with turns, ingest and compaction. A base
    // that refuses to open one is the only assertion that actually pins "the ack does not wait on
    // the database": counting queries would still pass if they merely got faster.
    const refuses = {
      $transaction: () => {
        throw new Error("the ack path opened a transaction");
      },
      $extends: () => refuses,
    } as unknown as PrismaClient;

    const r = await receiveChatwootWebhook({
      routeToken,
      rawBody: body,
      getHeader: signedHeaders(body, NOW, "uuid-nodb"),
      nowSeconds: NOW,
      base: refuses,
    });
    expect(r.outcome).toBe("queued");
    expect(r.deliveryId).toBe("uuid-nodb");
    expect(r.normalized?.conversationId).toBe(47);
  });

  // The ack is already out when the detached half runs, so a throw in the ledger claim is not a
  // delivery Chatwoot retries: the upstream ladder is spent and the event simply never existed. The
  // failure it meets is the one this path is built around, a pool momentarily full, and that has to
  // cost latency rather than the turn.
  test("a pool blip on the ledger claim delays the delivery instead of losing it", async () => {
    const body = JSON.stringify({
      event: "conversation_updated",
      id: 52,
      inbox_id: 7,
      status: "pending",
      meta: { assignee_type: "AgentBot", assignee: { id: 9 } },
    });
    const r = await receiveChatwootWebhook({
      routeToken,
      rawBody: body,
      getHeader: signedHeaders(body, NOW, "uuid-blip"),
      nowSeconds: NOW,
      base: appDb,
    });

    // Two transactions fail the way an exhausted pool fails, then the pool recovers.
    let blips = 2;
    const wrap = (client: unknown): unknown =>
      new Proxy(client as object, {
        get(target, prop, recv) {
          if (prop === "$transaction") {
            const orig = Reflect.get(target, prop, recv) as (
              ...a: unknown[]
            ) => Promise<unknown>;
            return async (...args: unknown[]) => {
              if (blips-- > 0) {
                throw new Error(
                  "Timed out fetching a new connection from the connection pool",
                );
              }
              return orig.apply(target, args);
            };
          }
          if (prop === "$extends") {
            const orig = Reflect.get(target, prop, recv) as (
              ...a: unknown[]
            ) => unknown;
            return (...args: unknown[]) => wrap(orig.apply(target, args));
          }
          return Reflect.get(target, prop, recv);
        },
      });

    expect(
      await recordAndProcessChatwootDelivery({
        tenantId,
        instanceId: r.instanceId as bigint,
        deliveryId: r.deliveryId as string,
        agentBotId: r.agentBotId ?? null,
        normalized: r.normalized as NonNullable<typeof r.normalized>,
        base: wrap(appDb) as PrismaClient,
      }),
    ).toBe("processed");

    const row = await suDb.chatwootWebhookDelivery.findFirstOrThrow({
      where: { chatwootInstanceId: instanceId, deliveryId: "uuid-blip" },
    });
    expect(row.status).toBe("PROCESSED");
  });

  // The warm case above is the easy half. THE HARD HALF IS THE COLD ONE, and it is the common one:
  // the entry lives 30s, so an instance quieter than that is cold on every single message, and the
  // message that finds it cold is the first of a conversation, the one that starts the turn. If the
  // TTL meant a miss, this path would put an interactive transaction back inside the 5s budget on
  // exactly the traffic that cannot afford it.
  test("an entry past its TTL still acks without waiting on Postgres", async () => {
    const body = JSON.stringify({
      event: "conversation_updated",
      id: 51,
      inbox_id: 7,
      status: "pending",
      meta: { assignee_type: "AgentBot", assignee: { id: 9 } },
    });

    // Exactly the state of an instance that went quiet: resolved once, then nothing for longer than
    // the TTL. Back-dated rather than slept for, so the test is not a timer.
    invalidateRouteTokenCache();
    writeRouteTokenCache(
      hashRouteToken(routeToken),
      {
        tenantId,
        instanceId,
        agentBotId: 9,
        webhookSecret: encryptJson(SECRET),
      },
      { now: Date.now() - ROUTE_TOKEN_CACHE_TTL_MS - 1 },
    );

    const refuses = {
      $transaction: () => {
        throw new Error("the ack path opened a transaction");
      },
      $extends: () => refuses,
    } as unknown as PrismaClient;

    const r = await receiveChatwootWebhook({
      routeToken,
      rawBody: body,
      getHeader: signedHeaders(body, NOW, "uuid-cold"),
      nowSeconds: NOW,
      base: refuses,
    });
    expect(r.outcome).toBe("queued");
    expect(r.normalized?.conversationId).toBe(51);

    // THE REFRESH IT FIRED BEHIND THE ACK FAILED, AND THAT CHANGES THE NEXT ANSWER. A 200 is a
    // promise: Chatwoot does not retry a 2xx and the payload is not stored, so answering out of a
    // cache the database can no longer back loses the event in silence. The failed refresh has
    // already marked lookups unhealthy, so the next request takes the blocking path and fails
    // honestly, which is what puts the event back on Chatwoot's retry ladder.
    await expect(
      receiveChatwootWebhook({
        routeToken,
        rawBody: body,
        getHeader: signedHeaders(body, NOW, "uuid-cold-2"),
        nowSeconds: NOW,
        base: refuses,
      }),
    ).rejects.toThrow();

    // AND IT HAS TO COME BACK. `lookupHealthy` only ever flips false on its own, so without a
    // successful lookup restoring it, one transient blip would disable the shield for the lifetime
    // of the process and every cold ack after it would pay for a transaction again.
    invalidateRouteTokenCache();
    await receiveChatwootWebhook({
      routeToken,
      rawBody: body,
      getHeader: signedHeaders(body, NOW, "uuid-cold-heal"),
      nowSeconds: NOW,
      base: appDb,
    });
    writeRouteTokenCache(
      hashRouteToken(routeToken),
      {
        tenantId,
        instanceId,
        agentBotId: 9,
        webhookSecret: encryptJson(SECRET),
      },
      { now: Date.now() - ROUTE_TOKEN_CACHE_TTL_MS - 1 },
    );
    const healed = await receiveChatwootWebhook({
      routeToken,
      rawBody: body,
      getHeader: signedHeaders(body, NOW, "uuid-cold-3"),
      nowSeconds: NOW,
      base: refuses,
    });
    expect(healed.outcome).toBe("queued");

    invalidateRouteTokenCache();
    noteRouteTokenLookup(true);
  });

  // Q: what happens to the requests that arrive WHILE the refresh is deciding? They wait on it. On a
  // healthy database that costs a millisecond and saves a lookup, which is the burst the cache exists
  // to keep off Postgres; on a dead one it is the difference between one acked-and-lost event and all
  // of them, since Chatwoot never redelivers a 2xx.
  test("a request arriving during the refresh waits for it instead of looking up again", async () => {
    const body = JSON.stringify({
      event: "conversation_updated",
      id: 53,
      inbox_id: 7,
      status: "pending",
      meta: { assignee_type: "AgentBot", assignee: { id: 9 } },
    });

    invalidateRouteTokenCache();
    noteRouteTokenLookup(true);
    writeRouteTokenCache(
      hashRouteToken(routeToken),
      {
        tenantId,
        instanceId,
        agentBotId: 9,
        webhookSecret: encryptJson(SECRET),
      },
      { now: Date.now() - ROUTE_TOKEN_CACHE_TTL_MS - 1 },
    );

    // A real lookup, held open until released, so the window is a fact rather than a race.
    let lookups = 0;
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const wrap = (client: unknown): unknown =>
      new Proxy(client as object, {
        get(target, prop, recv) {
          if (prop === "$transaction") {
            const orig = Reflect.get(target, prop, recv) as (
              ...a: unknown[]
            ) => Promise<unknown>;
            return async (...args: unknown[]) => {
              lookups++;
              await gate;
              return orig.apply(target, args);
            };
          }
          if (prop === "$extends") {
            const orig = Reflect.get(target, prop, recv) as (
              ...a: unknown[]
            ) => unknown;
            return (...args: unknown[]) => wrap(orig.apply(target, args));
          }
          return Reflect.get(target, prop, recv);
        },
      });
    const held = wrap(appDb) as PrismaClient;

    const send = (uuid: string, base: PrismaClient) =>
      receiveChatwootWebhook({
        routeToken,
        rawBody: body,
        getHeader: signedHeaders(body, NOW, uuid),
        nowSeconds: NOW,
        base,
      });

    // The first is served stale and starts the one refresh.
    expect((await send("uuid-race-1", held)).outcome).toBe("queued");
    const second = send("uuid-race-2", held);
    release();
    expect((await second).outcome).toBe("queued");
    // ONE lookup between them. Without the wait the second would find the entry withheld (a refresh
    // is deciding) and open its own, which is the burst, at the moment the pool can least afford it.
    expect(lookups).toBe(1);

    invalidateRouteTokenCache();
    noteRouteTokenLookup(true);
  });

  // AND WHEN THAT REFRESH FAILS, THE WAIT MUST NOT READ AS A GREEN LIGHT. The waiters resume into a
  // cache the failure just closed, so each one would take the blocking path and open its OWN
  // transaction — a burst against the pool at the exact moment the pool is what is broken, which is
  // the amplification this whole module exists to prevent. They inherit the failure instead: one
  // lookup for all of them, and every one of them fails honestly onto Chatwoot's retry ladder.
  test("a failed refresh is inherited by the requests waiting on it", async () => {
    const body = JSON.stringify({
      event: "conversation_updated",
      id: 54,
      inbox_id: 7,
      status: "pending",
      meta: { assignee_type: "AgentBot", assignee: { id: 9 } },
    });

    invalidateRouteTokenCache();
    noteRouteTokenLookup(true);
    writeRouteTokenCache(
      hashRouteToken(routeToken),
      {
        tenantId,
        instanceId,
        agentBotId: 9,
        webhookSecret: encryptJson(SECRET),
      },
      { now: Date.now() - ROUTE_TOKEN_CACHE_TTL_MS - 1 },
    );

    // Held open, then failed: the window is a fact rather than a race, and what ends it is the
    // outage, not a timer.
    let lookups = 0;
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const wrap = (client: unknown): unknown =>
      new Proxy(client as object, {
        get(target, prop, recv) {
          if (prop === "$transaction") {
            return async () => {
              lookups++;
              await gate;
              throw new Error("pool exhausted");
            };
          }
          if (prop === "$extends") {
            const orig = Reflect.get(target, prop, recv) as (
              ...a: unknown[]
            ) => unknown;
            return (...args: unknown[]) => wrap(orig.apply(target, args));
          }
          return Reflect.get(target, prop, recv);
        },
      });
    const failing = wrap(appDb) as PrismaClient;

    const send = (uuid: string, base: PrismaClient) =>
      receiveChatwootWebhook({
        routeToken,
        rawBody: body,
        getHeader: signedHeaders(body, NOW, uuid),
        nowSeconds: NOW,
        base,
      });

    // The first is served stale and starts the one refresh; it is already acked when the refresh
    // fails, and that residual event is what issue #228 tracks.
    expect((await send("uuid-fail-1", failing)).outcome).toBe("queued");
    const second = send("uuid-fail-2", failing);
    release();
    await expect(second).rejects.toThrow();
    // ONE lookup, the refresh's. The waiter did not add a second one to a pool that just refused.
    expect(lookups).toBe(1);

    invalidateRouteTokenCache();
    noteRouteTokenLookup(true);
  });

  // THE BURST AT TTL EXPIRY, which is the case the coalescing exists for and the one the wait alone
  // does not cover. Deliveries that arrive together all find no refresh in flight and pass the wait;
  // the first then registers one, and every other reads a MISS — the cache withholds a stale answer
  // while a refresh decides — and falls through to open its own transaction. N deliveries, N-1
  // needless interactive transactions, at the moment the pool is tightest.
  test("a burst at expiry opens one lookup between all of them", async () => {
    const body = JSON.stringify({
      event: "conversation_updated",
      id: 56,
      inbox_id: 7,
      status: "pending",
      meta: { assignee_type: "AgentBot", assignee: { id: 9 } },
    });

    invalidateRouteTokenCache();
    noteRouteTokenLookup(true);
    writeRouteTokenCache(
      hashRouteToken(routeToken),
      {
        tenantId,
        instanceId,
        agentBotId: 9,
        webhookSecret: encryptJson(SECRET),
      },
      { now: Date.now() - ROUTE_TOKEN_CACHE_TTL_MS - 1 },
    );

    let lookups = 0;
    const wrap = (client: unknown): unknown =>
      new Proxy(client as object, {
        get(target, prop, recv) {
          if (prop === "$transaction") {
            const orig = Reflect.get(target, prop, recv) as (
              ...a: unknown[]
            ) => Promise<unknown>;
            return async (...args: unknown[]) => {
              lookups++;
              return orig.apply(target, args);
            };
          }
          if (prop === "$extends") {
            const orig = Reflect.get(target, prop, recv) as (
              ...a: unknown[]
            ) => unknown;
            return (...args: unknown[]) => wrap(orig.apply(target, args));
          }
          return Reflect.get(target, prop, recv);
        },
      });
    const counted = wrap(appDb) as PrismaClient;

    const results = await Promise.all(
      ["b1", "b2", "b3", "b4"].map((uuid) =>
        receiveChatwootWebhook({
          routeToken,
          rawBody: body,
          getHeader: signedHeaders(body, NOW, `uuid-burst-${uuid}`),
          nowSeconds: NOW,
          base: counted,
        }),
      ),
    );

    expect(results.every((r) => r.outcome === "queued")).toBe(true);
    // ONE lookup for the whole burst: the one refresh they all coalesce onto.
    expect(lookups).toBe(1);

    invalidateRouteTokenCache();
    noteRouteTokenLookup(true);
  });

  // AND THE BOUND IS THE RECEIVER'S, not merely the cache module's. A unit test of
  // `awaitRouteTokenRefresh` proves the helper and says nothing about whether the ack path calls it:
  // reading the map directly would compile, pass every other test here, and wedge this bot's webhook
  // behind a lookup that never answers. So this asks the question where it is answered.
  test("a refresh that never answers does not wedge the next delivery", async () => {
    const body = JSON.stringify({
      event: "conversation_updated",
      id: 55,
      inbox_id: 7,
      status: "pending",
      meta: { assignee_type: "AgentBot", assignee: { id: 9 } },
    });

    invalidateRouteTokenCache();
    noteRouteTokenLookup(true);
    writeRouteTokenCache(
      hashRouteToken(routeToken),
      {
        tenantId,
        instanceId,
        agentBotId: 9,
        webhookSecret: encryptJson(SECRET),
      },
      { now: Date.now() - ROUTE_TOKEN_CACHE_TTL_MS - 1 },
    );

    // A lookup that hangs rather than failing: the socket is up, the answer never comes.
    const wrap = (client: unknown): unknown =>
      new Proxy(client as object, {
        get(target, prop, recv) {
          if (prop === "$transaction") return () => new Promise(() => {});
          if (prop === "$extends") {
            const orig = Reflect.get(target, prop, recv) as (
              ...a: unknown[]
            ) => unknown;
            return (...args: unknown[]) => wrap(orig.apply(target, args));
          }
          return Reflect.get(target, prop, recv);
        },
      });
    const hanging = wrap(appDb) as PrismaClient;

    const send = (uuid: string) =>
      receiveChatwootWebhook({
        routeToken,
        rawBody: body,
        getHeader: signedHeaders(body, NOW, uuid),
        nowSeconds: NOW,
        base: hanging,
      });

    // The first is served stale and starts the refresh that will never answer.
    expect((await send("uuid-hang-1")).outcome).toBe("queued");

    // The second must come back one way or the other, well inside Chatwoot's budget.
    const started = Date.now();
    const settled = await Promise.race([
      send("uuid-hang-2").then(
        () => "resolved" as const,
        () => "rejected" as const,
      ),
      new Promise<"wedged">((r) =>
        setTimeout(() => r("wedged"), ROUTE_TOKEN_REFRESH_WAIT_MS + 2_000),
      ),
    ]);
    expect(settled).not.toBe("wedged");
    expect(Date.now() - started).toBeLessThan(
      ROUTE_TOKEN_REFRESH_WAIT_MS + 1_500,
    );

    invalidateRouteTokenCache();
    noteRouteTokenLookup(true);
  }, 15_000);

  test("a delivery stranded on PENDING is recovered by the redelivery", async () => {
    const body = JSON.stringify({
      event: "conversation_updated",
      id: 48,
      inbox_id: 7,
      status: "pending",
      meta: { assignee_type: "AgentBot", assignee: { id: 9 } },
    });
    const r = await receiveChatwootWebhook({
      routeToken,
      rawBody: body,
      getHeader: signedHeaders(body, NOW, "uuid-stranded"),
      nowSeconds: NOW,
      base: appDb,
    });

    // The shape of a process that died after acking: the ledger row exists, nothing ran. Every
    // redelivery from here on reads as a duplicate, so dropping duplicates would lose this message
    // for good, since Chatwoot already has its 200 and will not send it again.
    await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: "uuid-stranded",
        event: "conversation_updated",
        status: "PENDING",
      },
    });

    expect(
      await recordAndProcessChatwootDelivery({
        tenantId,
        instanceId: r.instanceId as bigint,
        deliveryId: r.deliveryId as string,
        agentBotId: r.agentBotId ?? null,
        normalized: r.normalized as NonNullable<typeof r.normalized>,
        base: appDb,
      }),
    ).toBe("processed");

    const row = await suDb.chatwootWebhookDelivery.findFirstOrThrow({
      where: { chatwootInstanceId: instanceId, deliveryId: "uuid-stranded" },
    });
    expect(row.status).toBe("PROCESSED");
  });

  test("disconnecting the instance takes the route token out of the cache", async () => {
    const body = JSON.stringify({
      event: "conversation_updated",
      id: 49,
      inbox_id: 7,
      status: "pending",
      meta: { assignee_type: "AgentBot", assignee: { id: 9 } },
    });
    const send = (uuid: string) =>
      receiveChatwootWebhook({
        routeToken,
        rawBody: body,
        getHeader: signedHeaders(body, NOW, uuid),
        nowSeconds: NOW,
        base: appDb,
      });

    expect((await send("uuid-live")).outcome).toBe("queued");

    await suDb.chatwootInstance.update({
      where: { id: instanceId },
      data: { disconnectedAt: new Date() },
    });
    // Written straight to the row here, so the cache still holds the live answer. The production
    // writers call invalidateRouteTokenCache themselves; this pins that the invalidation is what
    // makes the change land, rather than the TTL quietly doing it later.
    invalidateRouteTokenCache();

    await expect(send("uuid-dead")).rejects.toThrow();

    await suDb.chatwootInstance.update({
      where: { id: instanceId },
      data: { disconnectedAt: null },
    });
    invalidateRouteTokenCache();
    expect((await send("uuid-again")).outcome).toBe("queued");
  });

  test("ignores a payload with no event field", async () => {
    const body = JSON.stringify({ foo: 1 });
    const r = await receiveChatwootWebhook({
      routeToken,
      rawBody: body,
      getHeader: signedHeaders(body, NOW, "uuid-ign"),
      nowSeconds: NOW,
      base: appDb,
    });
    expect(r.outcome).toBe("ignored");
    expect(r.deliveryId).toBeUndefined();
  });

  test("issue #8: an inbound message during a human-owned period advances the handled watermark", async () => {
    // A customer message while a human owns the conversation (!act): the bot deliberately stays
    // silent, but the message must count as handled — otherwise the first debounce flush after the
    // human returns the conversation re-answers the whole human-era backlog.
    const body = JSON.stringify({
      event: "message_created",
      id: 2001,
      content: "isso está um absurdo!",
      message_type: "incoming",
      private: false,
      conversation: {
        id: 44,
        inbox_id: 7,
        status: "open",
        meta: { assignee_type: "User", assignee: { id: 5 } },
      },
    });
    const r = await receiveChatwootWebhook({
      routeToken,
      rawBody: body,
      getHeader: signedHeaders(body, NOW, "uuid-hmn"),
      nowSeconds: NOW,
      base: appDb,
    });
    expect(r.outcome).toBe("queued");
    const proc = await recordAndProcessChatwootDelivery({
      tenantId,
      instanceId: r.instanceId as bigint,
      deliveryId: r.deliveryId as string,
      agentBotId: r.agentBotId ?? null,
      normalized: r.normalized as NonNullable<typeof r.normalized>,
      base: appDb,
    });
    expect(proc).toBe("processed");
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 44 },
      select: { lastHandledMessageId: true },
    });
    expect(conv.lastHandledMessageId).toBe(2001);
  });

  // NOTE: End-to-end pin of the degraded-payload fallback (issue #27's second bug): a signed
  // message_created whose conversation snapshot carries NO meta must neither wipe the mirrored
  // human assignee nor read as bot-owned — the gate falls back to the mirror's effective state,
  // so the message takes the handled-skip path (watermark advances, no turn).
  test("a signed event without meta keeps the human owner and the gate stays closed", async () => {
    const deliver = async (body: string, uuid: string) => {
      const r = await receiveChatwootWebhook({
        routeToken,
        rawBody: body,
        getHeader: signedHeaders(body, NOW, uuid),
        nowSeconds: NOW,
        base: appDb,
      });
      expect(r.outcome).toBe("queued");
      const proc = await recordAndProcessChatwootDelivery({
        tenantId,
        instanceId: r.instanceId as bigint,
        deliveryId: r.deliveryId as string,
        agentBotId: r.agentBotId ?? null,
        normalized: r.normalized as NonNullable<typeof r.normalized>,
        base: appDb,
      });
      expect(proc).toBe("processed");
    };

    // A human owns conversation 46 (meta present).
    await deliver(
      JSON.stringify({
        event: "message_created",
        id: 2100,
        content: "quero falar com um atendente",
        message_type: "incoming",
        private: false,
        conversation: {
          id: 46,
          inbox_id: 7,
          status: "pending",
          meta: { assignee_type: "User", assignee: { id: 5, name: "Rita" } },
        },
      }),
      "uuid-degraded-1",
    );

    // Degraded snapshot: same conversation, NO meta at all.
    await deliver(
      JSON.stringify({
        event: "message_created",
        id: 2101,
        content: "alô?",
        message_type: "incoming",
        private: false,
        conversation: { id: 46, inbox_id: 7, status: "pending" },
      }),
      "uuid-degraded-2",
    );

    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 46 },
      select: {
        assigneeType: true,
        assigneeId: true,
        lastHandledMessageId: true,
      },
    });
    // Mirror guard: the stored human assignee survived the degraded event.
    expect(conv.assigneeType).toBe("User");
    expect(conv.assigneeId).toBe(5);
    // Gate: read the mirror's effective state → !act → handled-skip advances the watermark.
    expect(conv.lastHandledMessageId).toBe(2101);
  });
});

// ── provisioning ↔ receiver round trip (real DB, stubbed Chatwoot client) ──
describe.skipIf(!dbUp)("agent bot provisioning", () => {
  const PROV_SECRET = "provisioned-secret";

  test("creates the persona bot, persists the secret/token, and the receiver verifies with it", async () => {
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 2,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    const agent = await suDb.agent.create({
      data: { tenantId, name: "Vendas", systemPrompt: "x" },
    });

    const calls = {
      createAgentBot: [] as Array<{ name: string; outgoingUrl: string }>,
    };
    const stubClient = {
      createAgentBot: async (p: { name: string; outgoingUrl: string }) => {
        calls.createAgentBot.push(p);
        return { id: 55, access_token: "ACCESS_55", secret: PROV_SECRET };
      },
    } as unknown as ChatwootClient;

    // Lazy per-persona provisioning: mints the bot for (instance, agent), named after the persona.
    const bot = await ensureAgentBot(
      tenantId,
      inst.id,
      agent.id,
      "Vendas",
      stubClient,
      { base: appDb },
    );

    expect(bot.chatwootAgentBotId).toBe(55);
    expect(bot.accessToken).toBe("ACCESS_55");
    expect(calls.createAgentBot).toHaveLength(1);
    expect(calls.createAgentBot[0]?.name).toBe("Vendas");
    const outgoingUrl = calls.createAgentBot[0]?.outgoingUrl as string;
    expect(outgoingUrl).toMatch(
      /\/api\/v1\/chatwoot\/webhook\/[A-Za-z0-9_-]+$/,
    );

    // Persisted on the per-persona row: secret + token encrypted; route token only as its hash.
    const saved = await suDb.chatwootAgentBot.findFirstOrThrow({
      where: { chatwootInstanceId: inst.id, agentId: agent.id },
    });
    expect(saved.chatwootAgentBotId).toBe(55);
    expect(saved.name).toBe("Vendas");
    expect(decryptJson<string>(saved.webhookSecret)).toBe(PROV_SECRET);
    expect(decryptJson<string>(saved.accessToken)).toBe("ACCESS_55");

    // Round trip: a webhook signed with the provisioned secret, addressed to the token embedded in
    // the outgoing_url, resolves to THIS bot and verifies.
    const token = outgoingUrl.split("/").pop() as string;
    const body = JSON.stringify({
      event: "conversation_updated",
      id: 99,
      inbox_id: 7,
      status: "pending",
      meta: { assignee_type: "AgentBot", assignee: { id: 55 } },
    });
    const sig = `sha256=${createHmac("sha256", PROV_SECRET).update(`${NOW}.${body}`).digest("hex")}`;
    const r = await receiveChatwootWebhook({
      routeToken: token,
      rawBody: body,
      getHeader: headersFrom({
        "x-chatwoot-signature": sig,
        "x-chatwoot-timestamp": String(NOW),
        "x-chatwoot-delivery": "uuid-prov",
      }),
      nowSeconds: NOW,
      base: appDb,
    });
    expect(r.outcome).toBe("queued");
    expect(r.tenantId).toBe(tenantId);
    expect(r.instanceId).toBe(inst.id);
    expect(r.agentBotId).toBe(55);
  });

  test("is idempotent for an existing persona bot (returns it, no new bot)", async () => {
    const inst = await suDb.chatwootInstance.findFirstOrThrow({
      where: { tenantId, accountId: 2 },
    });
    const agent = await suDb.agent.findFirstOrThrow({
      where: { tenantId, name: "Vendas" },
    });
    let created = 0;
    const stubClient = {
      // The bot still exists on Chatwoot → ensure reuses it, no new bot.
      listAgentBots: async () => [{ id: 55, name: "Vendas" }],
      createAgentBot: async () => {
        created += 1;
        return { id: 999, access_token: "x", secret: "y" };
      },
    } as unknown as ChatwootClient;
    const bot = await ensureAgentBot(
      tenantId,
      inst.id,
      agent.id,
      "Vendas",
      stubClient,
      { base: appDb },
    );
    // The first test already provisioned bot 55 for this (instance, agent); ensure reuses it.
    expect(bot.chatwootAgentBotId).toBe(55);
    expect(created).toBe(0);
  });

  test("re-provisions when the stored bot was deleted on Chatwoot", async () => {
    const inst = await suDb.chatwootInstance.findFirstOrThrow({
      where: { tenantId, accountId: 2 },
    });
    const agent = await suDb.agent.findFirstOrThrow({
      where: { tenantId, name: "Vendas" },
    });
    let created = 0;
    const stubClient = {
      // Bot 55 is GONE on Chatwoot (operator deleted it out-of-band) → ensure must re-provision.
      listAgentBots: async () => [],
      createAgentBot: async (p: { name: string; outgoingUrl: string }) => {
        created += 1;
        expect(p.name).toBe("Vendas");
        return { id: 56, access_token: "ACCESS_56", secret: "secret-56" };
      },
    } as unknown as ChatwootClient;
    const bot = await ensureAgentBot(
      tenantId,
      inst.id,
      agent.id,
      "Vendas",
      stubClient,
      { base: appDb },
    );
    expect(created).toBe(1);
    expect(bot.chatwootAgentBotId).toBe(56);
    // The SAME row was refreshed in place (unique on tenant+instance+agent), not duplicated.
    const rows = await suDb.chatwootAgentBot.findMany({
      where: { chatwootInstanceId: inst.id, agentId: agent.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.chatwootAgentBotId).toBe(56);
    expect(decryptJson<string>(rows[0]?.accessToken as string)).toBe(
      "ACCESS_56",
    );
  });
});

// ── mirror sync (real DB) ──
describe.skipIf(!dbUp)("chatwoot mirror sync", () => {
  const ev = (
    over: Partial<NormalizedChatwootEvent>,
  ): NormalizedChatwootEvent => ({
    event: "conversation_updated",
    conversationId: 500,
    contactInboxId: null,
    inboxId: 7,
    status: "pending",
    assigneeType: null,
    assigneeId: null,
    assigneeName: null,
    contact: {
      id: 321,
      name: "Maria",
      email: null,
      phone: "+5511999",
      identifier: "ext-1",
    },
    inboxName: "Suporte",
    channel: "Channel::Api",
    lastActivityAt: 1000,
    ...over,
  });

  test("first event creates conversation + contact + inbox", async () => {
    const r = await mirrorChatwootEvent(tenantId, instanceId, ev({}), appDb);
    expect(r.applied).toBe(true);
    expect(r.prevAssigneeId).toBeNull();

    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 500 },
      include: { contact: true, inbox: true },
    });
    expect(conv.status).toBe("pending");
    expect(conv.contact?.name).toBe("Maria");
    expect(conv.contact?.phone).toBe("+5511999");
    expect(conv.inbox?.name).toBe("Suporte");
    expect(conv.inbox?.channelType).toBe("Channel::Api");
  });

  test("a newer event updates status/assignee", async () => {
    const r = await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({
        lastActivityAt: 2000,
        status: "open",
        assigneeId: 5,
        assigneeType: "User",
        assigneeName: "Maria Atendente",
      }),
      appDb,
    );
    expect(r.applied).toBe(true);
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 500 },
    });
    expect(conv.status).toBe("open");
    expect(conv.assigneeId).toBe(5);
    expect(conv.assigneeType).toBe("User");
    // The human's display name is mirrored so the console shows it instead of "Human #id".
    expect(conv.assigneeName).toBe("Maria Atendente");
  });

  test("an older (out-of-order) event is skipped, no status regression", async () => {
    const r = await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({ lastActivityAt: 1500, status: "resolved", assigneeId: null }),
      appDb,
    );
    expect(r.applied).toBe(false);
    expect(r.prevAssigneeId).toBe(5); // saw the prior human assignee before deciding
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 500 },
    });
    expect(conv.status).toBe("open"); // not regressed to "resolved"
    expect(conv.assigneeId).toBe(5);
  });

  test("the same contact across conversations dedupes to one row", async () => {
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({ conversationId: 501, lastActivityAt: 3000 }),
      appDb,
    );
    const count = await suDb.contact.count({
      where: { tenantId, chatwootContactId: 321 },
    });
    expect(count).toBe(1);
  });

  test("contactInboxId is persisted from the payload and not wiped by a later event without it", async () => {
    // Create with the native ContactInbox id present.
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({ conversationId: 520, contactInboxId: 9900, lastActivityAt: 6000 }),
      appDb,
    );
    let conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 520 },
    });
    expect(conv.contactInboxId).toBe(9900);
    // A later event WITHOUT the field must not clear the stored id (only sets when present).
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({ conversationId: 520, contactInboxId: null, lastActivityAt: 7000 }),
      appDb,
    );
    conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 520 },
    });
    expect(conv.contactInboxId).toBe(9900);
  });

  test("an incoming message advances lastInboundAt; suppressInboundWatermark holds it back (command path)", async () => {
    const incoming = (lastActivityAt: number): NormalizedChatwootEvent =>
      ev({
        conversationId: 510,
        event: "message_created",
        message: {
          id: 1,
          content: "oi",
          messageType: "incoming",
          private: false,
        },
        lastActivityAt,
      });
    // A genuine incoming message anchors lastInboundAt.
    await mirrorChatwootEvent(tenantId, instanceId, incoming(4000), appDb);
    let conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 510 },
    });
    const firstInbound = conv.lastInboundAt;
    expect(firstInbound).not.toBeNull();
    // A later incoming message WITH suppression (an active /teste|/reset command): lastInboundAt stays
    // put — so the sweep won't see a fresh customer reply — while lastEventAt still advances.
    await mirrorChatwootEvent(tenantId, instanceId, incoming(5000), appDb, {
      suppressInboundWatermark: true,
    });
    conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 510 },
    });
    expect(conv.lastInboundAt?.getTime()).toBe(firstInbound?.getTime());
    expect(conv.lastEventAt?.getTime()).toBe(5000 * 1000);
  });

  test("custom attribute bags are mirrored, and a payload without them preserves the stored ones", async () => {
    const withBags = ev({
      conversationId: 530,
      lastActivityAt: 9000,
      customAttributes: { origem: "Instagram" },
      kanbanAttributes: { orcamento: 3200 },
      contact: {
        id: 322,
        name: "Joana",
        email: null,
        phone: null,
        identifier: null,
        customAttributes: { plano: "pro" },
      },
    });
    await mirrorChatwootEvent(tenantId, instanceId, withBags, appDb);
    let conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 530 },
      include: { contact: true },
    });
    expect(conv.customAttributes).toEqual({ origem: "Instagram" });
    expect(conv.kanbanAttributes).toEqual({ orcamento: 3200 });
    expect(conv.contact?.customAttributes).toEqual({ plano: "pro" });

    // NOTE: A later event that carries no bags (degraded payload) must NOT wipe what is stored.
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({
        conversationId: 530,
        lastActivityAt: 9100,
        contact: {
          id: 322,
          name: "Joana",
          email: null,
          phone: null,
          identifier: null,
        },
      }),
      appDb,
    );
    conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 530 },
      include: { contact: true },
    });
    expect(conv.customAttributes).toEqual({ origem: "Instagram" });
    expect(conv.kanbanAttributes).toEqual({ orcamento: 3200 });
    expect(conv.contact?.customAttributes).toEqual({ plano: "pro" });

    // NOTE: A newer event with a new bag REPLACES it wholesale (Chatwoot ships the whole hash).
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({
        conversationId: 530,
        lastActivityAt: 9200,
        customAttributes: { etapa: "proposta" },
      }),
      appDb,
    );
    conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 530 },
      include: { contact: true },
    });
    expect(conv.customAttributes).toEqual({ etapa: "proposta" });

    // NOTE: An EXPLICIT {} is a real "the operator cleared everything", not a degraded payload:
    // unlike an absent bag it must clear the stored one, on all three scopes.
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({
        conversationId: 530,
        lastActivityAt: 9300,
        customAttributes: {},
        kanbanAttributes: {},
        contact: {
          id: 322,
          name: "Joana",
          email: null,
          phone: null,
          identifier: null,
          customAttributes: {},
        },
      }),
      appDb,
    );
    conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 530 },
      include: { contact: true },
    });
    expect(conv.customAttributes).toEqual({});
    expect(conv.kanbanAttributes).toEqual({});
    expect(conv.contact?.customAttributes).toEqual({});
  });

  test("a stale event cannot roll back the mirrored contact attributes", async () => {
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({
        conversationId: 540,
        lastActivityAt: 9500,
        contact: {
          id: 324,
          name: "Rita",
          email: null,
          phone: null,
          identifier: null,
          customAttributes: { plano: "pro" },
        },
      }),
      appDb,
    );

    // NOTE: The contact upsert runs BEFORE the conversation's stale check (the conversation row
    // needs the contact id), so without the per-contact watermark this out-of-order delivery would
    // downgrade the stored plan even though the conversation update itself is skipped.
    const stale = await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({
        conversationId: 540,
        lastActivityAt: 9400,
        contact: {
          id: 324,
          name: "Rita",
          email: null,
          phone: null,
          identifier: null,
          customAttributes: { plano: "free" },
        },
      }),
      appDb,
    );
    expect(stale.applied).toBe(false);
    const contact = await suDb.contact.findFirstOrThrow({
      where: { tenantId, chatwootContactId: 324 },
    });
    expect(contact.customAttributes).toEqual({ plano: "pro" });

    // NOTE: …and a genuinely newer delivery still gets through.
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({
        conversationId: 540,
        lastActivityAt: 9600,
        contact: {
          id: 324,
          name: "Rita",
          email: null,
          phone: null,
          identifier: null,
          customAttributes: { plano: "enterprise" },
        },
      }),
      appDb,
    );
    const fresh = await suDb.contact.findFirstOrThrow({
      where: { tenantId, chatwootContactId: 324 },
    });
    expect(fresh.customAttributes).toEqual({ plano: "enterprise" });

    // NOTE: An undated payload has no place in the order. Stamping it with OUR receipt time would
    // make it beat every real Chatwoot timestamp, so it must not displace a positioned snapshot.
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({
        conversationId: 540,
        lastActivityAt: null,
        contact: {
          id: 324,
          name: "Rita",
          email: null,
          phone: null,
          identifier: null,
          customAttributes: { plano: "free" },
        },
      }),
      appDb,
    );
    const undated = await suDb.contact.findFirstOrThrow({
      where: { tenantId, chatwootContactId: 324 },
    });
    expect(undated.customAttributes).toEqual({ plano: "enterprise" });
  });

  test("an undated payload still bootstraps a contact nothing has positioned yet", async () => {
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({
        conversationId: 550,
        lastActivityAt: null,
        contact: {
          id: 326,
          name: "Ana",
          email: null,
          phone: null,
          identifier: null,
          customAttributes: { plano: "trial" },
        },
      }),
      appDb,
    );
    const seeded = await suDb.contact.findFirstOrThrow({
      where: { tenantId, chatwootContactId: 326 },
    });
    expect(seeded.customAttributes).toEqual({ plano: "trial" });
    // NOTE: …and the watermark stays null, so the first DATED event still takes over.
    expect(seeded.customAttributesAt).toBeNull();

    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({
        conversationId: 550,
        lastActivityAt: 9700,
        contact: {
          id: 326,
          name: "Ana",
          email: null,
          phone: null,
          identifier: null,
          customAttributes: { plano: "pro" },
        },
      }),
      appDb,
    );
    const dated = await suDb.contact.findFirstOrThrow({
      where: { tenantId, chatwootContactId: 326 },
    });
    expect(dated.customAttributes).toEqual({ plano: "pro" });
    expect(dated.customAttributesAt).not.toBeNull();
  });

  // NOTE: Same sentinel convention as the attribute bags right above: `undefined` = "this payload
  // said nothing about the assignee" (no meta) and must preserve the stored trio; an explicit null
  // = a real unassign carried by meta. Without the guard, any degraded event silently wipes an
  // 'AgentBot'/'User' — which is what made issue #27 intermittent.
  test("an event without meta preserves the stored assignee; meta with null assignee clears it", async () => {
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({
        conversationId: 560,
        lastActivityAt: 9800,
        assigneeType: "AgentBot",
        assigneeId: 9,
        assigneeName: "Bot",
      }),
      appDb,
    );

    // Degraded payload: the normalizer saw no meta, so the trio is undefined.
    const degraded = await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({
        conversationId: 560,
        lastActivityAt: 9900,
        assigneeType: undefined,
        assigneeId: undefined,
        assigneeName: undefined,
      }),
      appDb,
    );
    expect(degraded.applied).toBe(true);
    let conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 560 },
    });
    expect(conv.assigneeType).toBe("AgentBot");
    expect(conv.assigneeId).toBe(9);
    expect(conv.assigneeName).toBe("Bot");
    // The mirror result reports the EFFECTIVE state (what is stored), not the payload's silence.
    expect(degraded.assigneeType).toBe("AgentBot");
    expect(degraded.assigneeId).toBe(9);

    // Meta present with no assignee = a real unassign; it must still clear.
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({
        conversationId: 560,
        lastActivityAt: 10000,
        assigneeType: null,
        assigneeId: null,
        assigneeName: null,
      }),
      appDb,
    );
    conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 560 },
    });
    expect(conv.assigneeType).toBeNull();
    expect(conv.assigneeId).toBeNull();
    expect(conv.assigneeName).toBeNull();
  });

  test("normalize: a payload without meta leaves the assignee trio undefined; meta without assignee yields null", () => {
    const noMeta = normalizeChatwootEvent({
      event: "conversation_updated",
      id: 561,
      status: "pending",
    });
    expect(noMeta?.assigneeType).toBeUndefined();
    expect(noMeta?.assigneeId).toBeUndefined();
    expect(noMeta?.assigneeName).toBeUndefined();

    const unassigned = normalizeChatwootEvent({
      event: "conversation_updated",
      id: 561,
      status: "pending",
      meta: { assignee_type: null, assignee: null },
    });
    expect(unassigned?.assigneeType).toBeNull();
    expect(unassigned?.assigneeId).toBeNull();
    expect(unassigned?.assigneeName).toBeNull();
  });
});

// ── loadChatwootClient (real DB) ──
describe.skipIf(!dbUp)("loadChatwootClient", () => {
  test("decrypts the admin token; bot token is admin-only by default and overridable", async () => {
    const capture = async () => {
      let captured: ConstructorParameters<typeof ChatwootClient>[0] | null =
        null;
      return {
        get: () => captured,
        makeClient: async (
          cfg: ConstructorParameters<typeof ChatwootClient>[0],
        ) => {
          captured = cfg;
          return {} as ChatwootClient;
        },
      };
    };

    // Default: admin token decrypted, bot token empty (the persona bot token is passed by the
    // posting paths, not read from the instance).
    const a = await capture();
    await loadChatwootClient(tenantId, instanceId, {
      base: appDb,
      makeClient: a.makeClient,
    });
    const cfgA = a.get() as unknown as ConstructorParameters<
      typeof ChatwootClient
    >[0];
    expect(cfgA.baseUrl).toBe(withRunNamespace("https://chat.example.com"));
    expect(cfgA.accountId).toBe(1);
    expect(cfgA.adminToken).toBe("ADMIN");
    expect(cfgA.botToken).toBe("");

    // Override: a posting path supplies the persona bot token.
    const b = await capture();
    await loadChatwootClient(tenantId, instanceId, {
      base: appDb,
      makeClient: b.makeClient,
      botToken: "PERSONA_BOT",
    });
    const cfgB = b.get() as unknown as ConstructorParameters<
      typeof ChatwootClient
    >[0];
    expect(cfgB.botToken).toBe("PERSONA_BOT");
  });
});

// Module-scope teardown: runs after BOTH describes so the provisioning suite still has the
// tenant and live connections that the receiver suite's beforeAll created.
afterAll(async () => {
  if (!dbUp) return;
  if (tenantId) {
    for (const table of [
      "chatwoot_webhook_deliveries",
      "conversations",
      "contacts",
      "inboxes",
      "chatwoot_agent_bots",
      "agents",
      "chatwoot_instances",
    ]) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
      );
    }
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
  }
  await suDb.$disconnect();
  await appDb.$disconnect();
});
