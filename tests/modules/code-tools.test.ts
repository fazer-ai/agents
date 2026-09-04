import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import { runScopedOn } from "@/lib/tenancy";
import {
  codeToolReferences,
  createCodeTool,
  deleteCodeTool,
  getCodeTool,
  LIST_SELECT,
  listCodeTools,
  updateCodeTool,
} from "@/modules/code-tools/service";
import { documentStarter } from "@/modules/documents/starters";
import {
  createDocumentTemplate,
  updateDocumentTemplate,
} from "@/modules/documents/templates";
import { lockToolNames } from "@/modules/tool-definitions/namespace";
import { createToolDefinition } from "@/modules/tool-definitions/service";

// The operator-authored code tool's service (issue #363): the row is the operator's, invalid code
// SAVES with a warning, one name namespace with HTTP tools and natives, and the audit trail carries
// the shape without the body.

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
let otherTenantId = 0n;
const ctx = (t = tenantId): TenantContext => ({
  tenantId: t,
  userId: null,
  role: "TENANT_ADMIN",
});

const VALID = {
  name: "validar_cpf",
  label: "Validar CPF",
  description: "Valida um CPF informado pelo cliente.",
  inputSchema: { cpf: { type: "string", required: true } },
  code: "return validateCpf(input.cpf)",
};

async function refusal(p: Promise<unknown>): Promise<AppError | null> {
  return p.then(
    () => null,
    (e: unknown) => (e instanceof AppError ? e : null),
  );
}

