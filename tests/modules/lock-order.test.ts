import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Round 29. An agent import takes the tenant's tool-name lock ONCE, before it touches any tool row
// (createMissingComponents in modules/agents/transfer.ts), and then reads and writes rows under it.
// Every other path that takes both locks has to take them in that order, or the two deadlock: the
// update holds the row and waits for the namespace while the import holds the namespace and waits
// for the row. Postgres notices and kills one of them, so the operator loses a whole import to a
// concurrent save of an unrelated tool.
//
// A SOURCE fence, and deliberately so. Reproducing the deadlock needs two transactions interleaved
// at a specific instant, which is a flaky test; what actually has to hold is a property of the code
// -- one statement precedes another -- and that is what is read here. The failure this catches is
// someone adding a row lock above the namespace lock, which reads as harmless in a diff.
const PATHS: Array<[string, string]> = [
  ["src/modules/tool-definitions/service.ts", "tool_definitions"],
  ["src/modules/code-tools/service.ts", "code_tool_definitions"],
  ["src/modules/documents/templates.ts", "document_templates"],
];

describe("the namespace lock is taken before any row lock", () => {
  for (const [file, table] of PATHS) {
    test(file, () => {
      const src = readFileSync(file, "utf8");
      // EVERY row lock in the file, not the first: the delete path takes the lock for a different
      // reason than the update (an import resolves a grant and inserts under it, and a delete
      // committing in that window fails a foreign key already read, aborting the whole import),
      // and a fence that only read the first would go green while the delete raced (round 30).
      const needle = `SELECT 1 FROM "${table}" WHERE "id" =`;
      const at: number[] = [];
      for (
        let i = src.indexOf(needle);
        i !== -1;
        i = src.indexOf(needle, i + 1)
      ) {
        at.push(i);
      }
      expect(at.length).toBeGreaterThan(1);
      for (const select of at) {
        // The statement, not the string inside it.
        const rowLock = src.lastIndexOf("await db.$queryRaw", select);
        expect(rowLock).toBeGreaterThan(-1);
        const nsLock = src.lastIndexOf("await lockToolNames(db);", rowLock);
        expect(nsLock).toBeGreaterThan(-1);
        // ...and nothing awaits the database in between, so a later edit that slips a query
        // between them is visible rather than hidden by distance.
        expect(src.slice(nsLock, rowLock)).not.toContain("await db.");
      }
    });
  }
});
