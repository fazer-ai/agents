import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import { clearFlowLog } from "@/tests/utils/flowlog";

// THE EFFECT THE ISSUE NAMES: the stage line is not there.
//
// `execution_logs.detail` is a `jsonb` column, and Postgres refuses an unpaired surrogate inside one
// outright ("Unicode low surrogate must follow a high surrogate", SQLSTATE 22P02). `emitFlowEvent` is
// fire-and-forget with a catch, so the refusal never reaches the turn: the write is dropped, a warn
// goes to the process log, and the line the operator later goes looking for simply does not exist.
//
// Two ways in, and the second is why fixing the cut alone would not have been enough:
//   1. a `detail` string long enough to be truncated, cut between the halves of an emoji;
//   2. a `detail` string that ALREADY holds an orphan half, no truncation involved — any JSON source
//      that spells one out (`"\ud800"`) hands `JSON.parse` one directly, which is an ordinary thing
//      for an HTTP tool's response body to do.
//
// Asserted at the row, not at the redactor, because "the redactor returns a clean string" is a proxy
// for the thing that was actually broken.

const suUrl = process.env.MIGRATION_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (suUrl && appUrl) {
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

// `emitFlowEvent` returns before the row is written, by design. Poll rather than sleep a fixed
// amount: a fixed sleep either flakes on a slow machine or wastes the difference on a fast one.
async function rowFor(turnId: string): Promise<unknown | null> {
  for (let i = 0; i < 100; i++) {
    const row = await suDb.executionLog.findFirst({
      where: { tenantId, turnId },
    });
    if (row) return row.detail;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

function loneSurrogates(s: string): number {
  let n = 0;
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (ch.length === 1 && code >= 0xd800 && code <= 0xdfff) n++;
  }
  return n;
}

describe.skipIf(!dbUp)("execution_logs.detail survives bad characters", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "Astral", slug: `astral-${process.pid}` },
      })
    ).id;
  });
  afterAll(async () => {
    if (!dbUp) return;
    await clearFlowLog(suDb, { tenantId });
    await suDb.tenant.delete({ where: { id: tenantId } });
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  function flow(turnId: string): FlowContext {
    return { tenantId, turnId, source: "inbox", base: appDb };
  }

  test("a detail string long enough to be truncated still produces a row", async () => {
    // The emoji straddles the 2000-unit truncation: its high half is the last unit kept.
    const straddling = `${"x".repeat(1999)}😀${"y".repeat(50)}`;
    emitFlowEvent(flow("astral-cut"), {
      stage: "tool",
      detail: { output: straddling },
    });
    const detail = (await rowFor("astral-cut")) as { output: string } | null;
    expect(detail).not.toBeNull();
    expect(loneSurrogates(detail?.output ?? "")).toBe(0);
  });

  test("a detail string that already holds an orphan half still produces a row", async () => {
    // Exactly what an HTTP tool's response body hands `JSON.parse`.
    const parsed = JSON.parse('{"body":"pre\\ud800post"}') as {
      body: string;
    };
    expect(loneSurrogates(parsed.body)).toBe(1);
    emitFlowEvent(flow("astral-orphan"), {
      stage: "tool",
      detail: parsed,
    });
    const detail = (await rowFor("astral-orphan")) as { body: string } | null;
    expect(detail).not.toBeNull();
    expect(loneSurrogates(detail?.body ?? "")).toBe(0);
  });

  test("an orphan half in a detail KEY still produces a row", async () => {
    // A key is written by whoever produced the object — the model's tool-call arguments, a third
    // party's JSON response — and Postgres refuses the document over a key just as readily.
    const parsed = JSON.parse('{"pre\\ud800post":1}') as Record<string, number>;
    expect(loneSurrogates(Object.keys(parsed)[0] ?? "")).toBe(1);
    emitFlowEvent(flow("astral-key"), { stage: "tool", detail: parsed });
    const detail = (await rowFor("astral-key")) as Record<
      string,
      number
    > | null;
    expect(detail).not.toBeNull();
    expect(loneSurrogates(Object.keys(detail ?? {})[0] ?? "")).toBe(0);
  });

  // ── the other two things the column refuses, and the one that CORRUPTS (#241) ──
  // Same destination, same walker, and neither is covered by the surrogate repair above.

  test("a NUL in a detail value still produces a row", async () => {
    // A JSON body spells out a NUL as readily as an orphan half, and `jsonb` refuses it just as
    // flatly (22P05). `emitFlowEvent` swallows the refusal, so the only symptom is the missing line.
    const NUL = String.fromCharCode(0);
    emitFlowEvent(flow("nul-value"), {
      stage: "tool",
      detail: { output: `pre${NUL}post` },
    });
    const detail = (await rowFor("nul-value")) as { output: string } | null;
    expect(detail).not.toBeNull();
    expect(detail?.output).toBe("prepost");
  });

  test("a NUL in a detail KEY still produces a row", async () => {
    const parsed = JSON.parse('{"pre\\u0000post":1}') as Record<string, number>;
    emitFlowEvent(flow("nul-key"), { stage: "tool", detail: parsed });
    const detail = (await rowFor("nul-key")) as Record<string, number> | null;
    expect(detail).not.toBeNull();
    expect(Object.keys(detail ?? {})).toEqual(["prepost"]);
  });

  test("a `__proto__` key does not put a field nobody wrote into the record", async () => {
    // The one case that is not a loss. `JSON.parse` yields `__proto__` as an ordinary own
    // property, and assignment on that key invokes the legacy prototype setter instead of
    // creating a field. Prisma's serialization then enumerates INHERITED properties, so the
    // contents were written as top-level fields: measured before the fix, this row stored
    // {"keep":"x","leaked":1}, a field nobody wrote in a record that reads as authoritative.
    //
    // What is asserted is the ABSENCE of `leaked`, not the presence of `__proto__`. Keeping it an
    // own property is what this fixes, and Prisma drops that key on the way to the column either
    // way (measured: the column holds `{"keep": "x"}`). Trading a corrupted record for a record
    // missing one field is the whole of the win, and asserting the key would pin behaviour that
    // belongs to the driver rather than to us.
    const parsed = JSON.parse('{"__proto__":{"leaked":1},"keep":"x"}');
    emitFlowEvent(flow("proto-key"), { stage: "tool", detail: parsed });
    const detail = (await rowFor("proto-key")) as Record<
      string,
      unknown
    > | null;
    expect(detail).not.toBeNull();
    expect(detail).not.toHaveProperty("leaked");
    expect(detail).toEqual({ keep: "x" });
  });

  test("a whole emoji still reaches the row intact", async () => {
    // The guard against fixing this by scrubbing every surrogate: an emoji in a tool result is
    // ordinary, and it must survive.
    emitFlowEvent(flow("astral-intact"), {
      stage: "tool",
      detail: { output: "tudo certo 😀🎉" },
    });
    const detail = (await rowFor("astral-intact")) as {
      output: string;
    } | null;
    expect(detail?.output).toBe("tudo certo 😀🎉");
  });
});
