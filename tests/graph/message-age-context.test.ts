import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { loadAgentConfig } from "@/graph/prepare";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { seedChatwootInstance } from "../utils/chatwoot";

// A IDADE DA MENSAGEM QUE DISPAROU O TURNO, do instante que o caminho tem em mãos até o prompt que o
// modelo recebe (issue #749). O agente responde um e-mail de dez dias como se ele tivesse acabado de
// chegar porque NADA no prompt responde "quando o cliente escreveu": `get_current_time` e
// `{{hora_atual}}` respondem que dia é hoje, e o histórico é texto puro, sem carimbo por mensagem.
//
// O que este arquivo prova é a costura inteira, e não a redação: o valor tem que chegar ao prompt a
// partir do INSTANTE DA MENSAGEM, nunca da coluna `last_inbound_at` do espelho — que é nula
// exatamente na conversa que motivou a issue, a religada cujo espelho nasceu de uma troca de status.
// A tabela de redação (minutos, horas, dias) fica no unitário, em tests/graph/prompt.test.ts.

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
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

const CONV_ID = 88_749;
const PROMPT = "Idade: {{idade_ultima_mensagem}}";
let tenantId = 0n;
let instanceId = 0n;
let agentId = 0n;

const ctx = (t: bigint): TenantContext => ({
  tenantId: t,
  userId: null,
  role: "TENANT_ADMIN",
});

// `promptNow` é a simulação de tempo do próprio produto (a do playground), e o único ponto de
// injeção que este caminho tem: sem ela a asserção mediria o relógio da máquina de teste.
const load = (lastIncomingAt: Date | null, promptNow: string) =>
  runScopedOn(appDb, ctx(tenantId), (db) =>
    loadAgentConfig(
      db,
      {
        tenantId,
        instanceId,
        conversationId: CONV_ID,
        agentId,
        threadId: `${tenantId}:${instanceId}:${CONV_ID}`,
        lastIncomingAt,
      },
      { overrides: { promptNow } },
    ),
  );

describe.skipIf(!dbUp)("a idade da mensagem no prompt do sistema", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "MA", slug: `ma-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 1,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const keyId = (
      await suDb.vaultEntry.create({
        data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
        select: { id: true },
      })
    ).id;
    agentId = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Idade",
          systemPrompt: PROMPT,
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: `vault:${keyId}`,
          },
        },
      })
    ).id;
    const contact = await suDb.contact.create({
      data: {
        chatwootInstanceId: instanceId,
        tenantId,
        chatwootContactId: 4749,
        name: "Maria",
      },
    });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: CONV_ID,
        contactId: contact.id,
        status: "pending",
        threadId: `${tenantId}:${instanceId}:${CONV_ID}`,
        // NULA, que é o estado da conversa religada: o espelho dela nasceu de uma troca de status, e
        // nenhuma mensagem passou por ele. Qualquer solução que leia esta coluna sai vazia AQUI.
        lastInboundAt: null,
      },
    });
  });

  afterAll(async () => {
    if (dbUp && tenantId) {
      await suDb.tenant.delete({ where: { id: tenantId } });
    }
    await app?.$disconnect();
    await su?.$disconnect();
  });

  test("a conversa religada, sem carimbo de entrada no espelho, ainda diz a idade", async () => {
    const cfg = await load(
      new Date("2026-08-10T14:00:00-03:00"),
      "2026-08-20T14:00",
    );
    expect(cfg?.systemPrompt).toBe("Idade: há 10 dias");
    // E a coluna do espelho continua nula: é o que prova que a fonte não foi ela.
    const row = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: CONV_ID },
      select: { lastInboundAt: true },
    });
    expect(row.lastInboundAt).toBeNull();
  });

  test("mensagem nova é datada como nova, e não vira 'há 0 dias'", async () => {
    const cfg = await load(
      new Date("2026-08-20T13:48:00-03:00"),
      "2026-08-20T14:00",
    );
    expect(cfg?.systemPrompt).toBe("Idade: há 12 minutos");
  });

  // O caminho que NÃO tem instante nenhum (compactação de memória, observador, playground): o
  // placeholder não pode virar frase inventada nem apagar o resto do prompt do operador.
  test("sem instante em mãos, o placeholder não inventa idade", async () => {
    const cfg = await load(null, "2026-08-20T14:00");
    expect(cfg?.systemPrompt).toBe("Idade: ");
  });
});
