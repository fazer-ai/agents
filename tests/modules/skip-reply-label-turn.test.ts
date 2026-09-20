import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { getConversationDetail } from "@/modules/conversations/service";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog } from "../utils/flowlog";

// ── O MARCADOR DE SILÊNCIO TEM QUE SABER SE O TURNO FALOU (issue #726) ──
//
// A tela de conversa rotula um marcador pelo NOME da ferramenta e nada mais, então `skip_reply` lê
// "Decidiu não responder" mesmo num turno em que a transferência já entregou uma mensagem ao
// cliente. O operador vê a resposta uma linha acima e o marcador negando que ela existe, e isso é o
// que vira "o bot ignorou o cliente" na escalação.
//
// O discriminante NÃO é o nome da ferramenta: é se ESTE TURNO botou uma mensagem na thread. Ler o
// nome ("transferiu, logo respondeu") passa no caso reportado e troca uma mentira por outra no
// turno em que a transferência foi declaradamente muda, que é um caso real desde a #662.
//
// A trilha é o lado barato de medir: a projeção já lê as linhas de `execution_logs` da conversa, e
// o que falta é o marcador de silêncio carregar o fato. O lado ao vivo, que não tem trilha para
// consultar, tem o seu próprio teste.

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
let convId = 0n;
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

// Uma linha de ferramenta como o `ToolFlowlog` a escreve, com o `turnId` do turno a que ela
// pertence. `turnDelivered` é o fato que falta hoje: a entrega é decidida pelo runtime e o
// marcador de silêncio não a enxerga.
async function linhaDeFerramenta(
  turnId: string,
  tool: string,
  detail: Record<string, unknown> = {},
) {
  await suDb.executionLog.create({
    data: {
      tenantId,
      conversationId: convId,
      turnId,
      source: "inbox",
      stage: "tool",
      level: "info",
      status: "ok",
      durationMs: 1,
      detail: { tool, ...detail },
    },
  });
}

async function trilha() {
  const d = await getConversationDetail(ctx(), convId, appDb);
  return d.trail;
}

