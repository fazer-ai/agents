import { describe, expect, test } from "bun:test";
import {
  issuePlaygroundCallTicket,
  readPlaygroundCallTicket,
} from "@/modules/voice-call/playground";

const ctx = { tenantId: 7n, userId: 3n, role: "TENANT_ADMIN" as const };
const NOW = 1_800_000_000_000;

describe("the ticket that opens a playground call", () => {
  test("names the tenant, the agent and the operator it was issued for", () => {
    const ticket = issuePlaygroundCallTicket(ctx, 42n, NOW);
    expect(readPlaygroundCallTicket(ticket, NOW + 1_000)).toEqual({
      tenantId: 7n,
      agentId: 42n,
      userId: 3n,
    });
  });

  test("expires after a minute", () => {
    const ticket = issuePlaygroundCallTicket(ctx, 42n, NOW);
    expect(readPlaygroundCallTicket(ticket, NOW + 59_999)).not.toBeNull();
    expect(readPlaygroundCallTicket(ticket, NOW + 60_000)).toBeNull();
  });

  test.each([
    ["another agent", (t: string) => t.replace(/^7\.42\./, "7.43.")],
    ["another tenant", (t: string) => t.replace(/^7\./, "8.")],
    [
      "a later expiry",
      (t: string) => t.replace(/\.(\d+)\.([^.]+)$/, ".9$1.$2"),
    ],
    ["a truncated signature", (t: string) => t.slice(0, -2)],
    ["a missing part", (t: string) => t.split(".").slice(1).join(".")],
  ])("refuses a ticket edited to name %s", (_, edit) => {
    const ticket = issuePlaygroundCallTicket(ctx, 42n, NOW);
    expect(edit(ticket)).not.toBe(ticket);
    expect(readPlaygroundCallTicket(edit(ticket), NOW)).toBeNull();
  });

  test("refuses a context with no tenant", () => {
    expect(() =>
      issuePlaygroundCallTicket({ ...ctx, tenantId: null }, 42n, NOW),
    ).toThrow();
  });
});
