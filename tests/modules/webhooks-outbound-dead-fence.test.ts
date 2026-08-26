import { describe, expect, test } from "bun:test";

// ── EVERY ROAD TO DEAD GOES THROUGH THE ONE THAT ANNOUNCES IT (issue #325) ──
// The fix collapsed two DEAD writes into `finalizeDead`, which writes the row AND emits the line.
// That is the correction; this is what keeps it. The two sites did not disagree because anyone
// decided they should — they were written a year apart and neither had a line to forget, so a third
// one added the same way would be silent again and nothing would say so.
//
// A source sweep, because the alternative (a runtime assertion) can only fire on a path a test
// already drives, and the whole failure mode here is the path nobody thought to drive.

const OUTBOUND_DIR = "src/modules/webhooks/outbound";

// A write of the DEAD status, in the two spellings TypeScript accepts for a Prisma enum column: the
// string literal the codebase uses, and the generated enum member. Reads (`where: { status: … }`)
// are deliberately NOT matched — asking which deliveries are dead is a question, not a death, and
// #305 will add exactly such a reader.
const DEAD_WRITE =
  /(?<!where:\s*\{[^}]{0,80})status:\s*(?:"DEAD"|'DEAD'|WebhookDeliveryStatus\.DEAD)/;

const FUNCTION_DECL = /(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/;

// Exported for its own positive control: a sweep that finds nothing passes identically whether the
// codebase is clean or the predicate is broken, so the predicate has to be shown finding something.
export function deadWriteFunctions(source: string): string[] {
  const lines = source.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trimStart().startsWith("//")) continue;
    if (!DEAD_WRITE.test(line)) continue;
    let enclosing = "<top level>";
    for (let j = i; j >= 0; j--) {
      const m = FUNCTION_DECL.exec(lines[j] as string);
      if (m) {
        enclosing = m[1] as string;
        break;
      }
    }
    out.push(enclosing);
  }
  return out;
}

describe("the DEAD write fence", () => {
  test("positive control: the predicate sees a stray write, and names the function it is in", () => {
    const fixture = `
async function finalizeDead(base, d) {
  await db.outboundWebhookDelivery.update({ data: { status: "DEAD" } });
}
async function someNewPath(base, d) {
  await db.outboundWebhookDelivery.update({ data: { status: "DEAD" } });
}
`;
    expect(deadWriteFunctions(fixture)).toEqual([
      "finalizeDead",
      "someNewPath",
    ]);
  });

  test("positive control: the enum spelling counts too, and a read does not", () => {
    const write = `function f() { await u({ data: { status: WebhookDeliveryStatus.DEAD } }); }`;
    expect(deadWriteFunctions(write)).toEqual(["f"]);
    const read = `function g() { await m({ where: { status: "DEAD" } }); }`;
    expect(deadWriteFunctions(read)).toEqual([]);
  });

  test("positive control: a commented-out write is not a write", () => {
    expect(
      deadWriteFunctions(`function f() {\n  // status: "DEAD"\n}`),
    ).toEqual([]);
  });

  test("every DEAD write in the outbound module is inside finalizeDead", async () => {
    const files = [...new Bun.Glob("*.ts").scanSync(OUTBOUND_DIR)].map(
      (f) => `${OUTBOUND_DIR}/${f}`,
    );
    expect(files.length).toBeGreaterThan(0);
    const sites: string[] = [];
    for (const f of files) {
      const source = await Bun.file(f).text();
      for (const fn of deadWriteFunctions(source)) sites.push(`${f}:${fn}`);
    }
    // Read at assertion time from the real tree, never from a snapshot.
    expect(sites).toEqual([
      "src/modules/webhooks/outbound/worker.ts:finalizeDead",
    ]);
  });
});
