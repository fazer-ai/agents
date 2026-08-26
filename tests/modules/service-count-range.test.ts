import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import { getUsers } from "@/api/features/admin/admin.service";
import type { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import { listAudit } from "@/modules/audit/service";
import { listConversations } from "@/modules/conversations/service";
import { exportExecutionLogs } from "@/modules/flowlog/export";
import { listExecutionLogs } from "@/modules/flowlog/read";

// ── THE RANGE IS THE SERVICE'S, WHICH IS THE HALF REST CANNOT PROVE ──
//
// The query parser refuses a malformed count before any service runs, so an assertion driven over
// HTTP passes with the service's own check deleted — measured: two mutations survived a green
// 26-case HTTP matrix. MCP and the console's internal calls arrive HERE with a plain number and no
// query string, so this is the layer that decides for them.
//
// No database: every one of these refuses before it reaches a query, and `base` is a witness to
// that — a poisoned client that throws if anything touches it.
const poisoned = new Proxy(
  {},
  {
    get() {
      throw new Error("the service reached the database before refusing");
    },
  },
) as PrismaClient;

const ctx: TenantContext = { tenantId: 1n, userId: 1n, role: "TENANT_ADMIN" };

const REFUSED = [0, -1, -5, 1.5, Number.NaN];

const CALLS: Array<[name: string, run: (limit: number) => Promise<unknown>]> = [
  ["listExecutionLogs", (limit) => listExecutionLogs(ctx, { limit }, poisoned)],
  ["listAudit", (limit) => listAudit(ctx, { limit }, poisoned)],
  ["listConversations", (limit) => listConversations(ctx, { limit }, poisoned)],
  ["getUsers page", (page) => getUsers(1n, page)],
  [
    "exportExecutionLogs maxRows",
    (maxRows) => exportExecutionLogs(ctx, { maxRows, format: "csv" }, poisoned),
  ],
];

describe("a status outside the closed set is refused, not dropped", () => {
  // Dropping it answers a request for ONE status with EVERY status. Same layer as the counts and
  // for the same reason: MCP and the console's internal calls never pass a query string.
  for (const status of ["bogus", "", "OPEN", "resolved "]) {
    test(`listConversations({ status: ${JSON.stringify(status)} }) → 400`, async () => {
      let err: unknown = null;
      try {
        await listConversations(ctx, { status }, poisoned);
      } catch (e) {
        err = e;
      }
      expect(`${status}: ${err === null ? "accepted" : "refused"}`).toBe(
        `${status}: refused`,
      );
      expect((err as AppError).statusCode).toBe(400);
      expect((err as AppError).field).toBe("status");
    });
  }

  test("a status IN the set is not refused (it reaches the query)", async () => {
    // The poisoned client is what proves it got past the vocabulary check: the throw it raises is
    // the database, not the refusal.
    let err: unknown = null;
    try {
      await listConversations(ctx, { status: "open" }, poisoned);
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toBe(
      "the service reached the database before refusing",
    );
  });
});

describe("a count outside the range is refused by the service, not clamped", () => {
  for (const [name, run] of CALLS) {
    for (const value of REFUSED) {
      test(`${name}(${value}) → 400`, async () => {
        let err: unknown = null;
        try {
          await run(value);
        } catch (e) {
          err = e;
        }
        expect(
          `${name}(${value}): ${err === null ? "accepted" : "refused"}`,
        ).toBe(`${name}(${value}): refused`);
        expect((err as AppError).statusCode).toBe(400);
      });
    }
  }
});
