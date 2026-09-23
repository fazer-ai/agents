import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { knowledgeList } from "@/modules/mcp/read";
import {
  knowledgeCreate,
  knowledgeUpdate,
} from "@/modules/mcp/write-knowledge";
import {
  CONTACT_FOOTER_MAX_CHARS,
  isContactFooterParagraph,
  passageOf,
  stripContactFooter,
} from "@/modules/rag/contact-footer";
import { EMBEDDING_DIM } from "@/modules/rag/embeddings";
import {
  getKnowledgeBase,
  listKnowledgeBases,
  updateKnowledgeBase,
} from "@/modules/rag/service";
import { type ChunkRow, insertChunks, searchChunks } from "@/modules/rag/sql";

// Issue #747: a help-center article's closing "contact us" paragraph, retrieved into an agent, reads
// as an order to hand the customer off. With the base's switch on, the passage a search returns
// loses it; with the switch off, or anywhere but the tail of the document, nothing changes.

const ARTICLE =
  "Para trocar a senha, abra Configurações e toque em Segurança.\n\nO link de troca vale por 24 horas.";
const FOOTER =
  "Ainda com dúvidas? Entre em contato com nosso atendimento pelo e-mail sac@exemplo.com.br.";

describe("what counts as a contact footer", () => {
  test("a short paragraph with an e-mail, a phone number or an invitation", () => {
    // Each channel alone: the e-mail and the phone carry no invitation words, the invitation no
    // channel.
    expect(isContactFooterParagraph("atendimento@exemplo.com.br")).toBe(true);
    expect(isContactFooterParagraph("Ligue (11) 3456-7890.")).toBe(true);
    expect(isContactFooterParagraph("+55 11 98765-4321")).toBe(true);
    expect(isContactFooterParagraph("Ligue 11 3456-7890")).toBe(true);
    expect(isContactFooterParagraph("0800 123 4567")).toBe(true);
    expect(isContactFooterParagraph("Dúvidas? Fale conosco.")).toBe(true);
    expect(isContactFooterParagraph("Still stuck? Contact us.")).toBe(true);
  });

  test("a date, a price or plain content is not one", () => {
    expect(isContactFooterParagraph("Válido até 12/03/2026.")).toBe(false);
    expect(isContactFooterParagraph("Válido até 2026-03-12.")).toBe(false);
    expect(isContactFooterParagraph("Válido de 01-03-2026 a 31-03-2026.")).toBe(
      false,
    );
    expect(isContactFooterParagraph("Guarde o protocolo 123-4567.")).toBe(
      false,
    );
    // The digit runs an answer carries: a postal code, a tax id, an order number.
    expect(isContactFooterParagraph("O CEP da loja é 01310-100.")).toBe(false);
    expect(isContactFooterParagraph("CPF do titular: 123.456.789-00.")).toBe(
      false,
    );
    expect(isContactFooterParagraph("Pedido 1234567890.")).toBe(false);
    expect(isContactFooterParagraph("O plano custa R$ 1.200,00 por ano.")).toBe(
      false,
    );
    expect(isContactFooterParagraph("O link de troca vale por 24 horas.")).toBe(
      false,
    );
  });

  test("past the length bound it is content, even with an e-mail in it", () => {
    const long = `${"O reembolso é processado em até sete dias úteis. ".repeat(6)}Comprovantes vão para financeiro@exemplo.com.br.`;
    expect(long.length).toBeGreaterThan(CONTACT_FOOTER_MAX_CHARS);
    expect(isContactFooterParagraph(long)).toBe(false);
  });
});

