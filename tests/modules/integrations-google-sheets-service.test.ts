import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  listCredentialSpreadsheets,
  listSpreadsheetTabs,
  type SheetsListDeps,
} from "@/modules/integrations/google-sheets.service";

const ctx = {
  tenantId: 1n,
  userId: null,
  role: "TENANT_ADMIN",
} as TenantContext;
const noBase = undefined as unknown as PrismaClient;
const SID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

function routed(handler: (url: URL) => [number, unknown]) {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(String(input));
    const [status, body] = handler(new URL(String(input)));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { urls, fetchImpl };
}

function deps(fetchImpl: typeof fetch, over: Partial<SheetsListDeps> = {}) {
  return {
    resolveEntry: async () => ({ kind: "google_oauth" }),
    resolveToken: async () => "tok",
    assertSafe: async () => undefined,
    fetchImpl,
    ...over,
  } satisfies SheetsListDeps;
}

async function refusal(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("the spreadsheet list", () => {
  test("asks Drive for spreadsheets only and keeps id and name", async () => {
    const { urls, fetchImpl } = routed(() => [
      200,
      {
        files: [
          { id: "s1", name: "Leads" },
          { id: "s2", name: "  " },
          { name: "no id" },
        ],
      },
    ]);
    const out = await listCredentialSpreadsheets(
      ctx,
      "vault:3",
      noBase,
      deps(fetchImpl),
    );
    expect(out).toEqual([{ id: "s1", name: "Leads" }]);
    expect(new URL(urls[0] as string).searchParams.get("q")).toContain(
      "application/vnd.google-apps.spreadsheet",
    );
  });

  test("a 403 says which scope lists them and that pasting the URL works", async () => {
    const { fetchImpl } = routed(() => [403, {}]);
    const err = await refusal(
      listCredentialSpreadsheets(ctx, "vault:3", noBase, deps(fetchImpl)),
    );
    expect(err.translationKey).toBe("errors.googleSheetsListScopeDenied");
  });

  test("a credential that is not a Google account is refused before any request", async () => {
    const { urls, fetchImpl } = routed(() => [200, {}]);
    const err = await refusal(
      listCredentialSpreadsheets(
        ctx,
        "vault:3",
        noBase,
        deps(fetchImpl, { resolveEntry: async () => ({ kind: "openai" }) }),
      ),
    );
    expect(err.translationKey).toBe("errors.googleCredentialNotConnected");
    expect(urls).toEqual([]);
  });
});

describe("the tab list", () => {
  test("each tab comes with its numeric id and the columns of its header row", async () => {
    const { urls, fetchImpl } = routed((u) =>
      u.pathname.endsWith("values:batchGet")
        ? [
            200,
            {
              valueRanges: [
                { values: [["Nome", "", "Telefone"]] },
                { values: [] },
              ],
            },
          ]
        : [
            200,
            {
              properties: { title: "CRM" },
              sheets: [
                { properties: { sheetId: 0, title: "Leads" } },
                { properties: { sheetId: 9, title: "Joana's" } },
              ],
            },
          ],
    );
    const out = await listSpreadsheetTabs(
      ctx,
      "vault:3",
      SID,
      noBase,
      deps(fetchImpl),
    );
    expect(out).toEqual({
      title: "CRM",
      tabs: [
        { sheetId: 0, title: "Leads", columns: ["Nome", "Telefone"] },
        { sheetId: 9, title: "Joana's", columns: [] },
      ],
    });
    const batch = new URL(urls[1] as string);
    expect(batch.searchParams.getAll("ranges")).toEqual([
      "'Leads'!1:1",
      "'Joana''s'!1:1",
    ]);
    for (const u of urls)
      expect(
        u.startsWith(`https://sheets.googleapis.com/v4/spreadsheets/${SID}`),
      ).toBe(true);
  });

  test("a chart sheet is neither offered nor put in the header batch", async () => {
    const { urls, fetchImpl } = routed((u) =>
      u.pathname.endsWith("values:batchGet")
        ? [200, { valueRanges: [{ values: [["Nome"]] }] }]
        : [
            200,
            {
              properties: { title: "CRM" },
              sheets: [
                {
                  properties: {
                    sheetId: 5,
                    title: "Gráfico",
                    sheetType: "OBJECT",
                  },
                },
                {
                  properties: { sheetId: 0, title: "Leads", sheetType: "GRID" },
                },
              ],
            },
          ],
    );
    const out = await listSpreadsheetTabs(
      ctx,
      "vault:3",
      SID,
      noBase,
      deps(fetchImpl),
    );
    expect(out.tabs).toEqual([
      { sheetId: 0, title: "Leads", columns: ["Nome"] },
    ]);
    expect(new URL(urls[1] as string).searchParams.getAll("ranges")).toEqual([
      "'Leads'!1:1",
    ]);
  });

  test("a failed header read is an error, not tabs without a header row", async () => {
    const { fetchImpl } = routed((u) =>
      u.pathname.endsWith("values:batchGet")
        ? [503, {}]
        : [
            200,
            {
              properties: { title: "CRM" },
              sheets: [{ properties: { sheetId: 0, title: "Leads" } }],
            },
          ],
    );
    const err = await refusal(
      listSpreadsheetTabs(ctx, "vault:3", SID, noBase, deps(fetchImpl)),
    );
    expect(err.translationKey).toBe("errors.integrationHttpError");
  });

  test("an id that is not an id is refused before the credential or any request", async () => {
    const { urls, fetchImpl } = routed(() => [200, {}]);
    let resolved = 0;
    const err = await refusal(
      listSpreadsheetTabs(
        ctx,
        "vault:3",
        "https://evil.example/x",
        noBase,
        deps(fetchImpl, {
          resolveEntry: async () => {
            resolved++;
            return { kind: "google_oauth" };
          },
        }),
      ),
    );
    expect(err.translationKey).toBe("errors.googleSpreadsheetIdInvalid");
    expect(urls).toEqual([]);
    expect(resolved).toBe(0);
  });

  test("404 and 403 each get their own sentence", async () => {
    const notFound = routed(() => [404, {}]);
    expect(
      (
        await refusal(
          listSpreadsheetTabs(
            ctx,
            "vault:3",
            SID,
            noBase,
            deps(notFound.fetchImpl),
          ),
        )
      ).translationKey,
    ).toBe("errors.googleSpreadsheetNotFound");
    const denied = routed(() => [403, {}]);
    expect(
      (
        await refusal(
          listSpreadsheetTabs(
            ctx,
            "vault:3",
            SID,
            noBase,
            deps(denied.fetchImpl),
          ),
        )
      ).translationKey,
    ).toBe("errors.googleSheetsScopeDenied");
  });
});
