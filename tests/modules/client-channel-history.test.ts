import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import {
  claimClientThread,
  EXPIRY_CLAIM,
  type ExternalIdentity,
  handOverAnonymousThreads,
  listClientThreads,
  readClientTranscript,
  recordClientMessage,
  THREAD_TITLE_MAX,
  threadTitle,
} from "@/modules/client-channel/identity";
import { dbProbeFailed } from "@/tests/db-gate";

// The widget's list of earlier conversations reads the threads a turn would let the same user
// resume, and nothing else: another user's, another scope's and another agent's never appear, a thread
// being expired is gone, and a conversation an anonymous visitor takes along when they sign in moves
// from one list to the other. Each thread is named by the message that opened it.

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

let tenantId = 0n;
let agentId = 0n;
let otherAgentId = 0n;
let ctx: TenantContext;

const ANA: ExternalIdentity = { id: "app:1:ana", scope: "org-1" };
const ANA_OTHER_ORG: ExternalIdentity = { id: "app:1:ana", scope: "org-2" };
const BRUNO: ExternalIdentity = { id: "app:1:bruno", scope: "org-1" };
const VISITOR: ExternalIdentity = { id: "anon:1:visitante" };

async function open(
  user: ExternalIdentity,
  message: string,
  at: Date,
  agent = agentId,
) {
  const { threadId } = await claimClientThread({
    ctx,
    agentId: agent,
    threadId: undefined,
    user,
    base: appDb,
    message,
    now: at,
  });
  return threadId;
}

async function list(
  user: ExternalIdentity,
  limit = 20,
  cursor?: Parameters<typeof listClientThreads>[0]["cursor"],
) {
  return listClientThreads({ ctx, agentId, user, base: appDb, limit, cursor });
}

const at = (minute: number) =>
  new Date(Date.UTC(2026, 9, 20, 12, minute, 0, 0));

