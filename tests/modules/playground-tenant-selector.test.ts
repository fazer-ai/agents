import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import type { PrismaClient as PrismaClientType } from "@/../generated/prisma/client";
import { PrismaClient } from "@/../generated/prisma/client";
import { getCheckpointer } from "@/graph/checkpointer";
import { ActiveTenantNotFoundError, AppError } from "@/lib/errors";
import { resolveRequestTenantContext, type TenantContext } from "@/lib/tenancy";
import {
  getPlaygroundMedia,
  listThreadMedia,
} from "@/modules/playground/media";
import {
  listPlaygroundTools,
  runPlaygroundFollowup,
  runPlaygroundTurn,
} from "@/modules/playground/service";
import {
  deletePlaygroundSession,
  getPlaygroundSessionTurns,
  listPlaygroundSessions,
} from "@/modules/playground/sessions";
import { listThreadTurnNotes } from "@/modules/playground/turn-notes";
import { transcribePlaygroundAudio } from "@/modules/stt/service";
import { extractPlaygroundFile } from "@/modules/vision/service";

// The playground was the one console surface that took the caller's tenant selector and handed it to
// the database as an internally-trusted id, so the gate #223 put at `runScopedOn` never applied to
// it. Every module rebuilt a context from the raw id (`sysCtx(tenantId)` -> role TENANT_ADMIN), and
// the role IS the predicate: it is what separates an id that came from outside the process from one
// this process read from a row.
//
// Measured before the change, against this database, with a selector naming a tenant that does not
// exist. Five of the six entry points answered as though the tenant were real and merely empty:
//
//   listPlaygroundSessions   -> []          getPlaygroundMedia    -> null
//   listThreadMedia          -> []          listThreadTurnNotes   -> []
//   deletePlaygroundSession  -> undefined (a delete that "succeeded" on a tenant with no rows)
//
// while the same selector on any other route answered 404 `ActiveTenantNotFoundError`. The sixth,
// getPlaygroundSessionTurns, did refuse, but for the wrong fact: its own session fence answered
// "session not found", which tells the console nothing about the selector it is carrying and so
// cannot trigger the recovery #265 added.
//
// The fix is to stop lying to the gate rather than to add a second one: the request's context goes
// all the way down, so a TENANT_ADMIN operator still pays nothing (the role short-circuits the
// check) and a fleet operator's dead selection is refused at the first scoped read. Issue #268.

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

afterAll(async () => {
  await su?.$disconnect();
  await app?.$disconnect();
});

let liveId = 0n;
let deadId = 0n;
const agentId = 1n;

// The context the REST boundary actually builds from the header, rather than one written by hand:
// what makes this reachable is that the selector is a string the browser persists.
function fromSelector(tenantId: bigint): TenantContext {
  const { context } = resolveRequestTenantContext(
    { id: 1n, tenantId: null, role: "SUPER_ADMIN" },
    String(tenantId),
  );
  if (!context) throw new Error("the boundary refused a SUPER_ADMIN principal");
  return context;
}

// What a console operator carries: a tenant-scoped principal, whose id this process read from a row.
function operator(tenantId: bigint): TenantContext {
  return { tenantId, userId: 1n, role: "TENANT_ADMIN" };
}

function thread(tenantId: bigint): string {
  return `${tenantId}:playground:${agentId}:00000000-0000-4000-8000-000000000000`;
}

// Counts the existence check, so "a console operator does not pay for this" is measured rather than
// asserted.
function counting(base: PrismaClient) {
  const seen = { tenantFindUnique: 0 };
  const client = base.$extends({
    query: {
      tenant: {
        findUnique({ args, query }) {
          seen.tenantFindUnique += 1;
          return query(args);
        },
      },
    },
  });
  return { client: client as unknown as PrismaClientType, seen };
}

