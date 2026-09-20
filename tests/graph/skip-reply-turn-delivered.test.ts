import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Serialized } from "@langchain/core/load/serializable";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { ToolFlowLogger } from "@/graph/tool-flowlog";
import type { FlowContext } from "@/modules/flowlog/service";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

// ── QUEM SABE SE O TURNO FALOU É O TURNO, E ELE TEM QUE DEIXAR ISSO ESCRITO (issue #726) ──
//
// O rótulo do marcador de `skip_reply` precisa de um fato que só o turno conhece: se alguma coisa foi
// posta na frente do cliente antes dele. A tela não tem como reconstruir isso, porque nem o nome da
// ferramenta nem os argumentos gravados respondem (`handoff_to_human` com `customerMessage` vazio é
// uma transferência que não falou, e os argumentos são reduzidos a forma por padrão).
//
// Então o fato nasce onde ele é conhecido, no momento em que a linha é escrita, e um leitor do turno
// é o que o carrega até aqui. Ele é lido no fim da chamada, e não no começo: o começo de `skip_reply`
// é concorrente com a companheira quando as duas vêm no mesmo lote.
//
// E ele só se aplica a `skip_reply`. Nenhuma outra ferramenta faz uma afirmação sobre o silêncio do
// turno, então carimbar todas seria inventar uma coluna que ninguém lê.

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

const TOOL = {} as Serialized;

function flowCtx(turnId: string): FlowContext {
  return { tenantId, turnId, source: "inbox", base: appDb };
}

// Roda uma chamada de ferramenta inteira pelo logger e devolve o `detail` da linha que ela escreveu.
async function rodar(
  tool: string,
  opts: { turnDelivered?: () => boolean } = {},
): Promise<Record<string, unknown>> {
  const turnId = crypto.randomUUID();
  const logger = new ToolFlowLogger(flowCtx(turnId), opts);
  logger.handleToolStart(
    TOOL,
    "{}",
    "run-1",
    undefined,
    undefined,
    undefined,
    tool,
  );
  logger.handleToolEnd({ content: "ok" }, "run-1");
  const rows = await flowLogRows(suDb, {
    where: { tenantId, turnId, stage: "tool" },
    select: { detail: true },
  });
  expect(rows).toHaveLength(1);
  return (rows[0]?.detail ?? {}) as Record<string, unknown>;
}

describe.skipIf(!dbUp)(
  "a linha de skip_reply carrega se o turno entregou",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "SKIPTD", slug: `skiptd-${process.pid}` },
      });
      tenantId = t.id;
    });

    afterAll(async () => {
      if (tenantId) {
        await clearFlowLog(suDb, { tenantId });
        await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}`;
      }
      await su?.$disconnect();
      await app?.$disconnect();
    });

    // O INSTRUMENTO, antes de qualquer veredito: sem leitor nenhum o logger continua escrevendo a linha
    // com o nome da ferramenta. Se isto falhar, "o campo não veio" não diz nada sobre o campo.
    test("o instrumento: a linha de ferramenta continua sendo escrita, com o nome", async () => {
      const detail = await rodar("skip_reply");
      expect(detail.tool).toBe("skip_reply");
    });

    test("turno que já entregou: a linha de skip_reply diz que entregou", async () => {
      const detail = await rodar("skip_reply", { turnDelivered: () => true });
      expect(detail.turnDelivered).toBe(true);
    });

    test("turno mudo: a linha de skip_reply diz que não entregou", async () => {
      const detail = await rodar("skip_reply", { turnDelivered: () => false });
      expect(detail.turnDelivered).toBe(false);
    });

    // O leitor é do TURNO, mas a afirmação é da ferramenta do silêncio. Carimbar as outras seria
    // afirmar uma coisa que o rótulo delas não usa.
    test("nenhuma outra ferramenta recebe o carimbo", async () => {
      const detail = await rodar("handoff_to_human", {
        turnDelivered: () => true,
      });
      expect(detail.tool).toBe("handoff_to_human");
      expect("turnDelivered" in detail).toBe(false);
    });

    // Sem leitor (playground, nudge, qualquer caminho que monte o logger sem o turno), a linha não
    // afirma nada: ausente é diferente de `false`, e a tela trata ausente como "não sei", que é o
    // rótulo que a linha já tinha.
    test("sem leitor, a linha não afirma nada sobre entrega", async () => {
      const detail = await rodar("skip_reply");
      expect("turnDelivered" in detail).toBe(false);
    });

    // O leitor é chamado no FIM da chamada. Quando `skip_reply` vem no mesmo lote da companheira, o
    // começo dela é concorrente com a entrega, e ler ali responderia pela corrida.
    test("o leitor é consultado no fim da chamada, não no começo", async () => {
      const turnId = crypto.randomUUID();
      let entregou = false;
      const logger = new ToolFlowLogger(flowCtx(turnId), {
        turnDelivered: () => entregou,
      });
      logger.handleToolStart(
        TOOL,
        "{}",
        "run-2",
        undefined,
        undefined,
        undefined,
        "skip_reply",
      );
      entregou = true; // a companheira terminou enquanto o skip_reply rodava
      logger.handleToolEnd({ content: "ok" }, "run-2");
      const rows = await flowLogRows(suDb, {
        where: { tenantId, turnId, stage: "tool" },
        select: { detail: true },
      });
      const detail = (rows[0]?.detail ?? {}) as Record<string, unknown>;
      expect(detail.turnDelivered).toBe(true);
    });
  },
);
