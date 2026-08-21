import { describe, expect, test } from "bun:test";
import config from "@/config";
import { CONSOLE_ROUTES } from "@/lib/console-params";
import {
  consoleUrl,
  integrationsUrl,
  vaultCreateUrl,
  vaultFillUrl,
} from "@/modules/mcp/console-links";

// Every console link an MCP answer hands back has to satisfy two things at once, and each of them
// was broken on a different link (issue #151): it must name the TENANT it belongs to, because the
// console resolves the tenant from localStorage and never from the URL, and it must name a route
// that EXISTS, because `path="*"` redirects anything else to the dashboard with no explanation.

const BASE = config.publicUrl.replace(/\/+$/, "");

// The routes as the router spells them (`src/client/App.tsx`), written out here rather than imported
// so that a rename has to be made in two places on purpose instead of agreeing with itself.
const ROUTER_PATHS: string[] = ["/resources/vault", "/resources/integrations"];

describe("console links", () => {
  test("every named destination is a route the console actually has", () => {
    const named: string[] = Object.values(CONSOLE_ROUTES);
    expect(named.slice().sort()).toEqual(ROUTER_PATHS.slice().sort());
  });

  // Deliberately not `tenant`: `/admin/users?tenant=<id>` is already that page's fleet-wide filter.
  test("the tenant rides as a query parameter of this feature's own", () => {
    expect(consoleUrl("/resources/vault", { tenantId: 42n })).toBe(
      `${BASE}/resources/vault?switchTenant=42`,
    );
  });

  test("a path that already has a query keeps it", () => {
    expect(consoleUrl("/resources/vault?fill=5", { tenantId: 42n })).toBe(
      `${BASE}/resources/vault?fill=5&switchTenant=42`,
    );
  });

  // A SUPER_ADMIN session with no tenant selected has none to name, and TenantContext.tenantId is
  // nullable for exactly that reason. The honest answer is the tenant-less link, not `tenant=null`.
  test("no tenant in context means no tenant on the link", () => {
    expect(consoleUrl("/resources/vault", { tenantId: null })).toBe(
      `${BASE}/resources/vault`,
    );
    expect(consoleUrl("/resources/vault")).toBe(`${BASE}/resources/vault`);
  });

  test("the fill link carries both the entry and its tenant", () => {
    expect(vaultFillUrl(7n, 5n)).toBe(
      `${BASE}/resources/vault?fill=5&switchTenant=7`,
    );
  });

  // These two used to point at `/vault` and `/integrations`, which are not routes: the vault panel
  // is `/resources/vault` and integrations is `/resources/integrations`, so both dropped the
  // operator on the dashboard.
  test("the create and configure links land on the panel, not on the catch-all", () => {
    expect(vaultCreateUrl(7n)).toBe(`${BASE}/resources/vault?switchTenant=7`);
    expect(integrationsUrl(7n)).toBe(
      `${BASE}/resources/integrations?switchTenant=7`,
    );
  });
});