describe.skipIf(!dbUp)(
  "client channel: the user's list of conversations",
  () => {
    beforeAll(async () => {
      tenantId = (
        await suDb.tenant.create({
          data: { name: "CCH", slug: `cch-${process.pid}` },
        })
      ).id;
      ctx = { tenantId, userId: null, role: "TENANT_ADMIN" };
      agentId = (
        await suDb.agent.create({
          data: { tenantId, name: "copiloto", systemPrompt: "x" },
        })
      ).id;
      otherAgentId = (
        await suDb.agent.create({
          data: { tenantId, name: "outro", systemPrompt: "x" },
        })
      ).id;
    });

    afterAll(async () => {
      if (tenantId) await suDb.tenant.deleteMany({ where: { id: tenantId } });
      await appDb.$disconnect();
      await suDb.$disconnect();
    });

    test("a new thread is named by its first message, flattened and cut short", () => {
      const long = "a".repeat(THREAD_TITLE_MAX + 40);
      expect({
        plain: threadTitle("Por que a nota 2 foi rejeitada?"),
        flattened: threadTitle("  linha um\n\n  linha   dois "),
        empty: threadTitle("   "),
        none: threadTitle(undefined),
        long: threadTitle(long)?.length,
        ellipsis: threadTitle(long)?.endsWith("…"),
      }).toEqual({
        plain: "Por que a nota 2 foi rejeitada?",
        flattened: "linha um linha dois",
        empty: null,
        none: null,
        long: THREAD_TITLE_MAX,
        ellipsis: true,
      });
    });

    test("the list holds only the user's own threads in that scope with this agent, newest first", async () => {
      const first = await open(ANA, "Primeira pergunta", at(1));
      const second = await open(ANA, "Segunda pergunta", at(2));
      await open(ANA_OTHER_ORG, "Na outra organização", at(3));
      await open(BRUNO, "Do Bruno", at(4));
      await open(ANA, "Com outro agente", at(5), otherAgentId);

      const page = await list(ANA);
      expect({
        threads: page.threads.map((t) => [t.threadId, t.title]),
        next: page.next,
        bruno: (await list(BRUNO)).threads.map((t) => t.title),
        otherOrg: (await list(ANA_OTHER_ORG)).threads.map((t) => t.title),
        stranger: (await list({ id: "app:1:ninguem", scope: "org-1" })).threads,
      }).toEqual({
        threads: [
          [second, "Segunda pergunta"],
          [first, "Primeira pergunta"],
        ],
        next: null,
        bruno: ["Do Bruno"],
        otherOrg: ["Na outra organização"],
        stranger: [],
      });
    });

    test("a user the instance has never seen is not recorded by asking", async () => {
      const before = await suDb.externalUser.count({ where: { tenantId } });
      await list({ id: "app:1:curioso" });
      expect(await suDb.externalUser.count({ where: { tenantId } })).toBe(
        before,
      );
    });

    test("pages follow the cursor without repeating or skipping, also between threads with the same activity", async () => {
      const pager: ExternalIdentity = { id: "app:1:paginas", scope: "org-1" };
      const made: string[] = [];
      for (let i = 0; i < 5; i++)
        made.push(await open(pager, `pergunta ${i}`, at(i < 3 ? 10 : 20)));
      const seen: string[] = [];
      let cursor: Parameters<typeof list>[2];
      for (let round = 0; round < 5; round++) {
        const page = await list(pager, 2, cursor);
        seen.push(...page.threads.map((t) => t.threadId));
        if (!page.next) break;
        cursor = page.next;
      }
      expect({ count: seen.length, distinct: new Set(seen).size }).toEqual({
        count: 5,
        distinct: 5,
      });
      expect(new Set(seen)).toEqual(new Set(made));
    });

    test("a thread being expired is no longer listed", async () => {
      const goner: ExternalIdentity = { id: "anon:1:expirando" };
      const kept = await open(goner, "Fica", at(30));
      const going = await open(goner, "Vai expirar", at(31));
      await suDb.detachedThread.update({
        where: { threadId: going },
        data: { activeTurnId: EXPIRY_CLAIM, activeUntil: at(59) },
      });
      expect((await list(goner)).threads.map((t) => t.threadId)).toEqual([
        kept,
      ]);
    });

    test("a conversation the visitor takes along when signing in moves to the signed-in list", async () => {
      const thread = await open(VISITOR, "Antes de entrar", at(40));
      const signedIn: ExternalIdentity = { id: "app:1:carla", scope: "org-1" };
      const moved = await handOverAnonymousThreads({
        ctx,
        agentId,
        from: VISITOR.id,
        to: signedIn,
        base: appDb,
        checkpointer: new MemorySaver(),
      });
      expect({
        moved,
        visitor: (await list(VISITOR)).threads,
        signedIn: (await list(signedIn)).threads.map((t) => [
          t.threadId,
          t.title,
        ]),
      }).toEqual({
        moved: [thread],
        visitor: [],
        signedIn: [[thread, "Antes de entrar"]],
      });
    });

    const say = (threadId: string, role: "user" | "agent", text: string) =>
      recordClientMessage({ ctx, base: appDb, threadId, role, text });
    const read = (
      user: ExternalIdentity,
      threadId: string,
      limit = 50,
      before?: bigint,
    ) =>
      readClientTranscript({
        ctx,
        agentId,
        user,
        base: appDb,
        threadId,
        limit,
        before,
      });
    const status = (run: () => Promise<unknown>) =>
      run().then(
        () => "ok",
        (e: { statusCode?: number; translationKey?: string }) =>
          `${e.statusCode} ${e.translationKey}`,
      );

    test("a conversation reads back what its owner was shown, in order, and to nobody else", async () => {
      const owner: ExternalIdentity = { id: "app:1:dora", scope: "org-1" };
      const thread = await open(owner, "Como emito a nota?", at(50));
      await say(thread, "user", "Como emito a nota?");
      await say(thread, "agent", "Pelo menu Notas.");
      await say(thread, "user", "E a segunda via?");
      const page = await read(owner, thread);
      expect({
        recorded: page.recorded,
        messages: page.messages.map((m) => [m.role, m.text]),
        next: page.next,
        otherUser: await status(() => read(BRUNO, thread)),
        otherScope: await status(() =>
          read({ id: owner.id, scope: "org-2" }, thread),
        ),
        otherAgent: await status(() =>
          readClientTranscript({
            ctx,
            agentId: otherAgentId,
            user: owner,
            base: appDb,
            threadId: thread,
            limit: 50,
          }),
        ),
        stranger: await status(() =>
          read({ id: "app:1:ninguem", scope: "org-1" }, thread),
        ),
      }).toEqual({
        recorded: true,
        messages: [
          ["user", "Como emito a nota?"],
          ["agent", "Pelo menu Notas."],
          ["user", "E a segunda via?"],
        ],
        next: null,
        otherUser: "404 errors.threadNotFound",
        otherScope: "404 errors.threadNotFound",
        otherAgent: "404 errors.threadNotFound",
        stranger: "404 errors.threadNotFound",
      });
    });

    test("a spoken message reads back as spoken", async () => {
      const owner: ExternalIdentity = { id: "app:1:voz", scope: "org-1" };
      const thread = await open(owner, "minhas notas", at(55));
      await recordClientMessage({
        ctx,
        base: appDb,
        threadId: thread,
        role: "user",
        text: "minhas notas",
        voice: true,
      });
      await say(thread, "agent", "Pronto.");
      expect(
        (await read(owner, thread)).messages.map((m) => [m.text, m.voice]),
      ).toEqual([
        ["minhas notas", true],
        ["Pronto.", false],
      ]);
    });

    test("a title and a message a column would refuse are stored repaired, never half a character", async () => {
      const owner: ExternalIdentity = { id: "app:1:emoji", scope: "org-1" };
      // "comnulo " and the a's end one unit short of the cut, which lands inside the first emoji.
      const atTheCut = `${"a".repeat(THREAD_TITLE_MAX - 2 - 8)}😀😀`;
      const thread = await open(owner, `com\u0000nulo ${atTheCut}`, at(56));
      await say(thread, "user", "meio \ud83d caractere e \u0000 nulo");
      const title = (await list(owner)).threads[0]?.title ?? "";
      expect({
        // NOTE: the driver writes half a character as U+FFFD, so that is what a bad cut leaves.
        lone: /[\ud800-\udfff\ufffd]/.test(title.replace(/😀/g, "")),
        nul: title.includes("\u0000"),
        text: (await read(owner, thread)).messages[0]?.text,
      }).toEqual({
        lone: false,
        nul: false,
        text: "meio \ufffd caractere e  nulo",
      });
    });

    test("a long conversation pages from the newest back without repeating or skipping", async () => {
      const owner: ExternalIdentity = { id: "app:1:longa", scope: "org-1" };
      const thread = await open(owner, "m0", at(51));
      for (let i = 0; i < 7; i++)
        await say(thread, i % 2 ? "agent" : "user", `m${i}`);
      const pages: string[][] = [];
      let before: bigint | undefined;
      for (let round = 0; round < 5; round++) {
        const page = await read(owner, thread, 3, before);
        pages.push(page.messages.map((m) => m.text));
        if (page.next === null) break;
        before = page.next;
      }
      expect(pages).toEqual([["m4", "m5", "m6"], ["m1", "m2", "m3"], ["m0"]]);
    });

    test("a thread from before the transcript says so, and a thread being expired is not found", async () => {
      const owner: ExternalIdentity = { id: "anon:1:antigo" };
      const old = await open(owner, "De antes", at(52));
      await suDb.detachedThread.update({
        where: { threadId: old },
        data: { recorded: false },
      });
      const going = await open(owner, "Vai expirar", at(53));
      await say(going, "user", "Vai expirar");
      await suDb.detachedThread.update({
        where: { threadId: going },
        data: { activeTurnId: EXPIRY_CLAIM, activeUntil: at(59) },
      });
      const page = await read(owner, old);
      expect({
        recorded: page.recorded,
        messages: page.messages,
        going: await status(() => read(owner, going)),
      }).toEqual({
        recorded: false,
        messages: [],
        going: "404 errors.threadNotFound",
      });
    });

    test("a hand-over landing between the owner check and the read shows the previous owner nothing new", async () => {
      const visitor: ExternalIdentity = { id: "anon:1:corrida" };
      const thread = await open(visitor, "Antes", at(57));
      await say(thread, "user", "Antes");
      const taker = await suDb.externalUser.create({
        data: { tenantId, channel: "client", externalId: "app:1:pegou" },
      });
      // The hand-over commits on another connection right after the ownership check, with the new
      // owner's first message.
      let armed = true;
      const racing = appDb.$extends({
        query: {
          detachedThread: {
            async findFirst({ args, query }) {
              const found = await query(args);
              if (armed) {
                armed = false;
                await suDb.detachedThread.update({
                  where: { threadId: thread },
                  data: { externalUserId: taker.id, scope: null },
                });
                await suDb.clientThreadMessage.create({
                  data: {
                    tenantId,
                    threadId: thread,
                    role: "user",
                    text: "do novo dono",
                  },
                });
              }
              return found;
            },
          },
        },
      }) as unknown as PrismaClient;
      const page = await readClientTranscript({
        ctx,
        agentId,
        user: visitor,
        base: racing,
        threadId: thread,
        limit: 50,
      });
      expect(page.messages.map((m) => m.text)).not.toContain("do novo dono");
    });

    test("a thread the channel mints is recorded; one another writer creates (a previous release mid-deploy) is not", async () => {
      const owner: ExternalIdentity = { id: "app:1:deploy", scope: "org-1" };
      const minted = await open(owner, "Nova", at(58));
      const person = await suDb.externalUser.findFirstOrThrow({
        where: { tenantId, channel: "client", externalId: owner.id },
      });
      const elsewhere = `${tenantId}:client:${agentId}:${crypto.randomUUID()}`;
      await suDb.detachedThread.create({
        data: {
          threadId: elsewhere,
          tenantId,
          agentId,
          kind: "client",
          externalUserId: person.id,
          scope: owner.scope,
        },
      });
      expect({
        minted: (await read(owner, minted)).recorded,
        elsewhere: (await read(owner, elsewhere)).recorded,
      }).toEqual({ minted: true, elsewhere: false });
    });

    test("the transcript goes along with a conversation handed over at sign-in", async () => {
      const visitor: ExternalIdentity = { id: "anon:1:levando" };
      const thread = await open(visitor, "Antes", at(54));
      await say(thread, "user", "Antes");
      await say(thread, "agent", "Resposta");
      const signedIn: ExternalIdentity = { id: "app:1:levou", scope: "org-1" };
      await handOverAnonymousThreads({
        ctx,
        agentId,
        from: visitor.id,
        to: signedIn,
        base: appDb,
        checkpointer: new MemorySaver(),
      });
      expect({
        signedIn: (await read(signedIn, thread)).messages.map((m) => m.text),
        visitor: await status(() => read(visitor, thread)),
      }).toEqual({
        signedIn: ["Antes", "Resposta"],
        visitor: "404 errors.threadNotFound",
      });
    });
  },
);
