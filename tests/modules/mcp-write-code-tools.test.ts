import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { codeToolGet, codeToolList } from "@/modules/mcp/read";
import {
  buildCodeToolPatch,
  codeToolCreate,
  codeToolDelete,
  codeToolUpdate,
} from "@/modules/mcp/write-code-tools";

// The code tool's console tools (issue #363), the twin of the HTTP tool_* ones: gate (scope +
// tenant target) is DB-free; dry-run/apply/audit and the tenant fence need a real Postgres (skipIf).
//
// What a dry run promises here is the same thing tool_create's promises: the preview IS what the
// apply stores. Two things could make it lie for a code tool. The input schema is canonicalized on
// write (a JSON-Schema-shaped value becomes the compact field map), so a preview echoing the
// argument would show a shape the row never holds. And the body's static check answers alongside
// the row on apply, so a preview that omitted it would let a caller approve a body the apply then
// reports as broken.

function principal(over: Partial<VerifiedToken>): VerifiedToken {
  return {
    userId: 1n,
    tenantId: 1n,
    role: "TENANT_ADMIN",
    scopes: ["mcp:read", "mcp:write"],
    clientId: "c",
    jti: "j",
    ...over,
  };
}

const VALID = {
  name: "validar_cpf",
  label: "Validar CPF",
  description: "Valida um CPF informado pelo cliente.",
  input_schema: { cpf: { type: "string", required: true } },
  code: "return validateCpf(input.cpf)",
};

