import { afterAll, describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import pg from "pg";
import {
  checkpointTypes,
  parseByteaArray,
  parseHexByteaArray,
} from "@/graph/checkpoint-bytea";
import { getCheckpointer, getCheckpointPool } from "@/graph/checkpointer";
import { dbProbeFailed } from "@/tests/db-gate";

type TypeId = Parameters<typeof pg.types.getTypeParser>[0];
const BYTEA_ARRAY = 1001 as TypeId;

const defaultParse = pg.types.getTypeParser(BYTEA_ARRAY, "text") as (
  v: string,
) => unknown;

const hex = (bytes: number[]) => `"\\\\x${Buffer.from(bytes).toString("hex")}"`;

// Every value the parser can be handed, and the default parser's answer for each: the fast path has
// to agree with it everywhere, including the shapes it hands back to it.
const CASES: Record<string, string> = {
  empty: "{}",
  "one element": `{${hex([1, 2, 3])}}`,
  "empty bytea": `{"\\\\x"}`,
  "a null": `{NULL,${hex([9])}}`,
  "two dimensions, as array_agg(array[...]) writes": `{{${hex([104, 105])},${hex([0])},${hex([255, 254])}},{${hex([7])},NULL,"\\\\x"}}`,
  "three dimensions": `{{{${hex([1])}}},{{${hex([2])}}}}`,
  "escape output, not hex": `{"abc\\\\\\\\001"}`,
  "escape output with hex digits past its third character": `{"abc1234"}`,
  "lower-bound prefix": `[0:1]={${hex([1])},${hex([2])}}`,
  "uppercase hex digits": `{"\\\\xABCD"}`,
};

describe("parseByteaArray", () => {
  for (const [name, text] of Object.entries(CASES)) {
    test(`${name}: the same value the default parser returns`, () => {
      expect(parseByteaArray(text)).toEqual(defaultParse(text) as never);
    });
  }

  test("an odd or non-hex digit is the default parser's to answer", () => {
    for (const text of [`{"\\\\xabc"}`, `{"\\\\xzz"}`]) {
      expect(parseByteaArray(text)).toEqual(defaultParse(text) as never);
    }
  });

  test("unbalanced text throws as the default parser throws", () => {
    expect(() => defaultParse(`{{${hex([1])}}`)).toThrow();
    expect(() => parseByteaArray(`{{${hex([1])}}`)).toThrow();
  });

  // Which texts take the fast path. A fallback returns the default parser's value, so the output alone
  // cannot tell the two paths apart: the shape Postgres writes for a `bytea[]` has to be read here,
  // and everything else has to be left to the default parser.
  const FAST: Record<string, boolean> = {
    empty: true,
    "one element": true,
    "empty bytea": true,
    "a null": true,
    "two dimensions, as array_agg(array[...]) writes": true,
    "three dimensions": true,
    "uppercase hex digits": true,
    "escape output, not hex": false,
    "escape output with hex digits past its third character": false,
    "lower-bound prefix": false,
  };
  test("the shapes Postgres writes in hex are read by the fast path, and nothing else is", () => {
    expect(Object.keys(FAST).sort()).toEqual(Object.keys(CASES).sort());
    for (const [name, fast] of Object.entries(FAST)) {
      expect([
        name,
        parseHexByteaArray(CASES[name] as string) !== null,
      ]).toEqual([name, fast]);
    }
    for (const text of [
      `{${hex([1])}}x`,
      `{${hex([1])}}{}`,
      `{${hex([1])} }`,
      `{{${hex([1])}}`,
    ]) {
      expect([text, parseHexByteaArray(text)]).toEqual([text, null]);
    }
  });

  test("a megabyte blob comes back whole", () => {
    const blob = Buffer.alloc(1_000_000, 0x61);
    const text = `{{${hex([1])},${hex([2])},"\\\\x${blob.toString("hex")}"}}`;
    const parsed = parseHexByteaArray(text) as Buffer[][];
    expect(parsed[0]?.[2]?.equals(blob)).toBe(true);
  });

  test("leaves every other type to pg", () => {
    expect(checkpointTypes.getTypeParser(1001)).toBe(parseByteaArray);
    expect(checkpointTypes.getTypeParser(1001, "binary")).toBe(
      pg.types.getTypeParser(BYTEA_ARRAY, "binary"),
    );
    expect(checkpointTypes.getTypeParser(17)).toBe(
      pg.types.getTypeParser(17, "text"),
    );
    expect(checkpointTypes.getTypeParser(3802)).toBe(
      pg.types.getTypeParser(3802, "text"),
    );
  });
});

const appUrl = process.env.TEST_APP_DATABASE_URL;
let dbUp = false;
if (appUrl) {
  try {
    const probe = new pg.Client({ connectionString: appUrl });
    await probe.connect();
    await probe.end();
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}

describe.skipIf(!dbUp)("the checkpointer's pool", () => {
  const threadId = `bytea-${process.pid}-${Date.now()}`;
  const plain = new pg.Pool({ connectionString: appUrl, max: 1 });

  afterAll(async () => {
    const saver = await getCheckpointer();
    await saver.deleteThread(threadId);
    await plain.end();
  });

  test("reads bytea[] with this parser", async () => {
    const pool = await getCheckpointPool();
    expect(pool.options.types).toBe(checkpointTypes);
  });

  test("a stored thread loads back the same, and its rows parse as the default pool parses them", async () => {
    const saver = await getCheckpointer();
    const messages = [
      new HumanMessage({ id: "h1", content: "olá ".repeat(2_000) }),
      new AIMessage({
        id: "a1",
        content: "",
        tool_calls: [{ id: "c1", name: "x", args: { q: "ç" } }],
      }),
    ];
    const cp = emptyCheckpoint();
    cp.channel_values = { messages };
    cp.channel_versions = { messages: 1 };
    const config = { configurable: { thread_id: threadId, checkpoint_ns: "" } };
    await saver.put(
      config,
      cp,
      { source: "input", step: 1, parents: {} },
      {
        messages: 1,
      },
    );
    const tuple = await saver.getTuple(config);
    const loaded = tuple?.checkpoint.channel_values.messages as typeof messages;
    expect(loaded.map((m) => [m.id, m.content])).toEqual(
      messages.map((m) => [m.id, m.content]),
    );

    const sql =
      "select array_agg(array[bl.channel::bytea, bl.type::bytea, bl.blob]) as v from langgraph.checkpoint_blobs bl where bl.thread_id = $1";
    const ours = (await (await getCheckpointPool()).query(sql, [threadId]))
      .rows[0].v;
    const theirs = (await plain.query(sql, [threadId])).rows[0].v;
    expect(ours).toEqual(theirs);
    expect(Buffer.isBuffer(ours[0][2])).toBe(true);
  });
});
