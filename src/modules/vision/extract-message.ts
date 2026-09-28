// A vision de UMA MENSAGEM: todos os anexos visuais dela, com o orçamento, a rotulagem e o agregado
// que o modelo vai ler. Serve à chegada (`runEagerMedia`, ../chatwoot/webhook.ts) e ao turno do
// re-engage, cujos anexos nunca passaram pela chegada e não têm meta.
//   - o ORÇAMENTO é de chamadas ao provedor: anexo que já carrega a extração é reaproveitado e NÃO
//     conta contra o teto;
//   - o que sobra do teto, e o que falhou, são NOMEADOS ao modelo por uma contagem: sem ela o
//     modelo responde como se a mensagem tivesse menos arquivos;
//   - o stash é UM agregado por mensagem, depois do laço (ver a nota lá).

import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { stashMediaAnnotation } from "@/modules/chatwoot/annotations";
import {
  onChatwootHost,
  oneByBlob,
  servedBy,
} from "@/modules/chatwoot/email-body-images";
import { chatwootBaseUrl } from "@/modules/chatwoot/instance";
import type { FlowContext } from "@/modules/flowlog/service";
import {
  BODY_IMAGE_IGNORED,
  classifyBodyImage,
  type ExtractInboundParams,
  extractBodyImage,
  readInboundFile,
} from "./service";
import type { VisionConfig } from "./settings";
import { isUnread, type UnreadFile } from "./unread";

// Quantos anexos de uma mensagem podem custar uma EXTRAÇÃO NOVA. Cobre o caso comum com folga; o
// teto existe para o cliente que anexa um álbum inteiro. O que sobra é reportado ao modelo, não
// descartado em silêncio.
export const VISION_MAX_ATTACHMENTS = 8;

// Quantas imagens do corpo de um e-mail podem ser BAIXADAS por mensagem, lidas ou só classificadas.
// Três tetos cobrem as fotos e os ornamentos que dividem o corpo com elas, e param o corpo forjado
// com milhares de URLs de blob.
export const BODY_IMAGE_MAX_DOWNLOADS = 3 * VISION_MAX_ATTACHMENTS;

// Um anexo visual (imagem ou documento) com o que já se sabe dele.
export interface VisualAttachment {
  // Null for an image Chatwoot's mailbox kept inside the email body: no attachment row.
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
  // Os não lidos que esta passagem tentou abrir, cada um com o nome e o motivo. Os que passaram do
  // teto não estão aqui: nunca foram tentados, e ficam só na contagem.
  unreadFiles: UnreadFile[];
  // Esta passagem percorreu as imagens do corpo do e-mail, mesmo que fossem todas ornamento.
  bodyRead: boolean;
}

// SE SOBROU ALGUMA COISA PARA ABRIR nesta mensagem. Exportada porque quem decide CHAMAR a extração
// (o turno, ../debounce/handler.ts) e quem decide cada anexo DENTRO dela precisam da mesma resposta:
// dois predicados separados escondem a mutação um do outro.
export function hasUnextractedVisual(visuals: VisualAttachment[]): boolean {
  return visuals.some((v) => !v.imageDescription && !v.extractedText);
}

// O rótulo que separa dois arquivos. Anexo único mantém o texto puro, sem rótulo.
function rotulado(nome: string | null, texto: string, total: number): string {
  if (total <= 1) return texto;
  return `[${nome ?? "anexo"}] ${texto}`;
}

