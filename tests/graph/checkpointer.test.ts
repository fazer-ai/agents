import { describe, expect, test } from "bun:test";
import {
  chatwootThreadId,
  contactInboxThreadId,
  resolveGraphThreadId,
  threadBelongsToTenant,
} from "@/graph/checkpointer";
import { MAX_DB_ID } from "@/lib/db-id";

describe("graph thread keys", () => {
  test("contactInboxThreadId namespaces by tenant:instance:ci", () => {
    expect(contactInboxThreadId(3n, 5n, 7700)).toBe("3:5:ci:7700");
  });

  test("chatwootThreadId is the per-conversation key", () => {
    expect(chatwootThreadId(3n, 5n, 42)).toBe("3:5:42");
  });

  test("resolveGraphThreadId prefers the contact-inbox key when present", () => {
    expect(resolveGraphThreadId(3n, 5n, 42, 7700)).toBe("3:5:ci:7700");
  });

  test("resolveGraphThreadId degrades to the per-conversation key when contactInboxId is null", () => {
    // Not a second key scheme — just null handling on a nullable column. No contact+inbox composite.
    expect(resolveGraphThreadId(3n, 5n, 42, null)).toBe("3:5:42");
  });

  test("both thread keys carry the tenant fence (threadBelongsToTenant)", () => {
    expect(threadBelongsToTenant(contactInboxThreadId(3n, 5n, 7700), 3n)).toBe(
      true,
    );
    expect(threadBelongsToTenant(contactInboxThreadId(3n, 5n, 7700), 4n)).toBe(
      false,
    );
    expect(threadBelongsToTenant(chatwootThreadId(3n, 5n, 42), 3n)).toBe(true);
  });

  // NOTE: The fence and `parseThreadId` read the same prefix, so they must read it the same way, or
  // a thread one accepts is a thread the other drops. Both take the bounded parse: a prefix that a
  // bare `BigInt` would convert to the tenant's id by another spelling (` 3 `) does not pass, nor one
  // past what the column holds. Fails closed: the fence stands in for RLS on the checkpointer tables.
  test("the fence reads the prefix the way parseThreadId does", () => {
    for (const prefix of [" 3 ", "+3", "0x3", "3.0", ""]) {
      expect(threadBelongsToTenant(`${prefix}:5:42`, 3n)).toBe(false);
    }
    expect(threadBelongsToTenant(`${MAX_DB_ID + 1n}:5:42`, 3n)).toBe(false);
    // Leading zeros are the one spelling that still passes, and deliberately so: `parseDbId` takes
    // them, `003` IS tenant 3, and a fence that dropped it would drop a thread the reader beside it
    // still resolves. The two agreeing is the property, not strictness for its own sake.
    expect(threadBelongsToTenant("003:5:42", 3n)).toBe(true);
    // The control: the canonical spelling every thread id is actually built with still passes.
    expect(threadBelongsToTenant("3:5:42", 3n)).toBe(true);
  });
});
