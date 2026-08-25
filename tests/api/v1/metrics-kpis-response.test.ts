import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { errors } from "@/api/lib/openapi";
import type { DashboardKpis } from "@/modules/analytics/service";

// Elysia's `normalize` strips response fields that a declared 200 schema does not mention, which is
// how a field that exists only in the TypeScript type reaches the client as nothing at all. The
// dashboard's Resolution note is driven by `resolvedBeforeTracking`, a field added on the service
// side alone, so this drives the route's OWN response contract rather than trusting the type.
describe("GET /v1/metrics/kpis response contract", () => {
  const kpis: DashboardKpis = {
    totalConversations: 10,
    involved: 8,
    resolvedByBot: 1,
    handoff: 1,
    resolvedBeforeTracking: 3,
    involvementRate: 0.8,
    resolutionRate: 0.125,
    automationRate: 0.1,
    firstResponseSeconds: 42.5,
    firstResponseSampled: 6,
  };
  const app = new Elysia().get("/kpis", () => ({ instance: "i", kpis }), {
    // The route's real declaration: error statuses only, no 200 schema.
    response: errors(401),
  });

  test("every KPI the service computes reaches the client", async () => {
    const res = await app.handle(new Request("http://localhost/kpis"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kpis: Record<string, unknown> };
    expect(Object.keys(body.kpis).sort()).toEqual(Object.keys(kpis).sort());
    expect(body.kpis.resolvedBeforeTracking).toBe(3);
  });
});
