# 10: Validar E2E

## Pré-condições

- Agente importado e habilitado (`enabled:true`), **em test mode** (`mode:test`, como importado; a validação abaixo roda nesse modo via `/teste`; promover pra produção é decisão do usuário, etapa 8), modelo religado a uma vault key real (etapa 8).
- KB com docs **READY** (etapa 8).
- Inbox do Chatwoot bound ao agente, bot `active` (etapa 9).
- Langfuse com ingestion **207** + wired no fazer.ai agents (etapas 5 e 8).

## 1. Playground (modelo real, sem Chatwoot)

Via MCP (preferido): `agent_playground` (mcp:read; aceita texto ou `attachment` base64/url, e `reply_with_audio`). Via REST: `POST /api/v1/agents/:id/playground`. O agente responde com o modelo real. Cheque **grounding**: pergunte algo coberto pela KB e confirme que a resposta usa o conteúdo indexado (não uma resposta genérica).

## 2. Integração Chatwoot → agents via Inbox API (OBRIGATÓRIO, sem aparelho)

**Este é o teste que NÃO pode ficar pendente:** é a prova de aceite obrigatória de bind + webhook + turn. O WhatsApp físico (2b) é opcional. O agente segue em test mode depois disto; **não** promova pra produção (decisão do usuário, etapa 8).

Checklist objetivo (todos marcados = provado):
- [ ] inbox `Channel::Api` criada **e** bound ao agente (`inbox_bind`, etapa 9; bot `active`)
- [ ] conversa criada **e** test mode ativado nela (`/teste`)
- [ ] mensagem real injetada (incoming, `message_type: incoming`)
- [ ] resposta **outgoing** observada na conversa
- [ ] trace no Langfuse

Como fazer, provando a ponta `incoming → webhook → turn → reply` **sem aparelho**, com um inbox `Channel::Api`:
- Crie um inbox `Channel::Api` no Chatwoot e benda ao agente (`inbox_bind`, etapa 9), que auto-provisiona o Agent Bot + webhook.
- Crie uma conversa e **ative o test mode nela**: injete uma mensagem **incoming** com o conteúdo exatamente `/teste`. Em test mode o agente fica em silêncio numa conversa até receber `/teste` (e deixa uma nota privada explicando o porquê); o `/teste` libera as respostas **só nessa conversa**. Sem ele a mensagem chega e espelha, mas o agente **não** responde: é o comportamento correto do test mode, não uma falha.
- Agora injete a **mensagem real** de teste (incoming, `message_type: incoming`) na mesma conversa. **Monte o JSON da mensagem num arquivo UTF-8** e POSTe apontando pro arquivo (`curl --data @msg.json` ou helper): texto com acento montado inline no PowerShell volta corrompido (`Olá`→`Ol?`), ver `gotchas.md`.
- Cadeia esperada: incoming → webhook (`/api/v1/chatwoot/webhook/:routeToken`) → **debounce** → turn → modelo real → resposta **outgoing** na conversa. Confirme a resposta + o `ExecutionLog`/trace no Langfuse.

## 2b. WhatsApp real (opcional, confirma o transporte)

Pareie a inbox real com um número que o usuário controle e mande uma mensagem: mesma cadeia do passo 2, exercitando o transporte WhatsApp de verdade. Pode ficar pendente sem invalidar o core (a integração já foi provada no 2).

**O pareamento muda com o provider, e o número exigido também:**

- **WhatsApp (nativo):** crie a inbox em **Configurações > Caixas de entrada > Adicionar > WhatsApp > WhatsApp (nativo)** e pareie pelo QR na tela, lido pelo app do WhatsApp do número, ou pelo código digitado no celular. É o caminho curto pra confirmar o transporte, e roda dentro do `sidekiq` do próprio Chatwoot (sem serviço de terceiros). Se a opção não aparecer, o Chatwoot é anterior à `v4.18.0-fazer-ai.124` ou foi subido com `WHATSAPP_CONNECTOR_ENABLED=false`.
- **API oficial (Cloud API):** não tem QR. O número é verificado na Meta e **não pode estar ativo no app do WhatsApp**, então raramente é o celular pessoal do usuário: provisionar isso no meio do onboarding costuma travar a etapa. O passo a passo gratuito da comunidade cobre da criação do app na Meta até a inbox no Chatwoot: [WhatsApp com API Oficial no Chatwoot (fluxo manual)](https://www.lucasmoreira.ai/c/conteudos-exclusivos/whatsapp-com-api-oficial-no-chatwoot-fluxo-manual-9ae92651-f21b-40dc-a7b1-2ff7d680e0e5?utm_source=agents&utm_medium=skill&utm_campaign=agents-onboarding). Se o usuário for por aí, trate como trilha paralela e **não** segure o aceite: o passo 2 já provou a integração.

## 3. Traces no Langfuse

- Confirme que o turn aparece no Langfuse (env `production-playground` ou `production`, session = threadId do fazer.ai agents). A ingestion já foi validada em 207 na etapa 5.

## 4. Kanban / assinatura Pro (OBRIGATÓRIO quando o tier é Pro)

Só se aplica ao **Chatwoot Pro com licença** (etapa 9b); em OSS/community pule (não há Kanban). **Imagem Pro não basta, e assinatura ativa também não:** o Kanban depende de três coisas (imagem + assinatura casada + feature ligada na conta). Valide o **estado-fim real na conta**, não que o sync rodou:

- Rode `chatwoot-admin.py enable-kanban` (etapa 9b, passo 5) e confirme `kanban_feature_enabled: true`. Esse é o sinal autoritativo: o comando liga a feature na conta E, pela validação do próprio Chatwoot, **só passa se a assinatura casar** (senão sai com `kanban_feature_not_available`). Idempotente, então rodar de novo na validação é seguro.
- Confirmação visual do mesmo estado: `/super_admin/settings` → "fazer.ai Subscription" ativa, board de Kanban visível no Chatwoot.
- `kanban_feature_enabled: false` (ou o comando saiu com erro) → a etapa 9b **não** fechou: leia o `enable_error` e volte pra `chatwoot-hub-register.md` (`kanban_feature_not_available` = instância/licença não casou, quase sempre por ter criado a instância com o host em vez do **UUID**; confira o casamento por UUID nos passos 1 a 4). Resolva antes de declarar o onboarding concluído. **Não** aceite "o Refresh rodou / `VERIFIED_AT` está preenchido" como prova: um 403/inativo do hub grava `VERIFIED_AT` e mesmo assim deixa o Kanban travado.

## Critério de aceite

Responde no **playground** (com **KB grounding** confirmado) E na **integração via Inbox API** (conversa ativada com `/teste`, em test mode); **trace** no Langfuse. O **WhatsApp físico** é confirmação opcional (a integração já foi provada via Inbox API). **Kanban (tier Pro):** `enable-kanban` retorna `kanban_feature_enabled: true` (feature ligada na conta E assinatura casada) ou o board fica visível no Chatwoot, **não só a licença atachada nem só o Refresh verde**: imagem Pro + assinatura ativa mas feature desligada na conta = Kanban travado. Em OSS/community não há Kanban (nada a validar aqui).
