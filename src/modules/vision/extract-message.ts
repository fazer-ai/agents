// A vision de UMA MENSAGEM: todos os anexos visuais dela, com o orçamento, a rotulagem e o
// agregado que o modelo vai ler.
//
// Isto era o miolo de `runEagerMedia` (../chatwoot/webhook.ts) e saiu de lá quando um SEGUNDO
// chamador apareceu (issue #757): o turno do re-engage, que relê uma thread cujos anexos nunca
// passaram pelo caminho de chegada e por isso não têm meta nenhuma. Cada regra aqui foi paga por
// uma rodada de review da #691/#692, e duas cópias delas divergiriam na primeira correção:
//
//   - o ORÇAMENTO é de chamadas ao provedor, não de quanto da mensagem se lê: anexo que já carrega
//     a extração é reaproveitado sem custo e NÃO conta contra o teto. Cortar antes dessa distinção
//     jogava fora resultado em mãos e ainda o contava como não lido;
//   - o que sobra do teto, e o que falhou, são NOMEADOS ao modelo por uma contagem: um modelo a
//     quem não se diz nada responde como se a mensagem tivesse menos arquivos;
//   - a rotulagem por nome de arquivo só aparece quando há mais de um, para o caso comum continuar
//     byte a byte o que era;
//   - o stash é UM agregado por mensagem, depois do laço: a loja é chaveada por mensagem e mescla
//     campo a campo, então N extrações em paralelo stashando cada uma deixariam só a última.

import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { stashMediaAnnotation } from "@/modules/chatwoot/annotations";
import { onChatwootHost, servedBy } from "@/modules/chatwoot/email-body-images";
import { chatwootBaseUrl } from "@/modules/chatwoot/instance";
import type { FlowContext } from "@/modules/flowlog/service";
import {
  BODY_IMAGE_IGNORED,
  classifyBodyImage,
  type ExtractInboundParams,
  extractBodyImage,
  extractInboundFile,
} from "./service";
import type { VisionConfig } from "./settings";

// Quantos anexos de uma mensagem podem custar uma EXTRAÇÃO NOVA. A média medida numa caixa de
// produção é 1,98 por conversa, então isto cobre o tráfego real com folga; a cauda é o cliente que
// anexa um álbum inteiro (70 na mesma medição), e ali o teto é justamente o ponto. O que sobra é
// reportado ao modelo, não descartado em silêncio.
export const VISION_MAX_ATTACHMENTS = 8;

// Um anexo visual (imagem ou documento) com o que já se sabe dele.
export interface VisualAttachment {
  // Null for an image Chatwoot's mailbox kept inside the email body (#864): no attachment row.
  id: number | null;
  dataUrl: string;
  name: string | null;
  // O que uma passagem anterior já extraiu DESTE anexo, quando o write-back da meta chegou.
  imageDescription: string | null;
  extractedText: string | null;
}

export interface MessageVisuals {
  imageDescription: string | null;
  extractedText: string | null;
  // Anexos que esta passagem não abriu: os que passaram do teto mais os que falharam.
  attachmentsUnread: number;
  // Esta passagem percorreu as imagens do corpo do e-mail (#864), mesmo que fossem todas ornamento.
  bodyRead: boolean;
}

// SE SOBROU ALGUMA COISA PARA ABRIR nesta mensagem. Uma pergunta só, e exportada, porque quem
// decide CHAMAR a extração (o turno, ../debounce/handler.ts) e quem decide o que fazer com cada
// anexo DENTRO dela são dois lugares, e os dois precisam da mesma resposta. Enquanto eram dois
// predicados escritos separados, cada um segurava o erro do outro: mutar qualquer um deles não
// mudava nada observável, porque o outro já tinha filtrado o caso — duas cercas para a mesma regra,
// e nenhuma bateria de mutação consegue distingui-las.
export function hasUnextractedVisual(visuals: VisualAttachment[]): boolean {
  return visuals.some((v) => !v.imageDescription && !v.extractedText);
}

