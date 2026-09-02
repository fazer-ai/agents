# 08: Import do agente + credenciais + embedding + KB

> **Havendo uma Secretária v3 na VPS (etapa 1b), o agente sai dela**, não da Maria: os workflows do n8n são a fonte, e a conversão tem armadilhas próprias (o prompt é uma expressão, nomes de ferramenta espalhados, chave de atributo sem vocabulário fixo). Ver [`migracao-v3.md`](migracao-v3.md) seções 2 a 4 antes de montar o arquivo.

> **Ao falar com o usuário** nesta etapa, descreva o resultado, não a mecânica: "vou criar o agente de atendimento (a Maria, uma recepcionista de exemplo); ele nasce desligado e em modo de teste, então não fala com cliente até você liberar". **Havendo v3, a frase é outra**, porque o agente é o dele e não um exemplo: "vou montar o seu agente a partir da secretária que você já roda; ele nasce desligado e em modo de teste, e a sua atual continua no ar o tempo todo". Na hora de pedir as chaves que faltam, diga "faltam algumas chaves (ex.: a da OpenAI) pro agente funcionar; vou te mandar um link direto pra colar cada uma com segurança, elas não passam por mim". **Não** cite `agent_import`/`credential_create`/"pending"/"deeplink"/"vault"/"tenant". Frases boas × ruins em `guardrails.md`.

## 1. Importar (`agent_import`, mcp:write)

A skill traz o **agente padrão** vendorado em `samples/agents/maria-clinica-moreira.json` ("Maria", recepção da Clínica Moreira fictícia: agendamento, FAQ via KB, voz, Asaas). **Importe-o por padrão**, e use outro export em dois casos: o usuário trouxe o dele, **ou existe uma Secretária v3** e o bundle é o que você montou a partir dela ([`migracao-v3.md`](migracao-v3.md) §4). Nesses casos a Maria não entra, nem como ponto de partida. Leia o arquivo e passe o conteúdo como `export`:

```jsonc
agent_import { "export": <conteúdo de samples/agents/maria-clinica-moreira.json>, "tenant": "<slug do tenant_list>" }   // dry_run:true → preview, depois dry_run:false
```

- **SUPER_ADMIN:** inclua `tenant` (o slug/id de `tenant_list`); o token é fleet-level. **NUNCA** `tenant_create`: o tenant do `/setup` já existe; criar outro joga o agente no tenant errado (ver etapa 6).
- O agente é **sempre** criado **disabled + test mode** (nunca vai ao ar pra cliente por acidente); componentes (KB/tools/etc.) recriados/reusados **por nome**.
- Credenciais faltantes (os nomes não existem no tenant novo): o import cria uma entrada **pending** (mantendo o ref wired) e emite o aviso `credentialPending`; o usuário preenche no vault.
- **Exceções** que não viram pending no import → `credentialNotFound`: (a) OAuth gerenciado (`google_oauth`, `mcp_oauth`), que nunca pode ser pending (vem de connect flow); (b) kinds que exigem `base_url`/`param_name`, porque o import não tem esses valores pra passar. Pra (b), crie explicitamente com `credential_create` passando `base_url`/`param_name` (ex.: `openai_compatible`); pra (a), trate o OAuth à parte.

> **Negócio real (não o demo):** se o usuário quer o agente pro negócio **dele** (não a Clínica Moreira de exemplo), **adapte o prompt do Maria preservando a estrutura base** e trocando só o conteúdo:
> - **Preserve** as seções (identidade, tom, regras de atendimento, uso das ferramentas, políticas), a ordem e o formato do prompt original; troque o **conteúdo**, não a arquitetura. A estrutura invariante do runtime (grounding da KB, variáveis `{{...}}`, contexto MCP) é anexada sozinha, não vive no texto.
> - **Troque** só o específico do negócio: nome, serviços, horários, endereço, políticas, exemplos. Mantenha as instruções de ferramentas coerentes com as tools que o agente **realmente** tem.
> - **Pergunte** as infos necessárias pela ferramenta de pergunta estruturada, **uma de cada vez** (nome, o que oferece, horários, políticas de agendamento/cancelamento, pagamento); nunca invente nem deixe placeholders (`[preencher]`).
> - Aplique com `prompt_set` (dry-run → mostre o texto final → OK).

## 2. Preencher credenciais (segredo NUNCA passa pelo agente)