describe.skipIf(!dbUp)("code tools service", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "code-tools", slug: `code-tools-${process.pid}` },
    });
    tenantId = t.id;
    const o = await suDb.tenant.create({
      data: { name: "code-tools-b", slug: `code-tools-b-${process.pid}` },
    });
    otherTenantId = o.id;
  });

  afterAll(async () => {
    if (dbUp && tenantId) {
      for (const id of [tenantId, otherTenantId]) {
        await suDb.$executeRaw`DELETE FROM audit_logs WHERE tenant_id = ${id}`;
        await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${id}`;
      }
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("create, list, get, update and delete round-trip, with no warning for a body that parses", async () => {
    const { tool, warnings } = await createCodeTool(ctx(), VALID, appDb);
    expect(warnings).toEqual([]);
    expect(tool).toMatchObject({
      name: "validar_cpf",
      label: "Validar CPF",
      enabled: true,
      inputSchema: { cpf: { type: "string", required: true } },
      code: VALID.code,
    });
    expect((await listCodeTools(ctx(), appDb)).map((t) => t.name)).toEqual([
      "validar_cpf",
    ]);
    expect((await getCodeTool(ctx(), BigInt(tool.id), appDb)).id).toBe(tool.id);
    const updated = await updateCodeTool(
      ctx(),
      BigInt(tool.id),
      { label: "Validar CPF v2", enabled: false },
      appDb,
    );
    expect(updated.tool).toMatchObject({
      label: "Validar CPF v2",
      enabled: false,
    });
    expect(updated.warnings).toEqual([]);
    await deleteCodeTool(ctx(), BigInt(tool.id), appDb);
    expect(await listCodeTools(ctx(), appDb)).toEqual([]);
    expect(
      (await refusal(getCodeTool(ctx(), BigInt(tool.id), appDb)))
        ?.translationKey,
    ).toBe("errors.codeToolNotFound");
  });

  test("invalid code SAVES, and the warning names the line; a body with no return is warned too", async () => {
    const { tool, warnings } = await createCodeTool(
      ctx(),
      { ...VALID, name: "quebrado", code: "const a = 1;\nreturn input.cpf." },
      appDb,
    );
    expect(warnings).toEqual([
      { kind: "syntax", line: 2, column: 17, message: expect.any(String) },
    ]);
    expect(tool.code).toBe("const a = 1;\nreturn input.cpf.");
    const patched = await updateCodeTool(
      ctx(),
      BigInt(tool.id),
      { code: "const x = validateCpf(input.cpf);" },
      appDb,
    );
    expect(patched.warnings).toEqual([{ kind: "noReturn" }]);
    // A patch that leaves the code alone answers no warning about it.
    const relabeled = await updateCodeTool(
      ctx(),
      BigInt(tool.id),
      { label: "Ainda quebrado" },
      appDb,
    );
    expect(relabeled.warnings).toEqual([]);
    await deleteCodeTool(ctx(), BigInt(tool.id), appDb);
  });

  test("the namespace is four kinds: RAG's names and a document's send_<slug> are taken too, both ways", async () => {
    // `dropDuplicateToolNames` decides by ASSEMBLY ORDER, and both of these are built before either
    // tool table — so the tool under the shared name exists in the console, is granted, and never
    // reaches the model. Knowable when it is written, so refused there.
    const rag = await refusal(
      createCodeTool(ctx(), { ...VALID, name: "search_knowledge" }, appDb),
    );
    expect(rag?.translationKey).toBe("errors.toolNameReserved");
    const ragHttp = await refusal(
      createToolDefinition(
        ctx(),
        {
          name: "suggest_kb_entry",
          label: "Sugerir",
          urlTemplate: "https://example.com/x",
          allowedHosts: ["example.com"],
        } as never,
        appDb,
      ),
    );
    expect(ragHttp?.translationKey).toBe("errors.toolNameReserved");

    await suDb.documentTemplate.create({
      data: {
        tenantId,
        name: "Orçamento",
        slug: "orcamento",
        blocks: [],
        fields: [],
        style: {},
      },
    });
    const onDocument = await refusal(
      createCodeTool(ctx(), { ...VALID, name: "send_orcamento" }, appDb),
    );
    expect(onDocument?.translationKey).toBe("errors.codeToolNameTaken");
    await suDb.documentTemplate.deleteMany({ where: { tenantId } });

    // ...and the reverse: a template whose slug would produce a name a code tool holds.
    const { tool } = await createCodeTool(
      ctx(),
      { ...VALID, name: "send_recibo" },
      appDb,
    );
    const starter = documentStarter("quote", "pt-BR");
    if (!starter) throw new Error("no starter");
    const reverse = await refusal(
      createDocumentTemplate(
        ctx(),
        {
          name: "Recibo",
          slug: "recibo",
          blocks: starter.blocks,
          fields: starter.fields,
          style: starter.style,
        } as never,
        appDb,
      ),
    );
    expect(reverse?.translationKey).toBe("errors.documentToolNameTaken");

    // The same question on the UPDATE door: a rename onto a slug whose tool name is taken. The
    // create and the update reach the row through different code, and only one of them was asking.
    const free = await createDocumentTemplate(
      ctx(),
      {
        name: "Livre",
        slug: "livre",
        blocks: starter.blocks,
        fields: starter.fields,
        style: starter.style,
      } as never,
      appDb,
    );
    const renamed = await refusal(
      updateDocumentTemplate(ctx(), BigInt(free.id), { slug: "recibo" }, appDb),
    );
    expect(renamed?.translationKey).toBe("errors.documentToolNameTaken");
    await suDb.documentTemplate.deleteMany({ where: { tenantId } });
    await deleteCodeTool(ctx(), BigInt(tool.id), appDb);
  });

  test("one namespace: a native name, an HTTP tool's name, and the reverse, are refused on the name", async () => {
    const native = await refusal(
      createCodeTool(ctx(), { ...VALID, name: "calculator" }, appDb),
    );
    expect(native?.translationKey).toBe("errors.toolNameReserved");
    expect(native?.field).toBe("name");

    await createToolDefinition(
      ctx(),
      {
        name: "consultar_pedido",
        label: "Consultar pedido",
        urlTemplate: "https://example.com/x",
        allowedHosts: ["example.com"],
      } as never,
      appDb,
    );
    const taken = await refusal(
      createCodeTool(ctx(), { ...VALID, name: "consultar_pedido" }, appDb),
    );
    expect(taken?.translationKey).toBe("errors.codeToolNameTaken");
    expect(taken?.statusCode).toBe(409);

    const { tool } = await createCodeTool(ctx(), VALID, appDb);
    const reverse = await refusal(
      createToolDefinition(
        ctx(),
        {
          name: "validar_cpf",
          label: "Validar CPF",
          urlTemplate: "https://example.com/x",
          allowedHosts: ["example.com"],
        } as never,
        appDb,
      ),
    );
    expect(reverse?.translationKey).toBe("errors.toolNameTaken");
    // Renaming onto itself is fine; onto the HTTP tool is not.
    await updateCodeTool(
      ctx(),
      BigInt(tool.id),
      { name: "validar_cpf" },
      appDb,
    );
    const rename = await refusal(
      updateCodeTool(
        ctx(),
        BigInt(tool.id),
        { name: "consultar_pedido" },
        appDb,
      ),
    );
    expect(rename?.translationKey).toBe("errors.codeToolNameTaken");
    await deleteCodeTool(ctx(), BigInt(tool.id), appDb);
    await suDb.toolDefinition.deleteMany({ where: { tenantId } });
  });

  test("every writer of a tool name queues behind one lock, the import included", async () => {
    // The namespace spans two tables, so no unique index covers it: under READ COMMITTED both
    // writes can read a free name and insert, and `dropDuplicateToolNames` then decides at assembly
    // which tool the agent gets, with a flow-log line as the only trace. What makes that impossible
    // is that both `assertNameFree`s take the same transaction lock first (namespace.ts).
    //
    // Measured rather than raced: two concurrent creates usually serialize on the pool and would
    // pass with no lock at all. Here the first transaction takes the lock for the SAME name and
    // holds it while it sleeps; the second's create can only get past its check once the first
    // commits, so its own duration is the proof. Without the lock it finishes immediately and this
    // fails on the elapsed time.
    const HELD_MS = 400;
    const name = "corrida_de_nome";
    let createMs = 0;
    await Promise.all([
      runScopedOn(suDb, ctx(), async (db) => {
        await lockToolNames(db);
        await db.$executeRawUnsafe(`SELECT pg_sleep(${HELD_MS / 1000})`);
      }),
      (async () => {
        // Started after the holder has the lock, so the wait measured is the lock's.
        await new Promise((r) => setTimeout(r, 50));
        const t0 = Date.now();
        await createCodeTool(ctx(), { ...VALID, name }, appDb);
        createMs = Date.now() - t0;
      })(),
    ]);
    expect(createMs).toBeGreaterThan(HELD_MS - 100);
    // The import writes past both services, so it is asked the same question: it takes the lock
    // before its own pre-check, and cannot be inside one while a create is.
    const transferSrc = await Bun.file("src/modules/agents/transfer.ts").text();
    expect(transferSrc).toContain("await lockToolNames(db);");
    // ...and once it is the owner, the other table's write is refused on the name.
    const taken = await refusal(
      createToolDefinition(
        ctx(),
        {
          name,
          label: "Corrida",
          urlTemplate: "https://example.com/x",
          allowedHosts: ["example.com"],
        } as never,
        appDb,
      ),
    );
    expect(taken?.translationKey).toBe("errors.toolNameTaken");
    await suDb.codeToolDefinition.deleteMany({ where: { tenantId } });
  });

  test("blank metadata and a reserved field name are refused where they are typed", async () => {
    // `min(1)` counts characters, so a label of spaces used to store a row with no visible name and
    // a description of spaces a tool with no instruction — and the description is the only thing
    // that tells the model when to call it.
    for (const [field, patch] of [
      ["label", { label: "   " }],
      ["description", { description: "  " }],
    ] as const) {
      const blank = await refusal(
        createCodeTool(ctx(), { ...VALID, name: "em_branco", ...patch }, appDb),
      );
      expect([field, blank?.statusCode]).toEqual([field, 422]);
    }
    // `__proto__` has to be refused BEFORE zod: `z.record` builds its result by assignment, so the
    // key is gone by the time anything downstream could report it, and the tool would be saved
    // offering a parameter it never declares.
    const reserved = await refusal(
      createCodeTool(
        ctx(),
        {
          ...VALID,
          name: "reservado",
          inputSchema: JSON.parse(
            '{"__proto__":{"type":"string"},"cpf":{"type":"string"}}',
          ),
        },
        appDb,
      ),
    );
    expect(reserved?.statusCode).toBe(422);
    expect(reserved?.field).toBe("inputSchema");
    // The same request written as standard JSON Schema, where the field sits under `properties`:
    // one spelling refused and the other quietly converted into a map without the field is the
    // shape of the defect, not a fix for it.
    const nested = await refusal(
      createCodeTool(
        ctx(),
        {
          ...VALID,
          name: "reservado_json",
          inputSchema: JSON.parse(
            '{"type":"object","properties":{"__proto__":{"type":"string"},"cpf":{"type":"string"}},"required":["cpf"]}',
          ),
        },
        appDb,
      ),
    );
    expect(nested?.statusCode).toBe(422);
    expect(nested?.field).toBe("inputSchema");
    expect(await listCodeTools(ctx(), appDb)).toEqual([]);
  });

  test("the list carries every column but the body, which get returns", async () => {
    // A body is up to 20k characters and a tenant's tools are not counted: a list that read them
    // would be most of a megabyte of source that neither consumer uses.
    const { tool } = await createCodeTool(ctx(), VALID, appDb);
    // The COLUMN, not just the DTO: a projection that drops `code` on the way out would still have
    // loaded every body from Postgres, which is the cost this is about — and the DTO cannot see the
    // difference, so the select the query carries is asserted directly.
    expect(LIST_SELECT.code).toBe(false);
    const [listed] = await listCodeTools(ctx(), appDb);
    expect(listed).toMatchObject({ name: "validar_cpf", label: "Validar CPF" });
    expect("code" in (listed as object)).toBe(false);
    expect((await getCodeTool(ctx(), BigInt(tool.id), appDb)).code).toBe(
      VALID.code,
    );
    await deleteCodeTool(ctx(), BigInt(tool.id), appDb);
  });

  test("a JSON-Schema-shaped input schema is stored as the compact map the runtime reads", async () => {
    const { tool } = await createCodeTool(
      ctx(),
      {
        ...VALID,
        name: "json_schema",
        inputSchema: {
          type: "object",
          properties: { cpf: { type: "string", description: "o CPF" } },
          required: ["cpf"],
        },
      },
      appDb,
    );
    expect(tool.inputSchema).toEqual({
      cpf: { type: "string", required: true, description: "o CPF" },
    });
    await deleteCodeTool(ctx(), BigInt(tool.id), appDb);
  });

  test("the audit trail carries the shape and never the body, and a code-only edit still writes a row", async () => {
    const { tool } = await createCodeTool(ctx(), VALID, appDb);
    const target = `code_tool:${tool.id}`;
    await updateCodeTool(
      ctx(),
      BigInt(tool.id),
      { code: "return { valid: validateCpf(input.cpf).valid }" },
      appDb,
    );
    // The same save again: nothing moved, no row.
    await updateCodeTool(
      ctx(),
      BigInt(tool.id),
      { code: "return { valid: validateCpf(input.cpf).valid }" },
      appDb,
    );
    await deleteCodeTool(ctx(), BigInt(tool.id), appDb);
    const rows = await suDb.auditLog.findMany({
      where: { tenantId, target },
      orderBy: { id: "asc" },
    });
    expect(rows.map((r) => r.action)).toEqual([
      "code_tool.create",
      "code_tool.update",
      "code_tool.delete",
    ]);
    expect(rows[0]?.after).toEqual({
      name: "validar_cpf",
      label: "Validar CPF",
      enabled: true,
      inputFieldCount: 1,
    });
    expect(rows[1]?.before).toMatchObject({ undisclosedChanged: true });
    expect(rows[1]?.after).toMatchObject({ undisclosedChanged: true });
    for (const r of rows) {
      expect(JSON.stringify(r.before ?? {})).not.toContain("validateCpf");
      expect(JSON.stringify(r.after ?? {})).not.toContain("validateCpf");
    }
  });

  test("RLS: another tenant cannot read, patch or delete it, and the grant CHECK holds both ways", async () => {
    const { tool } = await createCodeTool(ctx(), VALID, appDb);
    const id = BigInt(tool.id);
    expect(
      (await refusal(getCodeTool(ctx(otherTenantId), id, appDb)))
        ?.translationKey,
    ).toBe("errors.codeToolNotFound");
    expect(
      (
        await refusal(
          updateCodeTool(ctx(otherTenantId), id, { label: "x" }, appDb),
        )
      )?.translationKey,
    ).toBe("errors.codeToolNotFound");
    expect(
      (await refusal(deleteCodeTool(ctx(otherTenantId), id, appDb)))
        ?.translationKey,
    ).toBe("errors.codeToolNotFound");

    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "granted",
        systemPrompt: "p",
        modelConfig: {},
        settings: {},
      },
    });
    // A CODE grant needs its id; an HTTP grant may not carry one.
    const refusedBy = async (p: Promise<unknown>) =>
      p.then(
        () => "",
        (e: unknown) => String(e),
      );
    expect(
      await refusedBy(
        suDb.$executeRaw`INSERT INTO agent_tool_selections (tenant_id, agent_id, source, knowledge_base_ids, enabled_tools, updated_at) VALUES (${tenantId}, ${agent.id}, 'CODE', '{}', '{}', NOW())`,
      ),
    ).toContain("agent_tool_selection_source_target_check");
    expect(
      await refusedBy(
        suDb.$executeRaw`INSERT INTO agent_tool_selections (tenant_id, agent_id, source, tool_definition_id, code_tool_definition_id, knowledge_base_ids, enabled_tools, updated_at) VALUES (${tenantId}, ${agent.id}, 'HTTP', 1, ${id}, '{}', '{}', NOW())`,
      ),
    ).toContain("agent_tool_selection_source_target_check");
    await suDb.$executeRaw`INSERT INTO agent_tool_selections (tenant_id, agent_id, source, code_tool_definition_id, knowledge_base_ids, enabled_tools, updated_at) VALUES (${tenantId}, ${agent.id}, 'CODE', ${id}, '{}', '{}', NOW())`;
    expect(await codeToolReferences(ctx(), id, appDb)).toEqual({
      agents: [{ id: String(agent.id), name: "granted" }],
    });
    // The grant follows the row out.
    await deleteCodeTool(ctx(), id, appDb);
    expect(
      await suDb.agentToolSelection.count({
        where: { agentId: agent.id, source: "CODE" },
      }),
    ).toBe(0);
  });
});
