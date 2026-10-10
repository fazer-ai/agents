import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { documentTemplatesController } from "@/api/v1/document-templates.controller";
import { documentsController } from "@/api/v1/documents.controller";
import { tenantSettingsController } from "@/api/v1/tenant-settings.controller";
import type { TenantContext } from "@/lib/tenancy";
import * as company from "@/modules/documents/company";
import * as issue from "@/modules/documents/issue";
import * as templates from "@/modules/documents/templates";
import * as tenantSettings from "@/modules/tenant-settings/service";

// Every v1 route resolves its tenant from `X-Tenant-Id` (a SUPER_ADMIN's tenant is nowhere else), so
// a stored response is keyed by a URL that does not name the tenant: switch tenants, hit the same
// URL, and the browser answers with the previous tenant's bytes without the scoped read ever running.
// `private` does not help: it keeps shared proxies out, not the one browser that saw both tenants.
// So a v1 response that serves bytes is either `no-store` or declares `Vary: X-Tenant-Id`.
//
// The handlers are called as registered, with the services under them stubbed, so what is asserted
// is the response the route builds and not how its source spells the header.

const ctx = { tenantId: 1n } as unknown as TenantContext;

interface RouteEntry {
  method: string;
  path: string;
  handler: (context: Record<string, unknown>) => Promise<Response>;
}

function handlerOf(
  controller: { routes: unknown[] },
  method: string,
  path: string,
): RouteEntry["handler"] {
  const route = (controller.routes as RouteEntry[]).find(
    (r) => r.method === method && r.path === path,
  );
  if (!route) throw new Error(`${method} ${path} left the route table`);
  return route.handler;
}

// Cacheable at all means a browser may replay it; then the tenant has to be part of the key.
function tenantSafe(res: Response): string | null {
  const control = res.headers.get("cache-control") ?? "";
  if (/\bno-store\b/.test(control)) return null;
  const vary = (res.headers.get("vary") ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase());
  if (vary.includes("x-tenant-id")) return null;
  return `Cache-Control "${control}" with Vary "${res.headers.get("vary") ?? ""}"`;
}

const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

describe("a v1 response that serves bytes is keyed by the tenant", () => {
  test("the issued document's PDF", async () => {
    spies.push(
      spyOn(issue, "getIssuedDocumentPdf").mockResolvedValue({
        bytes: new Uint8Array([37, 80, 68, 70]).buffer,
        fileName: "orcamento-1.pdf",
      }),
    );
    const res = await handlerOf(
      documentsController,
      "GET",
      "/v1/documents/:id/pdf",
    )({ tenantContext: ctx, params: { id: "1" } });
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(tenantSafe(res)).toBeNull();
  });

  test("the template preview", async () => {
    spies.push(
      spyOn(templates, "previewDocumentTemplate").mockResolvedValue(
        new Uint8Array([37, 80, 68, 70]) as Awaited<
          ReturnType<typeof templates.previewDocumentTemplate>
        >,
      ),
    );
    const res = await handlerOf(
      documentTemplatesController,
      "POST",
      "/v1/document-templates/preview",
    )({ tenantContext: ctx, body: { name: "Orçamento", blocks: [] } });
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(tenantSafe(res)).toBeNull();
  });

  test("the company logo", async () => {
    spies.push(
      spyOn(tenantSettings, "getTenantSettings").mockResolvedValue({
        company: { logoKey: "logo-1.png" },
      } as unknown as Awaited<
        ReturnType<typeof tenantSettings.getTenantSettings>
      >),
      spyOn(company, "readCompanyLogo").mockResolvedValue({
        data: new Uint8Array([137, 80, 78, 71]),
      } as unknown as Awaited<ReturnType<typeof company.readCompanyLogo>>),
    );
    const res = await handlerOf(
      tenantSettingsController,
      "GET",
      "/v1/tenant-settings/company/logo",
    )({ tenantContext: ctx, set: {} });
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(tenantSafe(res)).toBeNull();
  });
});

// The control: a response the browser may store, keyed only by its URL, is what the check refuses.
test("a cacheable response without the tenant in Vary is refused", () => {
  const stored = new Response("x", {
    headers: { "Cache-Control": "private, max-age=3600" },
  });
  expect(tenantSafe(stored)).toBe(
    'Cache-Control "private, max-age=3600" with Vary ""',
  );
  const keyed = new Response("x", {
    headers: {
      "Cache-Control": "private, max-age=3600",
      Vary: "Accept-Encoding, X-Tenant-Id",
    },
  });
  expect(tenantSafe(keyed)).toBeNull();
});
