import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// An agent import takes the tenant's tool-name lock ONCE, before it touches any tool row
// (createMissingComponents in modules/agents/transfer.ts), then reads and writes rows under it. Every
// other path that takes both locks takes them in that order, or the two deadlock (row held, waiting
// for the namespace, against namespace held, waiting for the row) and Postgres kills one, losing a
// whole import to a concurrent save of an unrelated tool. A SOURCE fence on purpose: reproducing the
// deadlock needs a flaky interleaving, and what has to hold is that one statement precedes another.
// It catches a row lock added above the namespace lock, which reads as harmless in a diff.
const PATHS: Array<[string, string]> = [
  ["src/modules/tool-definitions/service.ts", "tool_definitions"],
  ["src/modules/code-tools/service.ts", "code_tool_definitions"],
  ["src/modules/documents/templates.ts", "document_templates"],
];

describe("the namespace lock is taken before any row lock", () => {
  for (const [file, table] of PATHS) {
    test(file, () => {
      const src = readFileSync(file, "utf8");
      // EVERY row lock in the file, not the first: the delete path takes the lock for a different reason
      // than the update (an import resolves a grant and inserts under it, and a delete committing in that
      // window fails a foreign key already read, aborting the whole import), and a fence that only read
      // the first would go green while the delete raced.
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

  // NOTE: The fourth path, and the one that takes NO row lock on a tool: it locks the AGENT row, deletes the
  // selection rows, and only then asks the foreign key for the tool, which is enough to close the cycle
  // against a delete holding the tool row (`tests/modules/grant-target-vanishes.test.ts` forces it).
  // The lock comes first here for the same reason, so the fence reads the same property against the
  // agent's lock.
  test("src/modules/agents/service.ts (grant replacement)", () => {
    const src = readFileSync("src/modules/agents/service.ts", "utf8");
    const rowLock = src.indexOf("SELECT updated_at FROM agents WHERE id =");
    expect(rowLock).toBeGreaterThan(-1);
    const stmt = src.lastIndexOf("await db.$queryRaw", rowLock);
    expect(stmt).toBeGreaterThan(-1);
    const nsLock = src.lastIndexOf("await lockToolNames(db);", stmt);
    expect(nsLock).toBeGreaterThan(-1);
    expect(src.slice(nsLock, stmt)).not.toContain("await db.");
  });
});