describe("stripping it from a passage", () => {
  test("the trailing footer goes, the article stays byte for byte", () => {
    expect(stripContactFooter(`${ARTICLE}\n\n${FOOTER}`)).toBe(ARTICLE);
  });

  test("a footer of two blocks and the heading it hangs under go together", () => {
    const passage = `${ARTICLE}\n\n## Precisa de ajuda?\n\nFale conosco.\n\nsac@exemplo.com.br | (11) 3456-7890`;
    expect(stripContactFooter(passage)).toBe(ARTICLE);
  });

  test("an e-mail in a middle paragraph is left alone", () => {
    const passage = `Envie o comprovante para financeiro@exemplo.com.br.\n\n${ARTICLE}`;
    expect(stripContactFooter(passage)).toBe(passage);
  });

  test("a contact page under a title is kept whole, not cut down to the title", () => {
    const page = "# Suporte\n\nsuporte@exemplo.com.br\n\n(11) 3456-7890";
    expect(stripContactFooter(page)).toBe(page);
  });

  test("a passage that is only a footer is kept whole", () => {
    expect(stripContactFooter(FOOTER)).toBe(FOOTER);
    const twoBlocks = "Fale conosco.\n\nsac@exemplo.com.br";
    expect(stripContactFooter(twoBlocks)).toBe(twoBlocks);
  });

  test("a run of contact paragraphs longer than a footer is a list of channels, and stays", () => {
    const channels = `Nossos canais:\n\nVendas: vendas@exemplo.com.br\n\nSuporte: suporte@exemplo.com.br\n\nFinanceiro: financeiro@exemplo.com.br\n\nOuvidoria: ouvidoria@exemplo.com.br`;
    expect(stripContactFooter(channels)).toBe(channels);
  });

  test("several blank lines between the blocks of a footer are one separator", () => {
    expect(
      stripContactFooter(
        `${ARTICLE}\n\nFale conosco.\n\n\n\natendimento@exemplo.com.br`,
      ),
    ).toBe(ARTICLE);
  });

  test("the separators that stay are the ones the document had", () => {
    const spaced = "Primeiro passo.\n\n\nSegundo passo.\n \nTerceiro passo.";
    expect(stripContactFooter(`${spaced}\n\n${FOOTER}`)).toBe(spaced);
  });

  test("Windows line endings separate paragraphs too, and stay in what is kept", () => {
    const crlf = "Primeiro passo.\r\n\r\nSegundo passo.";
    expect(stripContactFooter(`${crlf}\r\n\r\nDúvidas? Fale conosco.`)).toBe(
      crlf,
    );
  });

  test("nothing to strip returns the passage untouched", () => {
    expect(stripContactFooter(ARTICLE)).toBe(ARTICLE);
  });
});

function row(over: Partial<ChunkRow>): ChunkRow {
  return {
    id: 1n,
    knowledgeBaseId: 1n,
    knowledgeBaseName: "Ajuda",
    documentId: 1n,
    documentTitle: "Trocar a senha",
    content: `${ARTICLE}\n\n${FOOTER}`,
    metadata: {},
    distance: 0.1,
    stripContactFooters: true,
    atDocumentEnd: true,
    ...over,
  };
}

