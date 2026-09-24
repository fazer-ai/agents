# Gotchas: armadilhas de diagnóstico em produção

Cada uma é uma armadilha real (extraída dos docs de subsistema). Leia antes de concluir.

## Leitura / DB

### Query crua no DB sem tenant context retorna ZERO linhas (não "não existe")

O `DATABASE_URL` é a role runtime (não-superuser) e o RLS está ativo. Um `SELECT` em tabela tenant-scoped (ex.: `agents`) **sem** contexto de tenant retorna **zero linhas** em silêncio: a linha existe, o RLS está filtrando. **Não conclua que o registro sumiu.** Para diagnóstico cross-tenant, conecte como superuser via `MIGRATION_DATABASE_URL` (bypassa RLS, **read-only**, nunca mutar prod) ou `SET app.tenant_id = '<id>';` na sessão antes do `SELECT`.

### Transcrição de áudio vive só no Chatwoot, não no nosso DB

A transcrição do STT é escrita de volta no **meta do attachment no Chatwoot** (`transcribed_text`), nunca espelhada no nosso DB (regra anti-PII: não espelhamos corpo de mensagem). Procurar o texto da transcrição no DB do fazer.ai agents não acha nada. Idem para o corpo das mensagens: a thread é lida ao vivo do Chatwoot, sem mirror.

### O ExecutionLog não tem o texto da mensagem

`detail` é só ids/contagens/enums (PII-free, passa por redação); `errorMessage` é sanitizado. Você vê **qual** estágio falhou e **por quê** (enum/erro), não o conteúdo. Para o texto/raciocínio, vá ao **Langfuse** (session = threadId por-conversa).

## Flowlog / estágios

### `embed` não é emitido separado: a falha de embedding aparece em `generate`

`embed` está no vocabulário mas **não está wired** ainda. A busca RAG roda **dentro** do span `generate`, então um erro de embedding/grounding surge como erro de `generate`, não numa linha `embed`. Não espere uma linha `embed` no `/logs`.

### STT é eager e tem `turnId` próprio

O STT roda **antes** do turno (na chegada da mensagem), então tem um `turnId` separado do turno que responde. No `/logs`, correlacione STT ao turno pelo **`threadId`/`conversationId`**, não pelo `turnId`.

### `source` separa inbox de playground

`GET /v1/logs` filtra por `source` (default `inbox`). Erros do **playground** ficam em `source=playground` e **não** disparam alerta (só `inbox` paga alerta). Se você reproduziu no playground e não vê no feed padrão, troque o filtro `source`.

## Memória do agente (checkpointer)

### Duas chaves diferentes: memória (por contato+canal) vs correlação (por conversa)

A memória do grafo é por **contato+canal** (`tenant:instance:ci:<contactInboxId>`): abrange as conversas daquele contato **naquele canal**, então uma conversa nova reusa o histórico anterior, e canais diferentes do mesmo contato têm memórias **separadas**. Debounce, flowlog e a **session do Langfuse** usam a chave **por-conversa** (`tenant:instance:display_id`). "O agente lembrou de algo de outra conversa" pode ser memória de canal reusada (esperado), não bug.

## Behavior (config do agente)

### Sintomas que são config, não bug de código

- Respondeu **balão-a-balão** (uma resposta por mensagem) → **debounce off**.
- Não respondeu fora de horário / mandou template ou nota num envio proativo → **service-window**/business-hours (a janela de 24h só governa **proativo**; resposta reativa é sempre in-window).
- Não respondeu em áudio → **tts.mode** (`never` por padrão) ou credencial TTS faltando.
- Áudio chegou **quebrado** (embolado, zumbindo, com trecho mudo) → primeiro o detector de áudio: ver a seção abaixo.
- Áudio recebido virou "peça texto" → **stt** desabilitado ou sem credencial.
- Não usou a base → grant **RAG** ausente/vazio (fail-closed) ou embedding do tenant não configurado.

### Embedding é por-tenant (não por-KB nem do modelo do agente)

Sem o embedding configurado no nível do **tenant** (`tenant_settings`), os docs da KB vão para FAILED e o grounding falha. É config de tenant, separada da chave do modelo do agente. Reindexar a base não recupera docs já FAILED: use o **retry por documento** (MCP `knowledge_document_retry`).

### Áudio embolado, zumbido ou trecho mudo: comece pelo detector

A síntese às vezes volta quebrada com o texto certo, e o envio não percebe. Antes de trocar provedor, voz ou modelo, leia a linha do estágio `tts_check` (**Audio check** / **Verificação do áudio** no `/logs`) do turno do relato:

- `outcome`: `passed` (o detector ouviu e aprovou), `flagged` (marcou como quebrado em `shadow` e o áudio saiu assim mesmo), `regenerated` (em `enforce`, sintetizou de novo), `rejected` (as regenerações falharam e a resposta saiu em texto), `called_off` (o turno foi cancelado antes de regenerar), `unavailable` (o detector falhou).
- `verdict`: o tipo de defeito que o detector viu (`balbucio`, `zumbido`, `buraco_mudo`, ...), e `score`.
- **`unavailable` não é aprovado**: o áudio saiu **sem** checagem (fora do ar, timeout de `TTS_CHECK_TIMEOUT_MS`, resposta não-2xx ou ilegível; o `reason` diz qual). Investigue o serviço `audio-check` e o `TTS_CHECK_URL`.
- **Sem nenhuma linha `tts_check`** no turno: não há detector rodando (`TTS_CHECK_URL` vazio) ou o agente está com `checkMode: off`. O relato é exatamente o que ele pega; ofereça-o ao usuário pelo caminho do onboarding (`agent-features.md`, "Checagem do áudio sintetizado": memória, imagem e sim explícito).
- `flagged` repetido num agente em `shadow` é o sinal para considerar `enforce`, depois de ouvir os áudios marcados.

### Resposta em áudio só é PTT no WhatsApp se for Ogg/Opus

O TTS emite Ogg/Opus de propósito; mp3/wav chegariam como arquivo comum, não nota de voz. Se "o áudio chegou como arquivo", o formato é o suspeito.

## Mutação

### Write direto no DB pode quebrar no próximo restart

Mudar config da app direto no DB pula o publish/validação: o reader tipado não normaliza/clampa, o audit não registra, e o runtime pode reler do cache. Pode ficar OK agora e quebrar no restart. Sempre via UI/API/MCP da própria app.
