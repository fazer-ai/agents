import { describe, expect, test } from "bun:test";
import { tenantSwitchTarget } from "@/client/lib/tenantSwitch";

describe("tenantSwitchTarget", () => {
  test("agent detail route -> /agents", () => {
    expect(tenantSwitchTarget("/agents/abc123")).toBe("/agents");
  });

  test("agent detail route with tab -> /agents", () => {
    expect(tenantSwitchTarget("/agents/abc123/behavior")).toBe("/agents");
  });

  test("conversation detail route -> /conversations", () => {
    expect(tenantSwitchTarget("/conversations/42")).toBe("/conversations");
  });

  test("trailing slash is tolerated", () => {
    expect(tenantSwitchTarget("/agents/abc123/")).toBe("/agents");
    expect(tenantSwitchTarget("/conversations/42/")).toBe("/conversations");
  });

  test("list roots are safe to reload in place (null)", () => {
    expect(tenantSwitchTarget("/agents")).toBeNull();
    expect(tenantSwitchTarget("/conversations")).toBeNull();
  });

  test("dashboard, resources and admin pages reload in place (null)", () => {
    expect(tenantSwitchTarget("/")).toBeNull();
    expect(tenantSwitchTarget("/resources/tools")).toBeNull();
    expect(tenantSwitchTarget("/admin/tenants")).toBeNull();
    expect(tenantSwitchTarget("/webhooks")).toBeNull();
    expect(tenantSwitchTarget("/logs")).toBeNull();
  });

  test("deeper unknown agent paths do not match", () => {
    // Only /agents/:id and /agents/:id/:tab are detail routes; anything deeper is not modeled.
    expect(tenantSwitchTarget("/agents/abc/behavior/extra")).toBeNull();
  });
});