describe.skipIf(!dbUp)(
  "a playground call carrying a dead tenant selector",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "PgSelector", slug: `pgsel-${process.pid}` },
      });
      liveId = t.id;
      const max = await suDb.$queryRaw<
        { m: bigint | null }[]
      >`SELECT MAX(id) AS m FROM tenants`;
      deadId = (max[0]?.m ?? 0n) + 1_000_000n;
    });

    afterAll(async () => {
      if (liveId) await suDb.tenant.deleteMany({ where: { id: liveId } });
    });

    // One row per entry point the controller reaches, because the defect was per call site: the
    // decision lives in `runScopedOn` and what this pins is that each of these actually reaches it
    // with the caller's context.
    const entryPoints: Array<
      [string, (ctx: TenantContext) => Promise<unknown>]
    > = [
      [
        "listPlaygroundSessions",
        (ctx) => listPlaygroundSessions(ctx, agentId, appDb),
      ],
      [
        "getPlaygroundSessionTurns",
        (ctx) =>
          getPlaygroundSessionTurns(
            ctx,
            agentId,
            thread(ctx.tenantId as bigint),
            appDb,
          ),
      ],
      [
        "deletePlaygroundSession",
        (ctx) =>
          deletePlaygroundSession(
            ctx,
            agentId,
            thread(ctx.tenantId as bigint),
            appDb,
          ),
      ],
      ["getPlaygroundMedia", (ctx) => getPlaygroundMedia(ctx, 1n, appDb)],
      [
        "listThreadMedia",
        (ctx) => listThreadMedia(ctx, thread(ctx.tenantId as bigint), appDb),
      ],
      [
        "listThreadTurnNotes",
        (ctx) =>
          listThreadTurnNotes(appDb, ctx, thread(ctx.tenantId as bigint)),
      ],
      // The three the MCP transport reaches as well as the console. They refuse before a model is
      // ever built: the first thing a turn does is load the agent's config, and that is a scoped
      // read. No `deps` here on purpose, so a row that stopped refusing would fail on the missing
      // model rather than pass quietly.
      [
        "runPlaygroundTurn",
        (ctx) =>
          runPlaygroundTurn({ ctx, agentId, message: "oi", base: appDb }),
      ],
      [
        "runPlaygroundFollowup",
        (ctx) => runPlaygroundFollowup({ ctx, agentId, base: appDb }),
      ],
      [
        "listPlaygroundTools",
        (ctx) => listPlaygroundTools({ ctx, agentId, base: appDb }),
      ],
      // The attachment preprocessing, which lives in the stt/vision modules rather than here and so
      // is NOT covered by the source ledger below: those two files keep their `sysCtx` for the
      // INBOUND path, whose tenant id this process read from a row. Only the playground pair takes
      // the caller's context. No `settings` on purpose: a draft's settings short-circuit the config
      // read, and the read is the whole point of the row.
      [
        "transcribePlaygroundAudio",
        (ctx) =>
          transcribePlaygroundAudio({
            ctx,
            agentId,
            audio: new ArrayBuffer(8),
            mimeType: "audio/webm",
            base: appDb,
          }),
      ],
      [
        "extractPlaygroundFile",
        (ctx) =>
          extractPlaygroundFile({
            ctx,
            agentId,
            file: new ArrayBuffer(8),
            mimeType: "image/png",
            base: appDb,
          }),
      ],
    ];

    for (const [name, call] of entryPoints) {
      test(`${name} refuses it, naming the selector`, async () => {
        const err = await call(fromSelector(deadId)).catch((e: unknown) => e);
        expect(err instanceof AppError).toBe(true);
        const appErr = err as AppError;
        expect(appErr.statusCode).toBe(404);
        // Not merely "a 404": the class that says WHICH fact is wrong. `errors.sessionNotFound` is
        // also a 404 here and tells the console nothing about the selection it has stored.
        expect(err instanceof ActiveTenantNotFoundError).toBe(true);
        expect((err as ActiveTenantNotFoundError).rejectedTenantId).toBe(
          String(deadId),
        );
      });
    }

    // The refusal has to land BEFORE the one thing on this path that is not scoped by anything.
    //
    // `deletePlaygroundSession` drops the checkpointer thread first on purpose (a delete that took our
    // rows and left the thread would leave the orphan the fence exists to prevent). The checkpointer
    // lives in its own schema, outside RLS, with no foreign key to `tenants`, so a tenant's playground
    // threads OUTLIVE the tenant row. That is what makes a stale selector able to name a thread that
    // still exists, and what would have made a request that reports itself refused erase a transcript
    // on the way there.
    test("it refuses before erasing the checkpointer thread it is allowed to name", async () => {
      const dead = deadId;
      const threadId = thread(dead);
      const cp = await getCheckpointer();
      await cp.put(
        { configurable: { thread_id: threadId, checkpoint_ns: "" } },
        {
          v: 4,
          id: `ck-${process.pid}`,
          ts: new Date().toISOString(),
          channel_values: {},
          channel_versions: {},
          versions_seen: {},
        } as never,
        { source: "input", step: -1, parents: {} } as never,
        {},
      );
      // The premise, measured rather than assumed: the thread is there while its tenant is not.
      expect(
        await cp.getTuple({ configurable: { thread_id: threadId } }),
      ).toBeDefined();

      try {
        const err = await deletePlaygroundSession(
          fromSelector(dead),
          agentId,
          threadId,
          appDb,
        ).catch((e: unknown) => e);
        expect(err instanceof ActiveTenantNotFoundError).toBe(true);
        // And the transcript is still there. Before the fix this came back undefined: the refusal
        // arrived, after the erase.
        expect(
          await cp.getTuple({ configurable: { thread_id: threadId } }),
        ).toBeDefined();
      } finally {
        await cp.deleteThread(threadId);
      }
    });

    test("a live selector still answers, and pays one statement for the check", async () => {
      const { client, seen } = counting(appDb);
      const out = await listPlaygroundSessions(
        fromSelector(liveId),
        agentId,
        client,
      );
      expect(out).toEqual([]);
      expect(seen.tenantFindUnique).toBe(1);
    });

    test("a console operator pays nothing, because the role is the predicate", async () => {
      const { client, seen } = counting(appDb);
      const out = await listPlaygroundSessions(
        operator(liveId),
        agentId,
        client,
      );
      expect(out).toEqual([]);
      expect(seen.tenantFindUnique).toBe(0);
    });
  },
);