describe("MCP code-tool write gate (no DB)", () => {
  test("code_tool_create without mcp:write → insufficient_scope", async () => {
    const r = await codeToolCreate(principal({ scopes: ["mcp:read"] }), VALID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("insufficient_scope");
  });

  test("code_tool_update without mcp:write → insufficient_scope", async () => {
    const r = await codeToolUpdate(principal({ scopes: ["mcp:read"] }), {
      code_tool_id: "1",
      label: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("insufficient_scope");
  });

  test("code_tool_delete without mcp:write → insufficient_scope", async () => {
    const r = await codeToolDelete(principal({ scopes: ["mcp:read"] }), {
      code_tool_id: "1",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("insufficient_scope");
  });

  test("code_tool_create names the required argument it is missing", async () => {
    const missingDescription = await codeToolCreate(principal({}), {
      name: "x",
      code: "return 1",
    });
    expect(missingDescription.ok).toBe(false);
    if (!missingDescription.ok)
      expect(missingDescription.error).toContain("description is required");
    const missingCode = await codeToolCreate(principal({}), {
      name: "x",
      description: "d",
    });
    expect(missingCode.ok).toBe(false);
    if (!missingCode.ok)
      expect(missingCode.error).toContain("code is required");
  });

  test("code_tool_update invalid id / no fields → error", async () => {
    const bad = await codeToolUpdate(principal({}), {
      code_tool_id: "nope",
      label: "x",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("invalid code_tool_id");
    const empty = await codeToolUpdate(principal({}), { code_tool_id: "1" });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain("no updatable fields");
  });

  test("buildCodeToolPatch maps snake_case and canonicalizes a JSON-Schema input_schema", () => {
    const { patch, warnings } = buildCodeToolPatch({
      name: "n",
      label: "l",
      description: "d",
      input_schema: {
        required: ["cpf"],
        properties: { cpf: { type: "string" } },
      },
      code: "return 1",
      enabled: false,
    });
    expect(patch).toEqual({
      name: "n",
      label: "l",
      description: "d",
      inputSchema: { cpf: { type: "string", required: true } },
      code: "return 1",
      enabled: false,
    });
    expect(warnings.join(" ")).toContain("JSON Schema");
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
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

describe.skipIf(!dbUp)("MCP code-tool tools (DB)", () => {
  let tenantA = 0n;
  let tenantB = 0n;

  beforeAll(async () => {
    const a = await suDb.tenant.create({
      data: { name: "CTA", slug: `ct-a-${process.pid}` },
    });
    tenantA = a.id;
    const b = await suDb.tenant.create({
      data: { name: "CTB", slug: `ct-b-${process.pid}` },
    });
    tenantB = b.id;
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB]) {
      if (!tid) continue;
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM code_tool_definitions WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("code_tool_create dry-run previews the canonical schema + the body's warnings and writes nothing", async () => {
    const p = principal({ tenantId: tenantA });
    const shapes = {
      name: "consultar_prazo",
      description: "Calcula o prazo de entrega.",
      input_schema: {
        required: ["cep"],
        properties: { cep: { type: "string" } },
      },
      // NOTE: an unclosed brace: the body is saved anyway, and the preview has to say so.
      code: "if (input.cep) { return { dias: 3 }",
    };
    const dry = await codeToolCreate(p, shapes, { base: appDb });
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;
    expect(dry.data.dryRun).toBe(true);
    expect(dry.data.action).toBe("create");
    expect(dry.data.resource).toBe("code_tool");
    const preview = dry.data.preview as Record<string, unknown>;
    expect(preview.inputSchema).toEqual({
      cep: { type: "string", required: true },
    });
    // The label defaults to the identifier, as tool_create's does.
    expect(preview.label).toBe("consultar_prazo");
    const warnings = dry.data.warnings as { kind: string }[];
    expect(warnings.map((w) => w.kind)).toEqual(["syntax"]);
    expect((dry.data.schemaWarnings as string[]).join(" ")).toContain(
      "JSON Schema",
    );
    const before = await suDb.codeToolDefinition.count({
      where: { tenantId: tenantA },
    });
    expect(before).toBe(0);

    const applied = await codeToolCreate(
      p,
      { ...shapes, dry_run: false },
      { base: appDb },
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.data.applied).toBe(true);
    const tool = applied.data.tool as { id: string; inputSchema: unknown };
    expect(applied.data.target).toBe(`code_tool:${tool.id}`);
    expect(
      (applied.data.warnings as { kind: string }[]).map((w) => w.kind),
    ).toEqual(["syntax"]);
    const row = await suDb.codeToolDefinition.findFirst({
      where: { tenantId: tenantA, name: "consultar_prazo" },
    });
    expect(row).not.toBeNull();
    // The stored row is the preview, field for field.
    expect(row?.inputSchema as unknown).toEqual(preview.inputSchema);
    expect(row?.code).toBe(preview.code as string);
    expect(row?.label).toBe(preview.label as string);
    expect(row?.enabled).toBe(preview.enabled as boolean);
    const audits = await suDb.auditLog.count({
      where: { tenantId: tenantA, action: "code_tool.create" },
    });
    expect(audits).toBe(1);
  });

  test("a body that parses previews and applies with no warning", async () => {
    const p = principal({ tenantId: tenantA });
    const applied = await codeToolCreate(
      p,
      { ...VALID, dry_run: false },
      { base: appDb },
    );
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.data.warnings).toEqual([]);
  });

  test("code_tool_update dry-run shows the diff and reports the new body's warnings; apply audits", async () => {
    const p = principal({ tenantId: tenantA });
    const row = await suDb.codeToolDefinition.findFirstOrThrow({
      where: { tenantId: tenantA, name: "validar_cpf" },
    });
    const dry = await codeToolUpdate(
      p,
      {
        code_tool_id: String(row.id),
        label: "Validar CPF (v2)",
        code: "const r = validateCpf(input.cpf)",
      },
      { base: appDb },
    );
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;
    expect(dry.data.dryRun).toBe(true);
    expect(dry.data.target).toBe(`code_tool:${row.id}`);
    const diff = dry.data.diff as Record<
      string,
      { before: unknown; after: unknown }
    >;
    expect(Object.keys(diff).sort()).toEqual(["code", "label"]);
    expect(diff.label).toEqual({
      before: "Validar CPF",
      after: "Validar CPF (v2)",
    });
    expect(
      (dry.data.warnings as { kind: string }[]).map((w) => w.kind),
    ).toEqual(["noReturn"]);
    const untouched = await suDb.codeToolDefinition.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(untouched.label).toBe("Validar CPF");

    const applied = await codeToolUpdate(
      p,
      {
        code_tool_id: String(row.id),
        label: "Validar CPF (v2)",
        dry_run: false,
      },
      { base: appDb },
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.data.applied).toBe(true);
    // A patch that does not touch the body reports no syntax warning, as the service does.
    expect(applied.data.warnings).toEqual([]);
    expect((applied.data.diff as Record<string, unknown>).label).toEqual({
      before: "Validar CPF",
      after: "Validar CPF (v2)",
    });
    const audits = await suDb.auditLog.count({
      where: { tenantId: tenantA, action: "code_tool.update" },
    });
    expect(audits).toBe(1);
  });

  test("a rename the apply would refuse is refused by the dry run too, and keeping your own name is not a collision", async () => {
    // The one field of a patch whose verdict is not in the payload. Without the availability check
    // the preview answered a confident diff for a write that always fails (#490).
    const p = principal({ tenantId: tenantA });
    const row = await suDb.codeToolDefinition.findFirstOrThrow({
      where: { tenantId: tenantA, name: "validar_cpf" },
    });
    const onNative = await codeToolUpdate(
      p,
      { code_tool_id: String(row.id), name: "calculator" },
      { base: appDb },
    );
    expect(onNative.ok).toBe(false);
    const applyOnNative = await codeToolUpdate(
      p,
      { code_tool_id: String(row.id), name: "calculator", dry_run: false },
      { base: appDb },
    );
    expect(applyOnNative.ok).toBe(false);

    const other = await suDb.codeToolDefinition.create({
      data: {
        tenantId: tenantA,
        name: "outra_ferramenta",
        label: "Outra",
        description: "d",
        inputSchema: {},
        code: "return 1",
      },
    });
    const onTaken = await codeToolUpdate(
      p,
      { code_tool_id: String(row.id), name: "outra_ferramenta" },
      { base: appDb },
    );
    expect(onTaken.ok).toBe(false);
    // Its own name is not a collision with itself.
    const onItself = await codeToolUpdate(
      p,
      { code_tool_id: String(row.id), name: row.name },
      { base: appDb },
    );
    expect(onItself.ok).toBe(true);
    await suDb.codeToolDefinition.delete({ where: { id: other.id } });
  });

  test("a preview shows the values the apply would store, not the ones that were typed", async () => {
    // The parser trims the label and the description, so a preview echoing the raw arguments
    // promises a row the apply then writes differently — the divergence #490 is about, one field
    // over.
    const p = principal({ tenantId: tenantA });
    const padded = {
      ...VALID,
      name: "com_espacos",
      label: "  Com espaços  ",
      description: "  uma descrição  ",
    };
    const dry = await codeToolCreate(p, padded, { base: appDb });
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;
    expect(dry.data.preview).toMatchObject({
      label: "Com espaços",
      description: "uma descrição",
    });
    const applied = await codeToolCreate(
      p,
      { ...padded, dry_run: false },
      { base: appDb },
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.data.tool).toMatchObject({
      label: "Com espaços",
      description: "uma descrição",
    });
    const row = await suDb.codeToolDefinition.findFirstOrThrow({
      where: { tenantId: tenantA, name: "com_espacos" },
    });
    const dryPatch = await codeToolUpdate(
      p,
      { code_tool_id: String(row.id), label: "  Outro  " },
      { base: appDb },
    );
    expect(dryPatch.ok).toBe(true);
    if (!dryPatch.ok) return;
    expect(
      (dryPatch.data.diff as Record<string, { after: unknown }>).label?.after,
    ).toBe("Outro");
    await suDb.codeToolDefinition.delete({ where: { id: row.id } });
  });

  test("code_tool_list omits the body; code_tool_get returns it; both are tenant-fenced", async () => {
    const list = await codeToolList(principal({ tenantId: tenantA }), {
      base: appDb,
    });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const tools = list.data.tools as Record<string, unknown>[];
    expect(tools.map((t) => t.name).sort()).toEqual([
      "consultar_prazo",
      "validar_cpf",
    ]);
    expect(tools.every((t) => !("code" in t))).toBe(true);
    const row = await suDb.codeToolDefinition.findFirstOrThrow({
      where: { tenantId: tenantA, name: "validar_cpf" },
    });
    const got = await codeToolGet(
      principal({ tenantId: tenantA }),
      { code_tool_id: String(row.id) },
      { base: appDb },
    );
    expect(got.ok).toBe(true);
    if (got.ok)
      expect((got.data.tool as { code: string }).code).toBe(VALID.code);

    const other = await codeToolList(principal({ tenantId: tenantB }), {
      base: appDb,
    });
    expect(other.ok).toBe(true);
    if (other.ok) expect(other.data.tools).toEqual([]);
    const fenced = await codeToolGet(
      principal({ tenantId: tenantB }),
      { code_tool_id: String(row.id) },
      { base: appDb },
    );
    expect(fenced.ok).toBe(false);
    if (!fenced.ok) expect(fenced.error).toContain("not found");
  });

  test("code_tool_delete previews {id, name} and deletes nothing; apply deletes + audits", async () => {
    const p = principal({ tenantId: tenantA });
    const row = await suDb.codeToolDefinition.findFirstOrThrow({
      where: { tenantId: tenantA, name: "consultar_prazo" },
    });
    const dry = await codeToolDelete(
      p,
      { code_tool_id: String(row.id) },
      { base: appDb },
    );
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;
    expect(dry.data.dryRun).toBe(true);
    expect(dry.data.action).toBe("delete");
    expect(dry.data.current).toEqual({
      id: String(row.id),
      name: "consultar_prazo",
    });
    expect(await suDb.codeToolDefinition.count({ where: { id: row.id } })).toBe(
      1,
    );

    const applied = await codeToolDelete(
      p,
      { code_tool_id: String(row.id), dry_run: false },
      { base: appDb },
    );
    expect(applied.ok).toBe(true);
    expect(await suDb.codeToolDefinition.count({ where: { id: row.id } })).toBe(
      0,
    );
    const audits = await suDb.auditLog.count({
      where: { tenantId: tenantA, action: "code_tool.delete" },
    });
    expect(audits).toBe(1);
  });

  test("a write against another tenant's tool is not found", async () => {
    const row = await suDb.codeToolDefinition.findFirstOrThrow({
      where: { tenantId: tenantA, name: "validar_cpf" },
    });
    const r = await codeToolUpdate(
      principal({ tenantId: tenantB }),
      { code_tool_id: String(row.id), label: "x", dry_run: false },
      { base: appDb },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not found");
  });
});
