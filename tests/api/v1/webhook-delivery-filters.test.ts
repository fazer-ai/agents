import { describe, expect, test } from "bun:test";
import { parseDeliveryQuery } from "@/api/v1/webhooks.controller";
import { AppError } from "@/lib/errors";
import {
  type ListDeliveriesOpts,
  listWebhookDeliveries,
} from "@/modules/webhooks/outbound/deliveries";

// ── AN UNUSABLE FILTER IS A REFUSAL, NEVER A DROPPED FILTER ──
//
// Written as a matrix rather than a case per bug because three review rounds found three legs of
// the same question — unparseable, out of range, explicitly empty — and each leg was a different
// input. What the endpoint promises is the whole matrix, so the whole matrix is what is asserted.
//
// The two halves are the two layers a value passes through, and both are load-bearing: the query
// parser turns strings into the service's types (REST only), and the service owns the ranges and
// the vocabulary (REST **and** MCP, which never sees a query string).

const VALUES: Record<string, string[]> = {
  // Empty is not absent: a form submits it when its input is blank, and treating it as "no filter"
  // answers a narrowed request with the tenant's whole ledger.
  subscriptionId: ["", "abc", "-1", "1.5", "9223372036854775808"],
  cursor: ["", "abc", "9223372036854775808"],
  // The last three are the ones `new Date` ACCEPTS: February 30 normalises to March 2, a US-format
  // string resolves against the server's timezone, and a date alone has no instant at all. A filter
  // that silently means something else is worse than one that is refused.
  since: [
    "",
    "garbage",
    "not-a-date",
    "2026-02-30T00:00:00Z",
    "08/26/2026 10:00",
    "2026-01-01",
  ],
  until: ["", "garbage", "2026-13-01T00:00:00Z"],
  // Syntax only here; `-2` is a well-formed integer and is refused one layer down, by the range
  // check the service owns so that MCP is held to it too (see the second describe).
  limit: ["", " ", "abc", "3.5"],
};

describe("the delivery query parser refuses what it cannot use", () => {
  test("every unusable value is a 400 that names the parameter", () => {
    for (const [param, values] of Object.entries(VALUES)) {
      for (const value of values) {
        const err = (() => {
          try {
            parseDeliveryQuery({ [param]: value });
            return null;
          } catch (e) {
            return e;
          }
        })();
        expect(
          `${param}=${value}: ${err === null ? "accepted" : "refused"}`,
        ).toBe(`${param}=${value}: refused`);
        expect((err as AppError).statusCode).toBe(400);
        expect((err as AppError).field).toBe(param);
      }
    }
  });

  test("an absent parameter is not a filter, and a good one survives", () => {
    expect(parseDeliveryQuery({})).toEqual({
      status: undefined,
      subscriptionId: undefined,
      event: undefined,
      since: undefined,
      until: undefined,
      limit: undefined,
      cursor: undefined,
    });
    const parsed = parseDeliveryQuery({
      subscriptionId: "42",
      cursor: "7",
      since: "2026-01-01T00:00:00Z",
      limit: "10",
      status: "DEAD",
      event: "conversion",
    });
    expect(parsed.subscriptionId).toBe(42n);
    expect(parsed.cursor).toBe(7n);
    expect(parsed.limit).toBe(10);
    expect(parsed.since?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    // An offset that crosses midnight is a valid instant, not a malformed date.
    expect(
      parseDeliveryQuery({
        until: "2026-08-25T23:00:00-03:00",
      }).until?.toISOString(),
    ).toBe("2026-08-26T02:00:00.000Z");
  });
});

// No DB needed: every case here is refused before a query is built, which is the point — the check
// belongs to the filter, not to whatever rows happen to exist.
describe("the service refuses what it cannot use, whichever transport asked", () => {
  const CASES: Array<[string, ListDeliveriesOpts]> = [
    // `status: ""` under a truthiness check means "every status", which is the opposite of asking.
    ["status", { status: "" }],
    // FAILED is real on the shared Prisma enum and only the INBOUND side writes it: accepting it
    // would answer "no deliveries" to a filter that can never match.
    ["status", { status: "FAILED" }],
    ["status", { status: "dead" }],
    ["status", { status: "nope" }],
    ["event", { event: "" }],
    ["since", { since: new Date("garbage") }],
    ["until", { until: new Date("garbage") }],
    ["limit", { limit: Number.NaN }],
    ["limit", { limit: 3.5 }],
    ["limit", { limit: 0 }],
    ["limit", { limit: -1 }],
  ];

  test("every case is a 400 naming the filter", async () => {
    for (const [param, opts] of CASES) {
      const err = await listWebhookDeliveries(
        { tenantId: 1n, userId: null, role: "TENANT_ADMIN" },
        opts,
      ).catch((e: unknown) => e);
      expect(
        `${param}=${JSON.stringify(opts)}: ${err instanceof AppError ? "refused" : "accepted"}`,
      ).toBe(`${param}=${JSON.stringify(opts)}: refused`);
      expect((err as AppError).statusCode).toBe(400);
      expect((err as AppError).field).toBe(param);
    }
  });
});
