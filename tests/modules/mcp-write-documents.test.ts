import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { listDocumentTemplates } from "@/modules/documents/templates";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { issuedDocumentList } from "@/modules/mcp/read";
import {
  documentTemplateCreate,
  documentTemplateDelete,
  documentTemplateUpdate,
} from "@/modules/mcp/write-documents";

// Authoring a rich document over MCP is the point of this surface, and the dry-run is what makes it
// usable without a visual editor: it RENDERS. A preview that only diffed field counts would report
// "blocks: 6 → 7" and say nothing about whether the seventh lays out.

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

describe("MCP document-write gate (no DB)", () => {
  test("document_template_create without mcp:write → insufficient_scope", async () => {
    const r = await documentTemplateCreate(
      principal({ scopes: ["mcp:read"] }),
      { name: "x" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("insufficient_scope");
  });

  test("an unknown starter is refused by name, and points at the list tool", async () => {
    const r = await documentTemplateCreate(principal({}), {
      starter: "invoice",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("document_starters_list");
  });

  test("document_template_update with an invalid id → error", async () => {
    const r = await documentTemplateUpdate(principal({}), {
      document_template_id: "nope",
      name: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid document_template_id");
  });

  test("document_template_update with no fields → error naming them", async () => {
    const r = await documentTemplateUpdate(principal({}), {
      document_template_id: "1",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("blocks");
  });
});

// ── DB-gated ──

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

const ctx = () => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN" as const,
});

describe.skipIf(!dbUp)("MCP document writes", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "McpDoc", slug: `mcpdoc-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM document_templates WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  // dry-run is the DEFAULT: omitting the flag must create nothing.
  test("dry-run renders the document and creates nothing", async () => {
    const r = await documentTemplateCreate(
      principal({ tenantId }),
      { starter: "quote" },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as {
        dryRun: boolean;
        preview: { renderedBytes: number };
      };
      expect(data.dryRun).toBe(true);
      // Rendered, not described: the number is the size of a real PDF.
      expect(data.preview.renderedBytes).toBeGreaterThan(500);
    }
    expect(await listDocumentTemplates(ctx(), appDb)).toHaveLength(0);
  });

  // The dry run has to report the value the APPLY will keep. `templateNameSchema` trims, so a padded
  // name is accepted and stored shorter than it arrived — and a caller shown the raw one was told
  // the write keeps something it does not. The same drift, on a different surface, was found in the
  // bundle import a round earlier.
  test("a padded name is reported and applied in the form it will be stored", async () => {
    const dry = await documentTemplateCreate(
      principal({ tenantId }),
      { starter: "quote", name: "  Orçamento Padrão  " },
      { base: appDb },
    );
    expect(dry.ok).toBe(true);
    if (dry.ok) {
      const data = dry.data as { preview: { name: string } };
      expect(data.preview.name).toBe("Orçamento Padrão");
    }
    const applied = await documentTemplateCreate(
      principal({ tenantId }),
      { starter: "quote", name: "  Orçamento Padrão  ", dry_run: false },
      { base: appDb },
    );
    expect(applied.ok).toBe(true);
    const templates = await listDocumentTemplates(ctx(), appDb);
    expect(templates.map((t) => t.name)).toEqual(["Orçamento Padrão"]);

    // …and the update dry run's diff answers with the same value it would write.
    const id = templates[0]?.id as string;
    const upd = await documentTemplateUpdate(
      principal({ tenantId }),
      { document_template_id: id, name: "   Recibo   " },
      { base: appDb },
    );
    expect(upd.ok).toBe(true);
    if (upd.ok) {
      const data = upd.data as { diff: Record<string, unknown> };
      expect(JSON.stringify(data.diff)).toContain("Recibo");
      expect(JSON.stringify(data.diff)).not.toContain("   Recibo   ");
    }
    // The file has no per-test cleanup and its tests count what is in the table, so a test that
    // leaves a row behind fails the NEXT one.
    await suDb.$executeRawUnsafe(
      `DELETE FROM document_templates WHERE tenant_id = ${tenantId}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`,
    );
  });

  test("applies with dry_run:false, and records an audit entry", async () => {
    const r = await documentTemplateCreate(
      principal({ tenantId }),
      { starter: "quote", dry_run: false },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { applied: boolean; toolName: string };
      expect(data.applied).toBe(true);
      expect(data.toolName).toBe("send_orcamento");
    }
    const templates = await listDocumentTemplates(ctx(), appDb);
    expect(templates).toHaveLength(1);
    const audit = await suDb.auditLog.findMany({
      where: { tenantId, action: "document_template.create" },
      select: { target: true },
    });
    expect(audit).toHaveLength(1);
  });

  // The refusal is the whole reason the shape is not published in the tool schema: it has to name
  // the block and the rule, so an authoring client can fix its own write.
  test("a block that will not render is refused by name, before it saves", async () => {
    const before = await listDocumentTemplates(ctx(), appDb);
    const r = await documentTemplateCreate(
      principal({ tenantId }),
      {
        name: "Quebrado",
        blocks: [{ id: "li", type: "lineItems", field: "nao_existe" }],
        fields: [],
        dry_run: false,
      },
      { base: appDb },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("nao_existe");
      expect(r.error).toContain("li");
    }
    expect(await listDocumentTemplates(ctx(), appDb)).toHaveLength(
      before.length,
    );
  });

  test("update dry-run diffs the projection and changes nothing", async () => {
    const [tpl] = await listDocumentTemplates(ctx(), appDb);
    const r = await documentTemplateUpdate(
      principal({ tenantId }),
      { document_template_id: tpl?.id as string, name: "Orçamento 2026" },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as {
        dryRun: boolean;
        diff: Record<string, { before: unknown; after: unknown }>;
      };
      expect(data.dryRun).toBe(true);
      expect(data.diff.name).toEqual({
        before: "Orçamento",
        after: "Orçamento 2026",
      });
    }
    const [after] = await listDocumentTemplates(ctx(), appDb);
    expect(after?.name).toBe("Orçamento");
  });

  // The dry-run's whole job is to show what applying WOULD change, and `fields` is the half a client
  // cares most about: it is the agent's argument list. A projection that carries the patch for some
  // properties and the stored value for others reports "nothing changes" for a write that changes
  // the tool contract — the worst possible answer, because it is confident.
  test("the update dry-run diffs patched fields and style, not just names", async () => {
    const [tpl] = await listDocumentTemplates(ctx(), appDb);
    const r = await documentTemplateUpdate(
      principal({ tenantId }),
      {
        document_template_id: tpl?.id as string,
        // Appended, not replaced: the blocks still point at the starter's fields, and dropping
        // those would be refused by the content check — a different rule, correctly.
        fields: [
          ...(tpl?.fields ?? []),
          { name: "observacao", label: "Observação", type: "text" },
        ],
        // Only the property being changed: a patch that also resends footerText would agree with a
        // projection built from the patch alone, and prove nothing about the merge.
        style: { font: "mono" },
      },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as {
        diff: Record<string, { before: unknown; after: unknown }>;
      };
      expect(data.diff.fields).toBeDefined();
      expect(data.diff.fields?.after).toContain("observacao:text");
      const afterStyle = data.diff.style?.after as
        | { font?: string; footerText?: string }
        | undefined;
      expect(afterStyle?.font).toBe("mono");
      // …and the saved footer is still there: from the patch alone an omitted optional diffs as
      // REMOVED, which is a change the apply would not make.
      const savedStyle = tpl?.style as { footerText?: string } | undefined;
      expect(afterStyle?.footerText).toBe(savedStyle?.footerText);
    }
    // …and still applies nothing.
    const [after] = await listDocumentTemplates(ctx(), appDb);
    expect(after?.fields.some((f) => f.name === "observacao")).toBe(false);
    expect(after?.style.font).not.toBe("mono");
  });

  // Both are advertised as nullable overrides, and `??` reads an explicit null as "not supplied" —
  // so a caller asking for a starter WITHOUT its description or its number prefix silently got them
  // back, with nothing saying the argument was ignored.
  test("an explicit null override is not filled back in from the starter", async () => {
    const r = await documentTemplateCreate(
      principal({ tenantId }),
      {
        starter: "quote",
        name: "Sem prefixo",
        slug: "sem_prefixo",
        description: null,
        number_prefix: null,
        dry_run: false,
      },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    const saved = (await listDocumentTemplates(ctx(), appDb)).find(
      (t) => t.slug === "sem_prefixo",
    );
    expect(saved?.numberPrefix).toBeNull();
    expect(saved?.description).toBeNull();
  });

  // A rename keeps the slug it already has, so a dry run must not judge a slug the write will never
  // use: deriving one from the new name could refuse a perfectly good rename — and only on the dry
  // run, which is the worst possible place to disagree with the apply.
  //
  // The new name has to be one the derived slug collides on and the NAME index does not, which is
  // what isolates the rule. It used to reuse "Sem prefixo" verbatim, which is also the taken NAME —
  // so once the dry run started asking the name index (as it must; see the rename test below) that
  // fixture began failing for the right reason about the wrong rule.
  test("a name-only dry run does not judge a slug derived from the name", async () => {
    const [tpl] = await listDocumentTemplates(ctx(), appDb);
    const r = await documentTemplateUpdate(
      principal({ tenantId }),
      // Slugifies to "sem_prefixo", which the test above took — under a different NAME.
      { document_template_id: tpl?.id as string, name: "Sem  prefixo!" },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
  });

  // A dry run that renders a beautiful document and then answers "valid" for input the apply
  // refuses is worse than no dry run at all: the caller acts on it, and the failure arrives on the
  // write it was told was safe.
  test("the dry run refuses what the apply would refuse", async () => {
    const blank = await documentTemplateCreate(
      principal({ tenantId }),
      { name: "   ", starter: "quote" },
      { base: appDb },
    );
    expect(blank.ok).toBe(false);

    const builtin = await documentTemplateCreate(
      principal({ tenantId }),
      { starter: "quote", name: "Imagem", slug: "image" },
      { base: appDb },
    );
    expect(builtin.ok).toBe(false);
    if (!builtin.ok) expect(builtin.error).toContain("send_image");

    // The tenant already has "orcamento" from the apply above. The refusal names the template that
    // holds it and the tool name both would produce, because an authoring client is choosing a NAME
    // and "the slug already exists" points at a field it did not send.
    const taken = await documentTemplateCreate(
      principal({ tenantId }),
      { starter: "quote", name: "Outro orçamento", slug: "orcamento" },
      { base: appDb },
    );
    expect(taken.ok).toBe(false);
    if (!taken.ok) {
      expect(taken.error).toContain("Orçamento");
      expect(taken.error).toContain("send_orcamento");
    }

    // The PREVIEW asks it too: rendering a prefix the create would refuse is the same disagreement,
    // and it feeds an unbounded string into a PDF built on the request thread.
    const longPrefix = await documentTemplateCreate(
      principal({ tenantId }),
      {
        starter: "quote",
        name: "Prefixo enorme",
        slug: "prefixo_enorme",
        number_prefix: "P".repeat(21),
      },
      { base: appDb },
    );
    expect(longPrefix.ok).toBe(false);
    if (!longPrefix.ok) expect(longPrefix.error).toContain("numberPrefix");

    // The UPDATE dry run asks the same question — it was the half that reported "valid" for a rename
    // the apply would then refuse.
    const [tpl] = await listDocumentTemplates(ctx(), appDb);
    const renamed = await documentTemplateUpdate(
      principal({ tenantId }),
      { document_template_id: tpl?.id as string, slug: "image" },
      { base: appDb },
    );
    expect(renamed.ok).toBe(false);
    if (!renamed.ok) expect(renamed.error).toContain("send_image");
    // The description bound belongs to the dry run too: it is checked by the apply and ignored by
    // the render, so a preview would report a template valid that the write then refuses.
    const longDescription = await documentTemplateCreate(
      principal({ tenantId }),
      {
        starter: "quote",
        name: "Descritivo",
        slug: "descritivo_mcp",
        description: "x".repeat(2_001),
      },
      { base: appDb },
    );
    expect(longDescription.ok).toBe(false);
    if (!longDescription.ok) {
      expect(longDescription.error).toContain("2000");
    }

    const blankRename = await documentTemplateUpdate(
      principal({ tenantId }),
      { document_template_id: tpl?.id as string, name: "   " },
      { base: appDb },
    );
    expect(blankRename.ok).toBe(false);

    // …and renaming a template's slug to the one it already has is not a collision.
    const same = await documentTemplateUpdate(
      principal({ tenantId }),
      { document_template_id: tpl?.id as string, slug: tpl?.slug as string },
      { base: appDb },
    );
    expect(same.ok).toBe(true);
  });

  test("delete dry-run says what survives the deletion", async () => {
    const before = await listDocumentTemplates(ctx(), appDb);
    const [tpl] = before;
    const r = await documentTemplateDelete(
      principal({ tenantId }),
      { document_template_id: tpl?.id as string },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { preview: { note: string } };
      expect(data.preview.note).toContain("frozen copy");
    }
    expect(await listDocumentTemplates(ctx(), appDb)).toHaveLength(
      before.length,
    );
  });

  // A narrowing filter that arrives malformed must NARROW to nothing, not widen to everything.
  // Truthiness read an explicit empty string as "not supplied" and answered with the tenant's whole
  // recent list — the widest possible answer to the narrowest possible question.
  test("an explicitly empty template filter is refused, not ignored", async () => {
    const r = await issuedDocumentList(
      principal({ tenantId }),
      { template_id: "" },
      { base: appDb },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("template_id");
    // …and a real one still filters.
    const [tpl] = await listDocumentTemplates(ctx(), appDb);
    const scoped = await issuedDocumentList(
      principal({ tenantId }),
      { template_id: tpl?.id as string },
      { base: appDb },
    );
    expect(scoped.ok).toBe(true);
  });

  // A padded id is not a rejected id: `BigInt(" 17 ")` is 17n, so a write with dry_run:false would
  // edit or DELETE a real template the caller never named. The read parser learned this one round
  // before the writes did — the rule now lives in one place, so there is no "one round before" left.
  test("refuses a padded or empty id on a write", async () => {
    const [tpl] = await listDocumentTemplates(ctx(), appDb);
    for (const bad of [` ${tpl?.id} `, "", "17x"]) {
      const r = await documentTemplateUpdate(
        principal({ tenantId }),
        { document_template_id: bad, name: "x" },
        { base: appDb },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("document_template_id");
    }
    // …and the template is untouched.
    const after = await listDocumentTemplates(ctx(), appDb);
    expect(after.find((t) => t.id === tpl?.id)?.name).toBe(tpl?.name);
  });

  // THE DRY RUN'S ONE PROMISE: what it approves, the apply performs. A rename supplies a name and no
  // slug — the slug is a tool name an agent may already be granted, so a rename deliberately keeps
  // it — and the uniqueness pre-check was reached only when there was a slug to validate. So the
  // dry run answered "no problem" to a rename onto a name this tenant already uses, and the same
  // call with dry_run:false came back 409 from the name's unique index.
  //
  // Both halves are asserted, and in this order: the refusal is worth nothing if the apply would
  // have succeeded, so the test first proves the apply really does refuse.
  test("a rename onto a taken name is refused by the dry run, not only by the apply", async () => {
    // Both created here rather than reused from the suite's state: which templates exist depends on
    // the order the tests above ran in, and this one needs exactly two names it owns.
    const taken = `Recibo ${process.pid}`;
    const mine = `Proposta ${process.pid}`;
    for (const name of [taken, mine]) {
      const r = await documentTemplateCreate(
        principal({ tenantId }),
        { starter: "receipt", name, dry_run: false },
        { base: appDb },
      );
      expect(r.ok).toBe(true);
    }
    const templates = await listDocumentTemplates(ctx(), appDb);
    const target = templates.find((t) => t.name === taken);
    const other = templates.find((t) => t.name === mine);
    expect(target?.id).toBeTruthy();
    expect(other?.id).toBeTruthy();

    // The apply refuses, which is what makes approving it a broken promise rather than a nicety.
    const applied = await documentTemplateUpdate(
      principal({ tenantId }),
      {
        document_template_id: other?.id as string,
        name: taken,
        dry_run: false,
      },
      { base: appDb },
    );
    expect(applied.ok).toBe(false);

    // …and so does the dry run, naming the name rather than a slug the operator never typed.
    const dry = await documentTemplateUpdate(
      principal({ tenantId }),
      {
        document_template_id: other?.id as string,
        name: taken,
      },
      { base: appDb },
    );
    expect(dry.ok).toBe(false);
    if (!dry.ok) expect(dry.error).toContain(taken);

    // Renaming a template to the name it already has is not a collision with itself.
    const sameName = await documentTemplateUpdate(
      principal({ tenantId }),
      {
        document_template_id: target?.id as string,
        name: taken,
      },
      { base: appDb },
    );
    expect(sameName.ok).toBe(true);

    await suDb.documentTemplate.deleteMany({
      where: { tenantId, name: { in: [taken, mine] } },
    });
  });

  // The tenant fence: a template belonging to tenant A is not addressable from tenant B's token,
  // and the answer is the same "not found" either way.
  test("another tenant's template is not addressable", async () => {
    const [tpl] = await listDocumentTemplates(ctx(), appDb);
    const other = await suDb.tenant.create({
      data: { name: "McpDocB", slug: `mcpdocb-${process.pid}` },
    });
    try {
      const r = await documentTemplateUpdate(
        principal({ tenantId: other.id }),
        { document_template_id: tpl?.id as string, name: "roubado" },
        { base: appDb },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("not found");
    } finally {
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${other.id}`,
      );
    }
  });
});