- **Sempre entregue o deeplink**, nunca só "vá em Configurações → Credenciais". Cada pending abre direto pelo `fillAt = ${PUBLIC_URL}/resources/vault?fill=<vaultId>` (o `?fill=<id>` abre o modal de preenchimento da entrada). É o caminho canônico das credenciais do **usuário** (OpenAI/ElevenLabs/Asaas). O formato está aqui; **não** baixe/grepe o bundle da SPA pra descobrir a rota/deeplink (minificado + hasheado, muda a cada build).
- **De onde vem o `fillAt`:** um `credential_create` **real** (`dry_run:false`) devolve o `fillAt` na resposta. Mas o **dry-run não devolve**, e re-criar uma que já existe **duplica**. Pra uma pending que **já existe** (import/brownfield/run anterior), **não re-crie**: pegue o `id` no `vault_list` e monte a URL você mesmo (`${PUBLIC_URL}/resources/vault?fill=<id>`).
- A chave OpenAI e as demais do **usuário** (ElevenLabs/Asaas) o usuário preenche por esse deeplink; o segredo nunca passa pelo agente. Acompanhe pelo `vault_list` até o status sair de `pending`. (Exceção: o Langfuse, cujas keys **você** provisiona ao semear o projeto, não é segredo do usuário; ligue no fazer.ai agents via `langfuse_connect` com as keys inline, ver `references/05-langfuse.md`.)
- **Pedido avulso (fora do import), ex.: "cria a credencial do ElevenLabs":** o gesto é sempre **pré-criar a referência sem segredo → entregar o deeplink**, mas **`vault_list` primeiro**. Se a entrada **já existe** (o import da Maria já traz a de voz pending, e brownfield/run anterior podem tê-la deixado), **não re-crie** (duplica): monte o `?fill=<id>` a partir do `id`. Só se **não existir** rode `credential_create` (dry-run → aplica), que devolve o `fillAt`. A chave o usuário cola no console; você acompanha pelo `vault_list` até sair de `pending`.
- **Isto vale só para credenciais de CHAVE (`generic` e afins: OpenAI/ElevenLabs/Asaas); OAuth gerenciado é o OPOSTO, não generalize.** Para `google_oauth`/`mcp_oauth` **não** existe tool de MCP e o `credential_create` os **recusa** (não podem nascer pending: o segredo e o consent vêm de um connect flow, não de um `?fill=`). O Google (Calendar/Drive) é **console-only**: o usuário cria a credencial com Client ID/Secret e faz o "Sign in with Google", sem pré-criação nossa. Não tente pré-criar nem gerar `?fill=` pra ele; fluxo completo em [`agent-features.md`](agent-features.md) §3.

## 3. Religar o modelo + habilitar (`agent_update`)

Habilite o agente **mantendo o test mode** (como ele foi importado). Habilitar liga o bot; o `mode:"test"` faz ele responder só em conversas ativadas com `/teste` (etapa 10) e ficar em silêncio nas demais (com uma nota privada), então ele **não** atende cliente real ainda. Ligar pra produção é o **passo final do usuário** (abaixo).

```jsonc
agent_update {
  "agent_id": "<id>", "enabled": true,
  "model_config": { "provider":"openai", "model":"gpt-5.4-mini", "temperature":0.3, "credentialRef":"<nome da vault entry>" }
}
```

- **Não** mande `mode` aqui: o import já criou em `test` e a validação (etapa 10) roda nesse modo via `/teste`. Não promova pra `production` por conta própria.
- Via MCP, `model_config.credentialRef` aceita o **nome** da entrada do vault (resolvido server-side). Via REST é a forma `"vault:<id>"`.
- Mande o `model_config` **completo** pra não clobberar campos. (O STT pode reusar a mesma chave.)

### Ir pra produção é decisão do usuário

Depois do E2E aprovado (etapa 10), **o usuário** decide quando o agente vai ao ar pra clientes reais: aí sim `agent_update { "agent_id":"<id>", "mode":"production" }`. Entregue o agente validado em test mode e deixe esse flip pro usuário; não o faça no fluxo automático.

## 4. Embedding é por-tenant (senão a KB falha)

Ligue a credencial de embedding no tenant **via MCP**: `tenant_settings_update { embedding: { credential_ref: "<nome da entry>" } }` (provider/model default a `openai`/`text-embedding-3-small`). Sem isso (ou com a credencial ainda pendente) a KB **não indexa**: os docs ficam `UNINDEXED`, **não** FAILED (pré-requisito faltando não é falha). É no nível do **tenant**, não por-KB. O embedding usa a chave OpenAI, então ligue-o **depois** do usuário preencher o OpenAI (passo 2).

## 5. Indexar a KB (`knowledge_reindex`)

- Os docs do import entram **UNINDEXED**. Com o embedding ligado (passo 4) **e o OpenAI preenchido**, indexe a base inteira numa chamada **via MCP**: `knowledge_reindex { knowledge_base_id }` (dry-run por padrão; `dry_run:false` aplica).
- **Se o pré-requisito ainda falta** (embedding não configurado, ou credencial pendente), o `knowledge_reindex` **não enfileira nada** e devolve `blocked` + `fillAt` (deeplink pra preencher a credencial); os docs **ficam UNINDEXED**, não FAILED. Entregue o `fillAt` ao usuário, espere preencher, e re-rode.
- Pra recuperar docs que **de fato** falharam na ingestão (erro real, não pré-requisito), `knowledge_reindex { knowledge_base_id, include_failed:true }` re-enfileira os FAILED em lote (ou `knowledge_document_retry { document_id }` por doc).

## 6. Gate antes de seguir

Não declare o import pronto com aviso aberto: **todos os docs da KB READY** + **grounding verificado** no playground (pergunte algo que só a KB sabe); STT/TTS/visão sinalizados → conectar credencial ou desligar a feature. Detalhe + features opcionais (voz, Google OAuth) em [`agent-features.md`](agent-features.md).
