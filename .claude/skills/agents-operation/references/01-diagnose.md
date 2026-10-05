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

## 6. O agente ficou em silêncio

O agente só responde quando a conversa está **pendente** (`pending`) e **sem atendente humano atribuído** (e sem outro Agent Bot). Ele nunca fala junto com uma pessoa. Para cada mensagem do cliente que ele deixou sem resposta por isso, o `/logs` tem uma linha no estágio `handoff` (**Transferência**) com o motivo no `detail`:

- `taken_over`: a conversa está atribuída a um atendente.
- `ownership_lost` (com o `status`): a conversa não está pendente (aberta ou resolvida) ou saiu da posse do agente.

Armadilhas do Chatwoot que mantêm o silêncio:

- **Resolver não tira o atendente.** Se o cliente escreve de novo e a conversa reabre (caixa de API, ou caixa com conversa única por contato ligada), ela volta pendente mas com o mesmo atendente, e o agente continua quieto. Numa caixa de WhatsApp com conversa única desligada, a mensagem nova abre outra conversa, e ali o agente responde.
- **Reabrir pelo Chatwoot atribui a conversa a quem reabriu.**

Correção: **Devolver para a IA** na tela de Conversas do painel (ou MCP `conversation_return`, dry-run primeiro), que tira o atendente e põe a conversa em pendente. É mutação numa conversa viva: só com OK.

Agente em **modo teste** é outro silêncio, por desenho: ele não responde nenhuma conversa até o contato mandar `/teste` nela, e deixa uma nota privada "🧪 Este agente está em modo teste…" na primeira mensagem. Um `/teste` ou `/reset` que o agente ignorou (porque ele não está em modo teste, por exemplo) aparece como linha `command` com status `skipped` e o motivo no `detail`. Ver `gotchas.md`.

## 7. Ver mais do que o log mostra por padrão

Por padrão o log não guarda texto de mensagem nem PII, corta textos longos e mostra os argumentos das ferramentas só como tipo e tamanho. Duas chaves no editor do agente, **Comportamento → Logs**, mudam isso (MCP: `agent_settings_set` com o bloco `observability`, dry-run e OK, porque é mutação):

- **Registrar os valores enviados às ferramentas** (`logToolValues`): grava argumentos e resultados inteiros. Liga para investigar uma ferramenta e **desliga em seguida**, porque passa a guardar dados do cliente. Lembre o usuário de desligar.
- **Guardar o detalhe do log inteiro** (`fullDetailUntil`): grava o texto longo até o fim (o prompt completo do turno, por exemplo). Tem prazo de no máximo 24h e desliga sozinha.

O prompt exato que o modelo recebeu, com os valores das variáveis, está no **Langfuse** (seção 3).

## 8. A ferramenta deu erro

Filtre o estágio `tool` (**Chamada de ferramenta**) **sem filtro de nível**, ou com nível **Aviso** (`warn`), e abra a linha do turno. Falha de ferramenta (HTTP fora de 2xx, exceção, falha de integração) sai com nível `warn` e status `error`; filtrar por nível **Erro** esconde justamente essas linhas. Na linha: nome da ferramenta, status, duração e o erro **padronizado** (`HTTP 404`, timeout). Para saber o que o agente mandou (um CNPJ vazio, um CPF com pontuação no lugar errado), ligue `logToolValues` e repita no playground. Numa ferramenta HTTP, confira também o endereço, a credencial e se a API do outro lado mudou.

A resposta do provedor (status e corpo) não vai para o log do contêiner: a ferramenta a devolve ao modelo. Para lê-la, ou abra os **Detalhes da execução** do playground, que mostram o que a ferramenta devolveu, ou ligue `logToolValues`, que faz a mensagem de erro da linha guardar a resposta inteira (sem a chave, só a primeira linha, `HTTP 404`).

**Erro que não aparece como erro:** status listado em **Status que significam "sem resultado"** (`expectedStatuses`, tipicamente 404 para "não encontrado") conta como resultado, não como falha. Com isso, um endereço errado que devolve 404 sai no log como `ok`, e o agente diz ao cliente que o registro não existe. Quando o agente insiste que "não encontrou" algo que existe, teste o endereço da ferramenta antes de culpar o dado.

