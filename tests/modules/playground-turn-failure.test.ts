import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { refusalBody } from "@/api/lib/refusal";
import config from "@/config";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  runPlaygroundAudioTurn,
  runPlaygroundExtract,
  runPlaygroundFileTurn,
  runPlaygroundFollowup,
  runPlaygroundTurn,
} from "@/modules/playground/service";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

// Issue #841: a playground turn that fails says why, or where the reason is. The failure that
// prompted it was a database error raised while the turn was being assembled: it reached the app's
// catch-all, which answers a bare 500 in plain text, and the console threw the text away and blamed
// the model. What a failure must carry now: the turn id (for the Logs page link), the error's text
// in development only, and in production our own sentence plus a Logs line in our words.

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

// The shape of the reported failure: a server-side error with nothing to do with the model.
const SECRET_DETAIL = 'column "conversation_ref_integration_id" does not exist';
const breaks = (() => {
  throw new Error(SECRET_DETAIL);
}) as never;

let tenantId = 0n;
let agentId = 0n;
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

async function failureOf(p: Promise<unknown>): Promise<AppError> {
  const err = await p.then(
    () => {
      throw new Error("the turn did not fail");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

function inEnv<T>(env: "development" | "test", fn: () => Promise<T>) {
  const cfg = config as { env: string };
  const was = cfg.env;
  cfg.env = env;
  return fn().finally(() => {
    cfg.env = was;
  });
}

describe.skipIf(!dbUp)("a failed playground turn (issue #841)", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "PTF", slug: `ptf-841-${process.pid}` },
      })
    ).id;
    const key = (
      await suDb.vaultEntry.create({
        data: { tenantId, name: "llm", secret: encryptJson("sk-test") },
        select: { id: true },
      })
    ).id;
    agentId = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Falha",
          systemPrompt: "x",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: `vault:${key}`,
          },
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (su && tenantId) {
      await clearFlowLog(su, { tenantId });
      await su.tenant.delete({ where: { id: tenantId } });
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("outside development: our sentence and the turn id, never the error's text, and a Logs line for the turn", async () => {
    const err = await inEnv("test", () =>
      failureOf(
        runPlaygroundTurn({
          ctx: ctx(),
          agentId,
          message: "oi",
          guardrails: false,
          base: appDb,
          deps: { makeModel: breaks, checkpointer: new MemorySaver() },
        }),
      ),
    );
    expect(err.statusCode).toBe(500);
    expect(err.translationKey).toBe("errors.playgroundTurnFailed");
    expect(err.message).not.toContain("conversation_ref_integration_id");
    expect(err.turnId).toMatch(/^[0-9a-f-]{36}$/);
    // What the wire carries: the sentence in the operator's language, and the id.
    const body = refusalBody(err, "pt-BR");
    expect(body.error).toContain("log do servidor");
    expect(body.turnId).toBe(err.turnId);

    const rows = await flowLogRows(suDb, {
      where: { tenantId, turnId: err.turnId as string, stage: "generate" },
      select: { level: true, status: true, source: true, errorMessage: true },
    });
    expect(
      rows.map(({ level, status, source, errorMessage }) => ({
        level,
        status,
        source,
        errorMessage,
      })),
    ).toEqual([
      {
        level: "error",
        status: "error",
        source: "playground",
        errorMessage: "unhandled server error",
      },
    ]);
  });

  test("in development: the error's own text, with the turn id", async () => {
    const err = await inEnv("development", () =>
      failureOf(
        runPlaygroundTurn({
          ctx: ctx(),
          agentId,
          message: "oi",
          guardrails: false,
          base: appDb,
          deps: { makeModel: breaks, checkpointer: new MemorySaver() },
        }),
      ),
    );
    expect(err.message).toContain(SECRET_DETAIL);
    expect(err.translationKey).toBeUndefined();
    expect(err.turnId).toMatch(/^[0-9a-f-]{36}$/);
    expect(refusalBody(err, "en").turnId).toBe(err.turnId);
  });

  test("a refusal the code raised keeps its own words and gains the turn id", async () => {
    const err = await failureOf(
      runPlaygroundTurn({
        ctx: ctx(),
        agentId,
        message: "   ",
        base: appDb,
      }),
    );
    expect(err.statusCode).toBe(400);
    expect(err.translationKey).toBe("errors.emptyMessage");
    expect(err.turnId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("the follow-up, voice, file and read entry points report the same way", async () => {
    const png = new File(
      [
        Uint8Array.from(
          atob(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          ),
          (c) => c.charCodeAt(0),
        ),
      ],
      "nota.png",
      { type: "image/png" },
    );
    const deps = { makeModel: breaks, checkpointer: new MemorySaver() };
    const failures = await inEnv("test", () =>
      Promise.all([
        failureOf(
          runPlaygroundFollowup({
            ctx: ctx(),
            agentId,
            guardrails: false,
            base: appDb,
            deps,
          }),
        ),
        failureOf(
          runPlaygroundAudioTurn({
            ctx: ctx(),
            agentId,
            file: new File([new Uint8Array(8)], "voz.webm", {
              type: "audio/webm",
            }),
            transcription: "oi",
            guardrails: false,
            base: appDb,
            deps,
          }),
        ),
        failureOf(
          runPlaygroundFileTurn({
            ctx: ctx(),
            agentId,
            file: png,
            kind: "image",
            extracted: "uma nota",
            guardrails: false,
            base: appDb,
            deps,
          }),
        ),
      ]),
    );
    for (const err of failures) {
      expect(err.translationKey).toBe("errors.playgroundTurnFailed");
      expect(err.turnId).toMatch(/^[0-9a-f-]{36}$/);
    }
    // The read step: a file past the size limit is refused before any read, and still names its turn.
    const tooBig = {
      name: "grande.png",
      type: "image/png",
      size: 30 * 1024 * 1024,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as File;
    const read = await failureOf(
      runPlaygroundExtract({
        ctx: ctx(),
        agentId,
        file: tooBig,
        base: appDb,
      }),
    );
    expect(read.statusCode).toBe(413);
    expect(read.turnId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