// O rótulo que separa dois arquivos. Anexo único mantém o texto puro, byte a byte, para o caso
// comum ler exatamente como lia antes desta mudança.
function rotulado(nome: string | null, texto: string, total: number): string {
  if (total <= 1) return texto;
  return `[${nome ?? "anexo"}] ${texto}`;
}

// Imagem do corpo que não é deste Chatwoot sai ANTES do teto: senão ela ocuparia vaga, ou entraria na
// contagem de não lidos quando os anexos já esgotaram o teto (#864). Sem conseguir ler o endereço
// da instância, nenhuma imagem do corpo é lida: ler uma remota é pior do que não ler uma do cliente.
async function doProprioChatwoot(
  corpo: VisualAttachment[],
  params: { tenantId: bigint; instanceId: bigint; base: PrismaClient },
): Promise<VisualAttachment[]> {
  if (corpo.length === 0) return corpo;
  try {
    const baseUrl = await chatwootBaseUrl(
      params.tenantId,
      params.instanceId,
      params.base,
    );
    return corpo
      .map((v) => ({ ...v, dataUrl: onChatwootHost(v.dataUrl, baseUrl) }))
      .filter((v) => servedBy(v.dataUrl, baseUrl));
  } catch (err) {
    logger.warn(
      "vision: body images skipped, the instance base URL was not read: %s",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

export async function extractMessageVisuals(params: {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  messageId: number;
  visuals: VisualAttachment[];
  cfg: VisionConfig;
  base: PrismaClient;
  flow?: FlowContext;
  deps?: ExtractInboundParams["deps"];
  // Como esta conversa aparece no log, para a linha de aviso dizer onde foi.
  convLabel?: string;
}): Promise<MessageVisuals | null> {
  const { visuals: todos, tenantId, instanceId, messageId } = params;
  if (todos.length === 0) return null;

  // Anexos reais primeiro, com o teto como sempre. As imagens do corpo do e-mail (#864) vêm depois,
  // em lotes do que sobrou do teto: só se sabe que uma é ornamento depois de baixá-la, e ornamento
  // não gasta vaga, então cada lote devolve as vagas dos que foram ignorados ao lote seguinte.
  const anexos = todos.filter((v) => v.id !== null);
  const corpo = await doProprioChatwoot(
    todos.filter((v) => v.id === null),
    params,
  );
  let novasExtracoes = 0;
  const visuais = anexos.filter((v) =>
    hasUnextractedVisual([v])
      ? novasExtracoes++ < VISION_MAX_ATTACHMENTS
      : true,
  );
  let sobraram = anexos.length - visuais.length;

  const extrair = (visual: VisualAttachment) => {
    const comum = {
      tenantId,
      instanceId,
      conversationId: params.conversationId,
      messageId,
      dataUrl: visual.dataUrl,
      cfg: params.cfg,
      base: params.base,
      flow: params.flow,
      deps: params.deps,
      // O agregado é stashado uma vez depois do laço; ver a nota lá embaixo.
      stashAnnotation: false,
    };
    return visual.id === null
      ? extractBodyImage(comum)
      : extractInboundFile({ ...comum, attachmentId: visual.id });
  };

  const ler = (visual: VisualAttachment) =>
    // Já extraído numa passagem anterior (a recuperação de entrega repassa por aqui): reusa.
    // Mais barato, e é o que mantém o agregado COMPLETO — uma repassagem parcial publicava um
    // agregado mais pobre do que a metadata que ela depois sobrescrevia.
    !hasUnextractedVisual([visual])
      ? Promise.resolve({
          nome: visual.name,
          r: visual.imageDescription
            ? ({ kind: "image", text: visual.imageDescription } as const)
            : ({
                kind: "document",
                text: visual.extractedText ?? "",
              } as const),
        })
      : extrair(visual)
          // Um arquivo ilegível não pode custar os outros: a extração é best-effort por anexo.
          .catch((err) => {
            logger.warn(
              "vision failed for attachment %s (conv=%s): %s",
              visual.id,
              params.convLabel ?? String(params.conversationId),
              err instanceof Error ? err.message : String(err),
            );
            return null;
          })
          .then((r) => ({ nome: visual.name, r }));

  // EM PARALELO, porque o orçamento por arquivo é de 20s para imagem e 60s para documento: cinco
  // deles em série é um turno que ninguém espera, cinco de uma vez custam um.
  let vagas = Math.max(0, VISION_MAX_ATTACHMENTS - novasExtracoes);
  let lote = corpo.splice(0, vagas);
  const [dosAnexos, primeiroLote] = await Promise.all([
    Promise.all(visuais.map(ler)),
    Promise.all(lote.map(ler)),
  ]);
  const extraidos = [...dosAnexos, ...primeiroLote];
  vagas = primeiroLote.filter((e) => e.r === BODY_IMAGE_IGNORED).length;
  while (corpo.length > 0 && vagas > 0) {
    lote = corpo.splice(0, vagas);
    const lidos = await Promise.all(lote.map(ler));
    extraidos.push(...lidos);
    vagas = lidos.filter((e) => e.r === BODY_IMAGE_IGNORED).length;
  }
  // O que passou do teto é baixado só para saber se é ornamento, sem ir ao provedor: um logotipo de
  // assinatura depois de oito fotos não é arquivo a pedir de novo.
  // Em lotes do tamanho do teto, porque cada download fica inteiro em memória.
  while (corpo.length > 0) {
    const alemDoTeto = await Promise.all(
      corpo.splice(0, VISION_MAX_ATTACHMENTS).map((visual) =>
        classifyBodyImage({
          tenantId,
          instanceId,
          conversationId: params.conversationId,
          messageId,
          dataUrl: visual.dataUrl,
          cfg: params.cfg,
          base: params.base,
          flow: params.flow,
          deps: params.deps,
          stashAnnotation: false,
        }).catch(() => null),
      ),
    );
    sobraram += alemDoTeto.filter((r) => r !== BODY_IMAGE_IGNORED).length;
  }

  const imagens: string[] = [];
  const documentos: string[] = [];
  let falharam = 0;
  // Ornamento do corpo do e-mail, ou imagem que não é deste Chatwoot: não foi enviada pelo cliente,
  // então não é lida, não rotula as outras e não entra na contagem de não lidos (#864).
  const doCliente = extraidos.flatMap(({ nome, r }) =>
    r === BODY_IMAGE_IGNORED ? [] : [{ nome, r }],
  );
  for (const { nome, r } of doCliente) {
    // Arquivo que não deu para ler NÃO é arquivo que não foi enviado. Contado junto com os que
    // passaram do teto porque o movimento do modelo é o mesmo: nomear o que falta e pedir de novo.
    if (!r) {
      falharam++;
      continue;
    }
    (r.kind === "image" ? imagens : documentos).push(
      rotulado(nome, r.text, doCliente.length),
    );
  }

  const naoLidos = sobraram + falharam;
  const descricao = imagens.length > 0 ? imagens.join("\n\n") : null;
  const documento = documentos.length > 0 ? documentos.join("\n\n") : null;

  // UM agregado por mensagem, depois do laço. Cada `extractInboundFile` stasharia o seu sob a MESMA
  // chave de mensagem e a loja mescla campo a campo, então N extrações em paralelo deixariam só a
  // que terminou por último — e no Chatwoot upstream, onde a rota de write-back da meta não existe,
  // essa loja é o ÚNICO leitor do flush do debounce.
  const leuCorpo = todos.some((v) => v.id === null);
  if (descricao || documento || naoLidos > 0 || leuCorpo)
    stashMediaAnnotation(
      { tenantId, instanceId, messageId },
      {
        ...(descricao ? { imageDescription: descricao } : {}),
        ...(documento ? { extractedText: documento } : {}),
        // SEMPRE, inclusive zero. A loja mescla campo a campo, então omitir na passagem que
        // finalmente leu tudo deixava de pé a contagem positiva anterior, e o flush renderizava
        // "N arquivos não lidos" ao lado da extração completa.
        attachmentsUnread: naoLidos,
        ...(leuCorpo ? { bodyRead: true } : {}),
      },
    );

  return {
    imageDescription: descricao,
    extractedText: documento,
    attachmentsUnread: naoLidos,
    bodyRead: leuCorpo,
  };
}