// Imagem do corpo que não é deste Chatwoot sai ANTES do teto: senão ela ocuparia vaga, ou entraria na
// contagem de não lidos quando os anexos já esgotaram o teto. Sem conseguir ler o endereço
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
    const doHost = corpo
      .map((v) => ({ ...v, dataUrl: onChatwootHost(v.dataUrl, baseUrl) }))
      .filter((v) => servedBy(v.dataUrl, baseUrl));
    const um = new Set(oneByBlob(doHost.map((v) => v.dataUrl)));
    return doHost.filter((v) => um.delete(v.dataUrl));
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
  // Asked before each later batch of email body images: false stops the reading there.
  stillAllowed?: () => Promise<boolean>;
}): Promise<MessageVisuals | null> {
  const { visuals: todos, tenantId, instanceId, messageId } = params;
  if (todos.length === 0) return null;

  // NOTE: Anexos reais primeiro, com o teto. As imagens do corpo do e-mail vêm depois, em lotes do
  // que sobrou do teto: só se sabe que uma é ornamento depois de baixá-la, e ornamento não gasta
  // vaga, então cada lote devolve as vagas dos que foram ignorados ao lote seguinte.
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
      : readInboundFile({ ...comum, attachmentId: visual.id });
  };

  const ler = (visual: VisualAttachment) =>
    // NOTE: Já extraído numa passagem anterior (a recuperação de entrega repassa por aqui): reusa.
    // Reusar mantém o agregado COMPLETO, em vez de um mais pobre que a meta que ele sobrescreve.
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
            return { unread: "failed" } as const;
          })
          .then((r) => ({ nome: visual.name, r }));

  // EM PARALELO, porque o orçamento por arquivo é de 20s para imagem e 60s para documento: cinco
  // deles em série é um turno que ninguém espera, cinco de uma vez custam um.
  // Teto de downloads de imagem do corpo por mensagem, somando os dois laços abaixo: o teto de 8
  // limita o que vai ao provedor, não o que se baixa, e um corpo com mil URLs de blob faria mil
  // downloads. O que sobra sem ser olhado conta como não lido: não dá para chamar de ornamento.
  let orcamento = BODY_IMAGE_MAX_DOWNLOADS;
  const tirar = (n: number) => {
    const fatia = corpo.splice(0, Math.min(n, orcamento));
    orcamento -= fatia.length;
    return fatia;
  };
  let vagas = Math.max(0, VISION_MAX_ATTACHMENTS - novasExtracoes);
  let lote = tirar(vagas);
  const [dosAnexos, primeiroLote] = await Promise.all([
    Promise.all(visuais.map(ler)),
    Promise.all(lote.map(ler)),
  ]);
  const extraidos = [...dosAnexos, ...primeiroLote];
  vagas = primeiroLote.filter((e) => e.r === BODY_IMAGE_IGNORED).length;
  let parou = false;
  while (corpo.length > 0 && vagas > 0 && orcamento > 0) {
    if (params.stillAllowed && !(await params.stillAllowed())) {
      parou = true;
      break;
    }
    lote = tirar(vagas);
    const lidos = await Promise.all(lote.map(ler));
    extraidos.push(...lidos);
    vagas = lidos.filter((e) => e.r === BODY_IMAGE_IGNORED).length;
  }
  // O que passou do teto é baixado só para saber se é ornamento, sem ir ao provedor: um logotipo de
  // assinatura depois de oito fotos não é arquivo a pedir de novo.
  // Em lotes do tamanho do teto, porque cada download fica inteiro em memória.
  while (!parou && corpo.length > 0 && orcamento > 0) {
    const alemDoTeto = await Promise.all(
      tirar(VISION_MAX_ATTACHMENTS).map((visual) =>
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
  sobraram += corpo.length;

  const imagens: string[] = [];
  const documentos: string[] = [];
  const unreadFiles: UnreadFile[] = [];
  // NOTE: Ornamento do corpo do e-mail, ou imagem que não é deste Chatwoot: não foi enviada pelo
  // cliente, então não é lida, não rotula as outras e não entra na contagem de não lidos.
  const doCliente = extraidos.flatMap(({ nome, r }) =>
    r === BODY_IMAGE_IGNORED ? [] : [{ nome, r }],
  );
  for (const { nome, r } of doCliente) {
    // Arquivo que não deu para ler NÃO é arquivo que não foi enviado. Contado junto com os que
    // passaram do teto porque o movimento do modelo é o mesmo: nomear o que falta e pedir de novo.
    if (isUnread(r)) {
      unreadFiles.push({ name: nome, cause: r.unread });
      continue;
    }
    (r.kind === "image" ? imagens : documentos).push(
      rotulado(nome, r.text, doCliente.length),
    );
  }

  const naoLidos = sobraram + unreadFiles.length;
  const descricao = imagens.length > 0 ? imagens.join("\n\n") : null;
  const documento = documentos.length > 0 ? documentos.join("\n\n") : null;

  // NOTE: UM agregado por mensagem, depois do laço. Cada `extractInboundFile` stasharia o seu sob a
  // MESMA chave de mensagem e a loja mescla campo a campo, então N extrações em paralelo deixariam
  // só a que terminou por último; e no Chatwoot upstream, onde a rota de write-back da meta não
  // existe, essa loja é o ÚNICO leitor do flush do debounce.
  const leuCorpo = todos.some((v) => v.id === null);
  if (descricao || documento || naoLidos > 0 || leuCorpo)
    stashMediaAnnotation(
      { tenantId, instanceId, messageId },
      {
        ...(descricao ? { imageDescription: descricao } : {}),
        ...(documento ? { extractedText: documento } : {}),
        // NOTE: SEMPRE, inclusive zero. A loja mescla campo a campo: omitir o campo na passagem que
        // leu tudo deixaria de pé a contagem positiva anterior ao lado da extração completa.
        attachmentsUnread: naoLidos,
        unreadFiles,
        ...(leuCorpo ? { bodyRead: true } : {}),
      },
    );

  return {
    imageDescription: descricao,
    extractedText: documento,
    attachmentsUnread: naoLidos,
    unreadFiles,
    bodyRead: leuCorpo,
  };
}
