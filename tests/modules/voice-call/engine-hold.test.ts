import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { dbConfigDigests } from "@/modules/voice-call/providers/config-digests";
import { elevenLabsProvider } from "@/modules/voice-call/providers/elevenlabs";
import { ensureElevenLabsAgent } from "@/modules/voice-call/providers/elevenlabs-agent";
import {
  CONFIG_HOLD_LEASE_MS,
  dbEngineHold,
} from "@/modules/voice-call/providers/engine-hold";
import type {
  VoiceSessionConfig,
  VoiceSessionHandlers,
} from "@/modules/voice-call/providers/types";
import { readCallsConfig } from "@/modules/voice-call/settings";
import { dbProbeFailed } from "@/tests/db-gate";
import { until } from "@/tests/utils/poll";

// Two processes starting calls on one ElevenLabs agent, as the leader and a web replica do: each has
// its own client, and the only thing they share is the database. One holds the agent at a time, what
// the holder declared is what the next one reads, and a holder that died frees the agent when its
// lease passes, without the late writes of that holder landing on the next one's.

const appUrl = process.env.TEST_APP_DATABASE_URL;
let dbUp = false;
const clients: PrismaClient[] = [];
if (appUrl) {
  try {
    for (let i = 0; i < 2; i++) {
      const c = new PrismaClient({
        adapter: new PrismaPg({ connectionString: appUrl }),
      });
      await c.$queryRaw`SELECT 1`;
      clients.push(c);
    }
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const [one, two] = clients as [PrismaClient, PrismaClient];

const agents: string[] = [];
const agentId = () => {
  const id = `hold-test-${crypto.randomUUID()}`;
  agents.push(id);
  return id;
};
const wait = (ms: number) => AbortSignal.timeout(ms);

afterAll(async () => {
  if (dbUp)
    await one.$executeRaw`DELETE FROM voice_engine_holds WHERE engine_agent_id = ANY(${agents})`;
  await Promise.all(clients.map((c) => c.$disconnect()));
});

describe.skipIf(!dbUp)(
  "the hold on an ElevenLabs agent, across processes",
  () => {
    test("the second process waits for the first, and reads what it declared", async () => {
      const id = agentId();
      const first = await dbEngineHold(30_000, one)(id, wait(5_000));
      expect(first.declaredDigest).toBeNull();
      // While the first holds it, the second only waits, until its own deadline.
      await expect(
        dbEngineHold(30_000, two)(id, wait(400)),
      ).rejects.toBeDefined();
      await first.markDeclared("digest-a");
      await first.release();
      const held = await dbEngineHold(30_000, two)(id, wait(5_000));
      expect(held.declaredDigest).toBe("digest-a");
      await held.release();
    });

    test("a holder that never releases frees the agent when its lease passes", async () => {
      const id = agentId();
      const dead = await dbEngineHold(200, one)(id, wait(5_000));
      const next = await dbEngineHold(30_000, two)(id, wait(5_000));
      await next.markDeclared("fresh");
      // The dead holder's late writes name a hold that is no longer its own.
      await dead.markDeclared("stale");
      await dead.release();
      const third = dbEngineHold(30_000, one)(id, wait(400));
      await expect(third).rejects.toBeDefined();
      await next.release();
      expect(
        (await dbEngineHold(30_000, one)(id, wait(5_000))).declaredDigest,
      ).toBe("fresh");
    });

    test("a declaration that fails after it was sent leaves the agent's tools unknown", async () => {
      const id = agentId();
      const before = await dbEngineHold(30_000, one)(id, wait(5_000));
      await before.markDeclared("what an earlier call declared");
      await before.release();
      const fetchImpl = (async () => {
        throw new Error("socket hang up");
      }) as unknown as typeof fetch;
      const opening = elevenLabsProvider({
        apiKey: "k",
        agentId: id,
        fetchImpl,
        base: two,
      }).open(
        { tools: [] } as unknown as VoiceSessionConfig,
        {} as VoiceSessionHandlers,
      );
      await expect(opening).rejects.toThrow("socket hang up");
      const after = await dbEngineHold(30_000, one)(id, wait(5_000));
      expect(after.declaredDigest).toBeNull();
      await after.release();
    });

    test("a call started while another process holds the agent declares nothing, and gives up", async () => {
      const id = agentId();
      const other = await dbEngineHold(30_000, one)(id, wait(5_000));
      const asked: string[] = [];
      const fetchImpl = (async (url: string) => {
        asked.push(url);
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;
      // No hold given: the provider's own, through the database (this process's client, named so a
      // module mock elsewhere in the run cannot stand in for it). The open deadline sets its lease,
      // and so how long it waits.
      const opening = elevenLabsProvider({
        apiKey: "k",
        agentId: id,
        fetchImpl,
        openTimeoutMs: 1,
        base: two,
      }).open(
        { tools: [] } as unknown as VoiceSessionConfig,
        {} as VoiceSessionHandlers,
      );
      await expect(opening).rejects.toThrow("held by another call's start");
      expect(asked).toEqual([]);
      await other.release();
    }, 15_000);
  },
);

describe.skipIf(!dbUp)(
  "an ElevenLabs agent's configuration, written from two processes",
  () => {
    const spec = (voice: string) => ({
      name: "Maria",
      prompt: "Você é a Maria.",
      voice,
      calls: readCallsConfig({}),
    });
    const patches = () => {
      const sent: string[] = [];
      const fetchImpl = (async (_url: string, init?: RequestInit) => {
        sent.push(String(init?.method));
        return new Response("{}");
      }) as unknown as typeof fetch;
      return { sent, fetchImpl };
    };

    test("a process that wrote a version is not fooled by one written elsewhere since", async () => {
      const id = agentId();
      const a = patches();
      const b = patches();
      const write = (
        p: ReturnType<typeof patches>,
        db: PrismaClient,
        voice: string,
      ) =>
        ensureElevenLabsAgent(
          "k",
          id,
          spec(voice),
          p.fetchImpl,
          dbConfigDigests(db),
          dbEngineHold(CONFIG_HOLD_LEASE_MS, db),
        );
      await write(a, one, "v1");
      await write(b, two, "v2");
      // The operator restores v1, and the process that wrote it first is the one that saves.
      await write(a, one, "v1");
      expect(a.sent).toEqual(["PATCH", "PATCH"]);
      // Written by either, the same version is not written again.
      await write(b, two, "v1");
      expect(b.sent).toEqual(["PATCH"]);
    });

    test("a write whose answer comes back after a later one does not record itself", async () => {
      const id = agentId();
      const sent: string[] = [];
      const stalled: { answer?: () => void } = {};
      // A's write applies on ElevenLabs, and its answer is held past its hold's lease.
      const slow = (async (_url: string, init?: RequestInit) => {
        sent.push(`A ${String(init?.method)}`);
        await new Promise<void>((go) => {
          stalled.answer = go;
        });
        return new Response("{}");
      }) as unknown as typeof fetch;
      const fast = (async (_url: string, init?: RequestInit) => {
        sent.push(`B ${String(init?.method)}`);
        return new Response("{}");
      }) as unknown as typeof fetch;
      const first = ensureElevenLabsAgent(
        "k",
        id,
        spec("v1"),
        slow,
        dbConfigDigests(one),
        dbEngineHold(300, one),
      );
      await until("A's write to be sent", () => stalled.answer);
      // B waits for A's hold, takes it when the lease passes, and writes v2.
      await ensureElevenLabsAgent(
        "k",
        id,
        spec("v2"),
        fast,
        dbConfigDigests(two),
        dbEngineHold(CONFIG_HOLD_LEASE_MS, two),
      );
      stalled.answer?.();
      await first;
      // ElevenLabs carries v2, so restoring v1 is written.
      await ensureElevenLabsAgent(
        "k",
        id,
        spec("v1"),
        fast,
        dbConfigDigests(one),
        dbEngineHold(CONFIG_HOLD_LEASE_MS, one),
      );
      expect(sent).toEqual(["A PATCH", "B PATCH", "B PATCH"]);
    });

    test("a write whose answer is lost leaves the configuration unknown, so it is sent again", async () => {
      const id = agentId();
      const ok = patches();
      await ensureElevenLabsAgent(
        "k",
        id,
        spec("v1"),
        ok.fetchImpl,
        dbConfigDigests(one),
        dbEngineHold(CONFIG_HOLD_LEASE_MS, one),
      );
      const lost = (async () => {
        throw new Error("socket hang up");
      }) as unknown as typeof fetch;
      await expect(
        ensureElevenLabsAgent(
          "k",
          id,
          spec("v2"),
          lost,
          dbConfigDigests(two),
          dbEngineHold(CONFIG_HOLD_LEASE_MS, two),
        ),
      ).rejects.toThrow("socket hang up");
      await ensureElevenLabsAgent(
        "k",
        id,
        spec("v1"),
        ok.fetchImpl,
        dbConfigDigests(one),
        dbEngineHold(CONFIG_HOLD_LEASE_MS, one),
      );
      expect(ok.sent).toEqual(["PATCH", "PATCH"]);
    });
  },
);
