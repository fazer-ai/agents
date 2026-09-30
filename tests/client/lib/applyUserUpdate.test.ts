import { describe, expect, test } from "bun:test";
import { applyUserUpdate } from "@/client/lib/applyUserUpdate";

const bob = { id: "1", name: "Bob" };

describe("applyUserUpdate", () => {
  test("applies a change to the account that made it", () => {
    expect(applyUserUpdate(bob, "1", { name: "Robert" })?.name).toBe("Robert");
  });

  test("ignores a change from another account that landed late", () => {
    expect(applyUserUpdate(bob, "2", { name: "Alice" })).toBe(bob);
  });

  test("does nothing when signed out", () => {
    expect(
      applyUserUpdate<typeof bob>(null, "1", { name: "Robert" }),
    ).toBeNull();
  });
});