describe.skipIf(!dbUp)("o marcador de silêncio e o turno que falou", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "SKIPLBL", slug: `skiplbl-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 1,
      adminToken: "enc",
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: inst.id,
        chatwootInboxId: 10,
        name: "Support",
      },
    });
    const contact = await suDb.contact.create({
      data: {
        chatwootInstanceId: inst.id,
        tenantId,
        chatwootContactId: 5,
        name: "Alice",
      },
    });
    const conv = await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: inst.id,
        chatwootConversationId: 100,
        inboxId: inbox.id,
        contactId: contact.id,
        status: "pending",
        assigneeType: "AgentBot",
        threadId: `${tenantId}:${inst.id}:100`,
        lastEventAt: new Date("2026-09-20T10:00:00Z"),
      },
    });
    convId = conv.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await clearFlowLog(suDb, { tenantId });
      await suDb.$executeRaw`DELETE FROM conversations WHERE tenant_id = ${tenantId}`;
      await suDb.$executeRaw`DELETE FROM contacts WHERE tenant_id = ${tenantId}`;
      await suDb.$executeRaw`DELETE FROM inboxes WHERE tenant_id = ${tenantId}`;
      await suDb.$executeRaw`DELETE FROM chatwoot_instances WHERE tenant_id = ${tenantId}`;
      await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}`;
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  // O INSTRUMENTO, provado antes de qualquer veredito: a projeção devolve os marcadores, com nome e
  // argumentos. Se isto falhar, "o campo não veio" não diz nada sobre o campo.
  test("a trilha devolve os marcadores do turno, com nome e argumentos", async () => {
    await linhaDeFerramenta("turno-instrumento", "handoff_to_human", {
      args: { customerMessage: "Já chamo uma pessoa." },
    });
    await linhaDeFerramenta("turno-instrumento", "skip_reply");
    const t = await trilha();
    expect(t.map((e) => e.name).sort()).toEqual([
      "handoff_to_human",
      "skip_reply",
    ]);
    const h = t.find((e) => e.name === "handoff_to_human");
    const args = h?.args as Record<string, unknown> | undefined;
    expect(args?.customerMessage).toBe("Já chamo uma pessoa.");
  });

  // O caso reportado: o turno transferiu COM mensagem, então o marcador de silêncio não pode ser
  // lido como "ninguém respondeu".
  test("o silêncio de um turno que entregou mensagem se distingue na trilha", async () => {
    await clearFlowLog(suDb, { tenantId });
    await linhaDeFerramenta("turno-entregou", "handoff_to_human", {
      args: { customerMessage: "Já chamo uma pessoa." },
    });
    await linhaDeFerramenta("turno-entregou", "skip_reply", {
      turnDelivered: true,
    });
    const skip = (await trilha()).find((e) => e.name === "skip_reply");
    expect(skip?.turnDelivered).toBe(true);
  });

  // O par obrigatório, e o discriminante da rodada: transferiu SEM mensagem. Nada saiu, a frase é
  // verdadeira, e o marcador tem que continuar dizendo que o cliente ficou sem resposta.
  test("o silêncio de um turno que não entregou nada continua sendo silêncio", async () => {
    await clearFlowLog(suDb, { tenantId });
    await linhaDeFerramenta("turno-mudo", "handoff_to_human", {
      args: { customerMessage: "" },
    });
    await linhaDeFerramenta("turno-mudo", "skip_reply", {
      turnDelivered: false,
    });
    const skip = (await trilha()).find((e) => e.name === "skip_reply");
    expect(skip?.turnDelivered).toBe(false);
  });

  // O lote paralelo, que é a única forma de duas linhas de `skip_reply` caírem no mesmo turno: o
  // modelo emite a decisão junto com a ferramenta que fala, esse lote NÃO encerra o turno
  // (`onlySkipped`), e o modelo é perguntado de novo e responde com a decisão sozinha. A primeira
  // linha foi escrita enquanto a companheira ainda rodava, e diz "nada ainda", o que é verdade sobre
  // aquele instante e mentira sobre o turno, que é o que o marcador afirma. Quem responde pelo turno
  // é a decisão TERMINAL, que é a mais bem informada que ele tem.
  test("duas decisões no mesmo turno leem o turno, não o instante", async () => {
    await clearFlowLog(suDb, { tenantId });
    await linhaDeFerramenta("turno-lote", "skip_reply", {
      turnDelivered: false,
    });
    await linhaDeFerramenta("turno-lote", "send_image");
    await linhaDeFerramenta("turno-lote", "skip_reply", {
      turnDelivered: true,
    });
    const t = await trilha();
    const decisoes = t.filter((e) => e.name === "skip_reply");
    expect(decisoes).toHaveLength(2);
    expect(decisoes.map((e) => e.turnDelivered)).toEqual([true, true]);
  });

  // O OUTRO LADO, e o achado da rodada 1 de review: a primeira linha do lote pode ter lido uma
  // RESERVA (o anexo é reservado antes do download), e um download que falha desfaz a reserva sem
  // nada ter saído. A decisão terminal é a mais bem informada do turno — quando ela é escrita, tudo
  // a que o turno se comprometeu já aconteceu — então é ela que responde pelo turno, e uma resposta
  // provisória mais velha não pode sobreviver a ela.
  test("a decisão terminal vence a provisória que leu uma reserva", async () => {
    await clearFlowLog(suDb, { tenantId });
    await linhaDeFerramenta("turno-reservou", "skip_reply", {
      turnDelivered: true,
    });
    await linhaDeFerramenta("turno-reservou", "send_image");
    await linhaDeFerramenta("turno-reservou", "skip_reply", {
      turnDelivered: false,
    });
    const decisoes = (await trilha()).filter((e) => e.name === "skip_reply");
    expect(decisoes).toHaveLength(2);
    expect(decisoes.map((e) => e.turnDelivered)).toEqual([false, false]);
  });

  // O OU é do turno, não da conversa: o turno mudo ao lado do turno que entregou continua mudo.
  test("o OU não atravessa a fronteira do turno", async () => {
    await clearFlowLog(suDb, { tenantId });
    await linhaDeFerramenta("turno-falou", "skip_reply", {
      turnDelivered: true,
    });
    await linhaDeFerramenta("turno-calou", "skip_reply", {
      turnDelivered: false,
    });
    const t = await trilha();
    expect(t.map((e) => e.turnDelivered)).toEqual([true, false]);
  });

  // Só a ferramenta do silêncio afirma alguma coisa sobre o silêncio. O marcador da transferência,
  // no mesmo turno que entregou, não passa a carregar o fato.
  test("nenhum outro marcador do turno passa a carregar o fato", async () => {
    await clearFlowLog(suDb, { tenantId });
    await linhaDeFerramenta("turno-transferiu", "handoff_to_human", {
      args: { customerMessage: "Já chamo uma pessoa." },
    });
    await linhaDeFerramenta("turno-transferiu", "skip_reply", {
      turnDelivered: true,
    });
    const t = await trilha();
    const h = t.find((e) => e.name === "handoff_to_human");
    expect(h?.turnDelivered).toBeNull();
  });

  // A linha antiga, escrita antes desta entrega, não carrega o fato. Ela não pode virar "entregou"
  // por omissão: o rótulo que ela já tinha é o que ela continua tendo.
  test("uma linha sem o fato não afirma entrega nenhuma", async () => {
    await clearFlowLog(suDb, { tenantId });
    await linhaDeFerramenta("turno-antigo", "skip_reply");
    const skip = (await trilha()).find((e) => e.name === "skip_reply");
    expect(skip?.turnDelivered ?? false).toBe(false);
  });
});
