# 02: Reproduzir (no playground, sem tocar a conversa real)

Antes de mexer em qualquer config, reproduza o comportamento de forma isolada. O **playground** roda o **mesmo** modelo + system prompt + tools (knowledge/HTTP/MCP/integração) que produção, mas **sem** Chatwoot, webhook, debounce ou auto-reply: nada vaza para a conversa do cliente.

## Como rodar

- **Console:** editor do agente → aba **Playground**. Chat panel (Enter envia, Reset reinicia). Cada resposta expande em `trace` (tool calls/resultados) + `sources` (grounding da KB).
- **MCP:** `agent_playground` (`mcp:read`; args `agent_id`, `message`, `thread_id?`) → `{ reply, threadId, trace, sources }`.
- **REST:** `POST /api/v1/agents/:id/playground { message, threadId? }` (TENANT_ADMIN).

O `enabled` do agente é ignorado no playground (você testa antes de ligar). Os toggles por-feature (`stt.enabled`/`vision.enabled`) são respeitados; resposta em áudio é um toggle manual (`forceAudio`).

## Reconstituir o turno

Mande a mesma mensagem (ou a sequência) que disparou o problema. Para multimodal, o playground aceita `attachment` (base64/url). Use o `trace` + `sources` para ver se o agente chamou a tool certa, fez grounding na KB certa, e por que respondeu o que respondeu.

## Limites a ter em mente

- **Não é simulação pura:** as tools de HTTP/MCP/integração do agente **executam de verdade** (uma write tool escreve; um agendamento cria o evento real na agenda). Se o agente tem tool que muda estado externo, reproduzir pode causar efeito colateral real. Avalie antes. O que **não** roda de verdade, e o `trace` marca como simulado ou mockado:
  - as ferramentas nativas **de conversa** (etiqueta, atributo, nota privada, transferir, resolver, mover card);
  - as ferramentas de **documento** (gerar e emitir documento a partir de template): o playground devolve uma resposta simulada sem emitir nem renderizar nada. Para validar a geração de documento (ou confirmar que uma falha nela foi corrigida), use uma conversa de teste controlada (`04-validate-and-apply.md`), não o playground;
  - as ferramentas que o operador mockou no próprio teste (o mock tem precedência).
- Se acabou de editar uma ferramenta, salve antes de testar: o playground usa a configuração salva.
- Sem mirror/conversa, as vars de contato/prompt vêm vazias (`instanceId`/`conversationId` dummy). Comportamento que depende de dados da conversa real (nome do contato, atributos, histórico daquela conversa) não reproduz idêntico aqui: o playground isola o **agente**, não o **estado da conversa**.
- A thread do playground é **fenced** (`tenant:playground:agentId:uuid`): um `threadId` só é aceito se casar essa forma exata; qualquer outra (ex.: a thread de uma conversa real) é rejeitada. Não dá para "abrir" a conversa do cliente pelo playground.
- Memória multi-turno: o cliente segura o `threadId` retornado entre turnos; Reset começa nova sessão.

## Testar no número real: modo teste

O playground isola o agente; para testar a ponta real (o canal, o Chatwoot) sem atender cliente nenhum, use o **modo teste** do agente (é o modo de um agente recém-criado). Nele, o agente fica quieto em todas as conversas e deixa uma nota privada avisando; o contato de teste manda `/teste` na conversa dele para liberar só aquela conversa, e `/reset` para apagar a memória e recomeçar. Teste as conversas que espera receber (cada turno custa) e só então passe o agente para **produção**. Comandos só valem em modo teste: em produção, `/teste` é texto comum do cliente.