describe("the hit a search returns", () => {
  test("switch on and the tail of the document: the footer is gone", () => {
    const hit = passageOf(row({}));
    expect(hit.content).toBe(ARTICLE);
    expect(hit).not.toHaveProperty("stripContactFooters");
    expect(hit).not.toHaveProperty("atDocumentEnd");
  });

  test("switch off: the passage is the stored chunk", () => {
    expect(passageOf(row({ stripContactFooters: false })).content).toBe(
      `${ARTICLE}\n\n${FOOTER}`,
    );
  });

  test("not the tail of the document: a paragraph the chunker cut there stays", () => {
    expect(passageOf(row({ atDocumentEnd: false })).content).toBe(
      `${ARTICLE}\n\n${FOOTER}`,
    );
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

function ctx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

function unit(dim: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[dim] = 1;
  return v;
}

let tenant = 0n;
let kbOn = 0n;
let kbOff = 0n;

describe.skipIf(!dbUp)("the switch, stored and read by the search", () => {
  // One document per base, chunked by hand into a head and a tail the way the splitter does it
  // (trimmed pieces of the trimmed text), so the tail chunk ends where the document ends.
  const HEAD = "Para trocar a senha, abra Configurações e toque em Segurança.";
  const TAIL = `O link de troca vale por 24 horas.\n\n${FOOTER}`;
  const DOC = `${HEAD}\n\n${TAIL}\n`;

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "CF", slug: `cf-747-${process.pid}` },
    });
    tenant = t.id;
    for (const which of ["on", "off"] as const) {
      const kb = await suDb.knowledgeBase.create({
        data: { tenantId: tenant, name: `KB ${which}`, embeddingModel: "m" },
      });
      if (which === "on") kbOn = kb.id;
      else kbOff = kb.id;
      const doc = await suDb.knowledgeDocument.create({
        data: {
          tenantId: tenant,
          knowledgeBaseId: kb.id,
          title: "Trocar a senha",
          sourceType: "text",
          content: DOC,
          status: "READY",
        },
      });
      await runScopedOn(appDb, ctx(tenant), (db) =>
        insertChunks(db, [
          {
            tenantId: tenant,
            knowledgeBaseId: kb.id,
            documentId: doc.id,
            content: HEAD,
            embedding: unit(which === "on" ? 0 : 2),
          },
          {
            tenantId: tenant,
            knowledgeBaseId: kb.id,
            documentId: doc.id,
            content: TAIL,
            embedding: unit(which === "on" ? 1 : 3),
          },
        ]),
      );
    }
  });

  afterAll(async () => {
    if (tenant) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM knowledge_chunks WHERE tenant_id = ${tenant}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM knowledge_documents WHERE tenant_id = ${tenant}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = ${tenant}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM knowledge_bases WHERE tenant_id = ${tenant}`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenant}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("a base is born with it off, and the operator turns it on", async () => {
    const before = await getKnowledgeBase({
      ctx: ctx(tenant),
      id: kbOn,
      base: appDb,
    });
    expect(before.stripContactFooters).toBe(false);
    await updateKnowledgeBase({
      ctx: ctx(tenant),
      id: kbOn,
      stripContactFooters: true,
      base: appDb,
    });
    const listed = await listKnowledgeBases(ctx(tenant), appDb);
    expect(listed.find((b) => b.id === kbOn)?.stripContactFooters).toBe(true);
    expect(listed.find((b) => b.id === kbOff)?.stripContactFooters).toBe(false);
  });

  test("the row says which base asks for it, and which chunk is the document's tail", async () => {
    const rows = await runScopedOn(appDb, ctx(tenant), (db) =>
      searchChunks(db, {
        knowledgeBaseIds: [kbOn, kbOff],
        queryEmbedding: unit(1),
        limit: 4,
      }),
    );
    const by = (kb: bigint, content: string) =>
      rows.find((r) => r.knowledgeBaseId === kb && r.content === content);
    expect(by(kbOn, TAIL)).toMatchObject({
      stripContactFooters: true,
      atDocumentEnd: true,
    });
    expect(by(kbOn, HEAD)).toMatchObject({
      stripContactFooters: true,
      atDocumentEnd: false,
    });
    // A base with the switch off never pays for the document read: the tail is not even asked.
    expect(by(kbOff, TAIL)).toMatchObject({
      stripContactFooters: false,
      atDocumentEnd: false,
    });
    // Same call, two bases: only the one that asked loses its footer.
    const passages = rows.map(passageOf);
    expect(
      passages.find((p) => p.knowledgeBaseId === kbOn && p.content !== HEAD)
        ?.content,
    ).toBe("O link de troca vale por 24 horas.");
    expect(
      passages.find((p) => p.knowledgeBaseId === kbOff && p.content !== HEAD)
        ?.content,
    ).toBe(TAIL);
  });

  test("the MCP reads it, previews it and writes it, on create and on update", async () => {
    const principal: VerifiedToken = {
      userId: 1n,
      tenantId: tenant,
      role: "TENANT_ADMIN",
      scopes: ["mcp:read", "mcp:write"],
      clientId: "c",
      jti: "j",
    };
    const created = await knowledgeCreate(
      principal,
      { name: "KB mcp", strip_contact_footers: true, dry_run: false },
      { base: appDb },
    );
    if (!created.ok) throw new Error(created.error);
    const id = created.data.id as string;
    const listed = await knowledgeList(principal, { base: appDb });
    if (!listed.ok) throw new Error(listed.error);
    const bases = listed.data.knowledgeBases as {
      id: string;
      stripContactFooters: boolean;
    }[];
    const mine = bases.find((b) => b.id === id);
    expect(mine?.stripContactFooters).toBe(true);

    const preview = await knowledgeUpdate(
      principal,
      { knowledge_base_id: id, strip_contact_footers: false },
      { base: appDb },
    );
    expect(JSON.stringify(preview)).toContain("stripContactFooters");
    expect(
      (
        await getKnowledgeBase({
          ctx: ctx(tenant),
          id: BigInt(id),
          base: appDb,
        })
      ).stripContactFooters,
    ).toBe(true);
    const applied = await knowledgeUpdate(
      principal,
      { knowledge_base_id: id, strip_contact_footers: false, dry_run: false },
      { base: appDb },
    );
    expect(applied.ok).toBe(true);
    expect(
      (
        await getKnowledgeBase({
          ctx: ctx(tenant),
          id: BigInt(id),
          base: appDb,
        })
      ).stripContactFooters,
    ).toBe(false);
  });
});