// The half a decision table cannot cover. Everything above proves the FUNCTIONS refuse; it says
// nothing about whether the next entry point added to this module rebuilds a context again, which
// is exactly how the defect got in (#205). What is pinned here is that nowhere under
// `src/modules/playground/` does a context get MADE: every one of them arrives from the caller.
//
// The predicate is extracted rather than inlined so the fence can be shown to catch something. A
// sweep with no offender left in the tree passes whether or not it works (#266), so the fixture
// below is the positive control: it is the exact shape that was in all four files.
export function buildsATenantContext(source: string): boolean {
  return /\brole:\s*"(?:TENANT_ADMIN|SUPER_ADMIN)"/.test(source);
}

describe("no playground module builds a tenant context of its own", () => {
  const OFFENDER = `function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}`;

  test("the predicate catches the shape that was there", () => {
    expect(buildsATenantContext(OFFENDER)).toBe(true);
    expect(
      buildsATenantContext(
        "await runScopedOn(base, ctx, (db) => db.x.findMany())",
      ),
    ).toBe(false);
  });

  test("no file under src/modules/playground builds one", async () => {
    const { Glob } = await import("bun");
    const offenders: string[] = [];
    for await (const rel of new Glob("**/*.ts").scan(
      "src/modules/playground",
    )) {
      const src = await Bun.file(`src/modules/playground/${rel}`).text();
      if (buildsATenantContext(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
