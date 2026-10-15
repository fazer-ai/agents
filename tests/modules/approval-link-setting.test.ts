import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import {
  approvalPageUrl,
  normalizeApprovalLink,
  parseApprovalLinkSettings,
  withApprovalLink,
} from "@/modules/documents/approval-link";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { tenantSettingsGet } from "@/modules/mcp/read";
import { tenantSettingsUpdate } from "@/modules/mcp/write-settings";
import {
  getTenantSettings,
  updateApprovalLink,
} from "@/modules/tenant-settings/service";
import { dbProbeFailed } from "@/tests/db-gate";

// The link at the end of an approval request's private note points where the tenant says: the
// console, its own app, or nowhere. A template that is not a web address never becomes a link.

describe("what the note's link becomes", () => {
  test("a template that is not an http(s) address with {id} is refused, and an empty one is the console again", () => {
    for (const urlTemplate of [
      "javascript:alert(document.cookie)//{id}",
      "não é uma url {id}",
      "https://app.example.com/documents",
      "https:/app.example.com/review/{id}",
      "https://app.example.com/review/\n{id}",
      "https://app.example.com/review now/{id}",
      "https://app.example.com\\review\\{id}",
    ]) {
      expect(() =>
        normalizeApprovalLink({ mode: "custom", urlTemplate }),
      ).toThrow(
        expect.objectContaining({
          statusCode: 400,
          translationKey: "errors.invalidApprovalLinkTemplate",
        }),
      );
    }
    expect(
      normalizeApprovalLink({ mode: "custom", urlTemplate: "  " }),
    ).toEqual({ mode: "console", urlTemplate: "" });
  });

  test("a stored template the write rule no longer accepts reads as the console", () => {
    expect(
      parseApprovalLinkSettings({
        approvalLink: { mode: "custom", urlTemplate: "javascript:x({id})" },
      }).mode,
    ).toBe("console");
  });

  test("parentheses in the address survive the Markdown link", () => {
    const note = withApprovalLink(
      "Pedido aberto.",
      {
        mode: "custom",
        urlTemplate: "https://app.example.com/docs?f=(open)&id={id}",
      },
      7n,
      42n,
    );
    expect(note).toBe(
      "Pedido aberto.\n\n[Ver aprovação](https://app.example.com/docs?f=%28open%29&amp;id=42)",
    );
    expect(
      approvalPageUrl({ mode: "console", urlTemplate: "" }, 7n, 42n),
    ).toMatch(/\/document-approvals\/42\?switchTenant=7$/);
  });
});

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

let tenantId = 0n;
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});
const token = (scopes: string[]): VerifiedToken => ({
  userId: null as unknown as bigint,
  tenantId,
  role: "TENANT_ADMIN",
  scopes,
  clientId: "c1467",
  jti: "j1467",
});

describe.skipIf(!dbUp)("the approval link setting", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "al1467", slug: `al1467-${process.pid}` },
      })
    ).id;
  });
  afterAll(async () => {
    await suDb.$executeRaw`DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`;
    await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}`;
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("a save is read back, audited with both sides, and a refused one changes nothing", async () => {
    expect((await getTenantSettings(ctx(), appDb)).approvalLink).toEqual({
      mode: "console",
      urlTemplate: "",
    });
    const custom = {
      mode: "custom" as const,
      urlTemplate: "https://app.example.com/documents?approval={id}",
    };
    await updateApprovalLink(ctx(), custom, appDb);
    expect((await getTenantSettings(ctx(), appDb)).approvalLink).toEqual(
      custom,
    );
    await expect(
      updateApprovalLink(
        ctx(),
        { mode: "custom", urlTemplate: "javascript:x({id})" },
        appDb,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect((await getTenantSettings(ctx(), appDb)).approvalLink).toEqual(
      custom,
    );
    // The mode alone keeps the saved template, and switching back finds it.
    await updateApprovalLink(ctx(), { mode: "none" }, appDb);
    expect((await getTenantSettings(ctx(), appDb)).approvalLink).toEqual({
      mode: "none",
      urlTemplate: custom.urlTemplate,
    });
    await updateApprovalLink(ctx(), { mode: "custom" }, appDb);
    const rows = await suDb.auditLog.findMany({
      where: { tenantId, action: "tenant_settings.approval_link_set" },
      orderBy: { id: "asc" },
      select: { before: true, after: true },
    });
    // The trail keeps the host, never a path or query that may carry a token.
    expect(rows[0]).toEqual({
      before: { mode: "console", urlTemplate: "" },
      after: { mode: "custom", urlTemplate: "https://app.example.com/…" },
    });
    expect(rows).toHaveLength(3);
    // A new path on the same host changes nothing the row shows, so the row says so.
    await updateApprovalLink(
      ctx(),
      {
        mode: "custom",
        urlTemplate: "https://app.example.com/other?approval={id}",
      },
      appDb,
    );
    const moved = await suDb.auditLog.findMany({
      where: { tenantId, action: "tenant_settings.approval_link_set" },
      orderBy: { id: "desc" },
      take: 1,
      select: { after: true },
    });
    expect(moved[0]?.after).toMatchObject({ undisclosedChanged: true });
  });

  test("over MCP: a preview writes nothing, an apply saves, and the read returns it", async () => {
    const rw = token(["mcp:read", "mcp:write"]);
    const before = (await getTenantSettings(ctx(), appDb)).approvalLink;
    const preview = await tenantSettingsUpdate(
      rw,
      { approval_link: { mode: "none", url_template: "" } },
      { base: appDb },
    );
    expect(preview.ok).toBe(true);
    expect((await getTenantSettings(ctx(), appDb)).approvalLink).toEqual(
      before,
    );
    const applied = await tenantSettingsUpdate(
      rw,
      { approval_link: { mode: "none", url_template: "" }, dry_run: false },
      { base: appDb },
    );
    expect(applied.ok).toBe(true);
    const read = await tenantSettingsGet(token(["mcp:read"]), { base: appDb });
    expect(read.ok && read.data.settings).toMatchObject({
      approvalLink: { mode: "none", urlTemplate: "" },
    });
    const bad = await tenantSettingsUpdate(
      rw,
      {
        approval_link: { mode: "custom", url_template: "ftp://x/{id}" },
        dry_run: false,
      },
      { base: appDb },
    );
    expect(bad.ok).toBe(false);
    expect((await getTenantSettings(ctx(), appDb)).approvalLink.mode).toBe(
      "none",
    );
  });
});
