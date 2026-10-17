import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { elevenLabsProvider } from "@/modules/voice-call/providers/elevenlabs";
import { dbEngineHold } from "@/modules/voice-call/providers/engine-hold";
import type {
  VoiceSessionConfig,
  VoiceSessionHandlers,
} from "@/modules/voice-call/providers/types";
import { dbProbeFailed } from "@/tests/db-gate";

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
