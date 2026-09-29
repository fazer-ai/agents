import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  createToolDefinition,
  updateToolDefinition,
} from "@/modules/tool-definitions/service";

// The assembly reserves every native name (src/graph/tools/unique-names.ts): another tool claiming
// one is dropped, with a flow-log line. So the name is refused where it is TYPED, or an HTTP tool
// named `calculator` could be written, granted, shown, and never reach the model. The HTTP tool's
// equivalent of the document slug check (src/modules/documents/slug.ts); REST, console and MCP all
// land in the service.

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
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantId = 0n;
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

function toolInput(name: string) {
  return {
    name,
    label: name,
    method: "GET" as const,
    urlTemplate: "https://example.com/x",
    allowedHosts: ["example.com"],
    inputSchema: {},
  };
}

async function refusal(p: Promise<unknown>): Promise<AppError | null> {
  return p.then(
    () => null,
    (e: unknown) => (e instanceof AppError ? e : null),
  );
}

describe.skipIf(!dbUp)("an HTTP tool cannot take a native tool's name", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "reserved-name", slug: `reserved-name-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    if (dbUp && tenantId) {
      await suDb.$executeRaw`DELETE FROM tool_definitions WHERE tenant_id = ${tenantId}`;
      await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}`;
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("creating one under any native name is refused as a conflict on the name", async () => {
    for (const name of NATIVE_TOOL_NAMES) {
      const err = await refusal(
        createToolDefinition(ctx(), toolInput(name) as never, appDb),
      );
      expect(err?.statusCode, name).toBe(409);
      expect(err?.translationKey, name).toBe("errors.toolNameReserved");
      expect(err?.field, name).toBe("name");
    }
    expect(await suDb.toolDefinition.count({ where: { tenantId } })).toBe(0);
  });

  test("renaming one onto a native name is refused, and the row keeps its name", async () => {
    const created = await createToolDefinition(
      ctx(),
      toolInput("calculator_custom") as never,
      appDb,
    );
    const err = await refusal(
      updateToolDefinition(
        ctx(),
        BigInt(created.id),
        { name: "calculator" } as never,
        appDb,
      ),
    );
    expect(err?.translationKey).toBe("errors.toolNameReserved");
    const row = await suDb.toolDefinition.findUnique({
      where: { id: BigInt(created.id) },
    });
    expect(row?.name).toBe("calculator_custom");
    // A rename to a free, non-native name is what the check must not touch.
    const renamed = await updateToolDefinition(
      ctx(),
      BigInt(created.id),
      { name: "calculator_http" } as never,
      appDb,
    );
    expect(renamed.name).toBe("calculator_http");
  });

  // NOTE: a legacy row can carry a spelling from before names were canonicalized on write. The
  // console submits the identifier derived from the label on EVERY save, so editing
  // `Search_Knowledge` sends `search_knowledge`: one identity, two strings. Compared as text it
  // reads as a rename that the namespace rules refuse, locking the row out of the console.
  test("a legacy spelling can still be edited: the identity, not the string, decides a rename", async () => {
    // Written past the service, which would canonicalize it: this is a row from before that rule.
    const legacy = await suDb.toolDefinition.create({
      data: {
        tenantId,
        name: "Search_Knowledge",
        label: "Search Knowledge",
        urlTemplate: "https://api.example.com/x",
        allowedHosts: ["api.example.com"],
      },
      select: { id: true },
    });
    const updated = await updateToolDefinition(
      ctx(),
      legacy.id,
      { name: "search_knowledge", label: "Buscar na base" } as never,
      appDb,
    );
    expect(updated.label).toBe("Buscar na base");
    // NOTE: ...and a real move onto that same RAG name is still refused.
    const other = await createToolDefinition(
      ctx(),
      toolInput("outra_ferramenta") as never,
      appDb,
    );
    const err = await refusal(
      updateToolDefinition(
        ctx(),
        BigInt(other.id),
        { name: "search_knowledge" } as never,
        appDb,
      ),
    );
    expect(err).not.toBeNull();
  });
});
