# 01: Diagnosticar (isolar qual estágio divergiu)

Objetivo: de "a conversa deu errado" até "o estágio X divergiu por causa de Y". Tudo read-only.

## 1. Localizar a conversa

- No Chatwoot, a conversa tem um **`display_id`** (o número visível). É a âncora.
- Chaves internas correlatas (você não digita, mas aparecem nos logs/traces):
  - **Por-conversa** `tenant:instance:display_id`: usada por debounce, correlação de flowlog, fence de tenant e como **session no Langfuse**.
  - **Memória do grafo** `tenant:instance:ci:<contactInboxId>`: o histórico que o agente "lembra" (por contato+canal). Uma conversa nova reusa essa memória; canais diferentes do mesmo contato têm memórias separadas.

## 2. Ler o ExecutionLog do turno

Página **`/logs`** (cards agrupados por turno, paginação keyset) ou `GET /v1/logs` (TENANT_ADMIN) / MCP `logs_query`. Filtros: `conversationId`, `agentId`, `turnId`, `stage`, `level`, `since/until`, `source` (default `inbox`; `playground` é separado).

- **Um `turnId` por turno.** Cada linha é um estágio: `stt`, `embed`, `generate`, `tts`, `tts_check`, `split`, `handoff` (+ erros). Filtre pelo `conversationId` e leia os turnos em ordem.
- O `detail` é livre de PII (ids/contagens/enums); `errorMessage` é sanitizado. Você vê **o que** falhou e **onde**, não o texto da mensagem.
- Leitura de sintomas:
  - erro/anomalia em `stt` → transcrição do áudio (provider/credencial).
  - resposta sem usar a KB, ou erro de embedding → ver `generate` (a busca RAG roda **dentro** do span `generate`; `embed` ainda não é emitido separado).
  - resposta errada/ferramenta errada → `generate` (prompt, grants, chamadas de tool).
  - áudio quebrado (embolado, zumbido, trecho mudo) → `tts_check` (**Audio check** / **Verificação do áudio**) primeiro; ausente = sem detector ou `checkMode: off` (ver `gotchas.md`).
  - sem áudio quando deveria → `tts`. Balões estranhos → `split`. Não transferiu → `handoff`.

## 3. Trace no Langfuse

Abra o trace do turno (env `production` ou `production-playground`, **session = o threadId por-conversa** `tenant:instance:display_id`). Mostra a sequência de chamadas ao modelo + tools, inputs/outputs, latência. É onde você lê o raciocínio e as tool calls que o flowlog só resume.

## 4. Inspecionar a config do agente

Editor do agente (abas General/Tools/Knowledge/Behavior) ou MCP read: `agent_get`, `agent_settings_get` (blocos `debounce`/`stt`/`tts`/`split`/`serviceWindow`/`grounding`, já normalizados), `agent_tools_get` (grants). Confirme se o comportamento observado bate com a config (ex.: respondeu balão-a-balão → debounce off; não respondeu fora de horário → service-window/business-hours).

## 5. (Se preciso) estado do checkpointer

O grafo persiste o histórico por thread de memória. Se o agente "lembra" algo que não deveria (ou perdeu contexto), a causa pode estar no histórico acumulado naquela thread. Leitura para diagnóstico; **não** edite o checkpointer direto.
