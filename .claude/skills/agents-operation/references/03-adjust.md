# 03: Ajustar (corrigir na camada certa)

Achada a causa, ajuste na camada que a explica. Via **console** (editor do agente) ou **MCP** (write tools, **dry-run primeiro**, aplica só com OK). Toda mutação segue o `00-production-safety.md`.

## Em qual camada está o problema

| Sintoma | Camada | Onde | Tool MCP |
| --- | --- | --- | --- |
| Tom/conteúdo/decisão da resposta | **Prompt/instruções** | editor → General | `prompt_set` |
| Modelo errado/caro/lento, temperatura | **Modelo** | editor → General (seção Model, `modelConfig`) | `agent_update` |
| Usou/não usou a tool certa | **Grants de ferramentas** | editor → Tools | `agent_tools_set` |
| Resposta sem fundamento na base | **Grounding/KB** | editor → Knowledge | `agent_tools_set` (grant RAG), `knowledge_*` |
| Cadência/áudio/janela/agrupamento | **Behavior** | editor → Behavior | `agent_settings_set` |
| Documento (orçamento, proposta, recibo) com campo, bloco ou texto errado, ou que o agente não emite | **Modelo de documento** | Componentes → Modelos de documento (só texto, nome, numeração e estilo) | `document_template_*` + `agent_tools_set` (grant DOCUMENT) |

## Trocar/adaptar o system prompt (preserve a estrutura, troque só o conteúdo)

O prompt é um **campo único** (`Agent.systemPrompt`); a "estrutura base" que o runtime garante (grounding da KB, variáveis `{{...}}`, contexto MCP, budget de ferramentas) é anexada **automaticamente** e não vive no texto do operador. Ao adaptar o prompt (do sample Maria pra outro negócio, ou reescrevendo o de um agente vivo):

- **Preserve a estrutura base do prompt original**: as seções (identidade, tom, regras de atendimento, uso das ferramentas, políticas), a ordem e o formato. Não descarte o esqueleto que já funciona; troque o **conteúdo**, não a arquitetura.
- **Troque só o conteúdo específico do negócio**: nome, serviços, horários, endereço, políticas, exemplos. Mantenha as instruções de uso de ferramentas (agenda, pagamento, KB) coerentes com as tools que o agente **realmente** tem.
- **Pergunte ao usuário as informações necessárias** pela ferramenta de pergunta estruturada, **uma de cada vez** (nome do negócio, o que oferece, horários, políticas de agendamento/cancelamento, formas de pagamento…). Nunca invente dados nem deixe placeholders (`[preencher]`) no prompt aplicado.
- **Preview primeiro** (`prompt_set` dry-run): mostre o texto final ao usuário e só aplique com o OK.

## Grants de ferramentas: replace-the-set

O editor (`Tools` + `Knowledge`) edita **um** working set de grants e faz **PUT do set inteiro** (substitui, não acumula). O `agent_tools_set` segue o mesmo modelo.

- **NATIVE:** sem grant NATIVE (ou allowlist vazia) = **todas** as tools nativas. Restringir = mandar o subconjunto explícito.
- **RAG:** habilitar = mandar os nomes da tool RAG + os ids das KBs. Vazio = sem RAG (fail-closed).
- MCP: discover por servidor → allowlist. INTEGRATION: checkboxes por toolpack.

## Behavior: o que cada bloco controla (1 linha)

`agent.settings.*`, ajustável no editor → Behavior e via `agent_settings_set` (patch parcial, merge nas sub-chaves, re-lido pelos readers tipados com clamp):

- **debounce**: agrupa a rajada de mensagens e responde **uma vez** (on por padrão; `windowSeconds`, `maxMessagesPerBurst`, `maxWindowSeconds`).
- **stt**: transcreve áudios recebidos (on por padrão, efetivo só com credencial; `provider`/`model`/`language`/`credentialRef`).
- **tts**: responde em áudio: `mode` `never`|`mirror`|`preference` (default `never`).
- **split**: quebra a resposta em balões com "digitando" (off por padrão; só texto).
- **serviceWindow**: janela de 24h do WhatsApp para envios **proativos**: dentro = livre, fora = template HSM ou nota (on por padrão). Não afeta a resposta reativa, e só vale na API oficial (abaixo).
- **grounding**: limiar de distância (`maxDistance`) da busca na KB (distinto do grant RAG da aba Knowledge).

> **A janela de 24h existe só na API oficial, e o `channel_type` não distingue.** Toda inbox de WhatsApp no Chatwoot é `Channel::Whatsapp`; quem decide é o **`provider`**: `whatsapp_cloud` (Cloud API) e `default` (BSP 360dialog) têm janela e template, `native`, `uazapi`, `baileys` e `zapi` não têm nenhum dos dois. Numa inbox sem janela o proativo sai livre mesmo com o `serviceWindow` ligado, então "o gate não segurou" costuma ser o provider da inbox, não a config: confira o provider antes de mexer no bloco. Trocar pro canal oficial é trabalho do lado da Meta + Chatwoot, fora da agents, e o passo a passo gratuito da comunidade vai da criação do app na Meta até a inbox pronta: [WhatsApp com API Oficial no Chatwoot (fluxo manual)](https://www.lucasmoreira.ai/c/conteudos-exclusivos/whatsapp-com-api-oficial-no-chatwoot-fluxo-manual-9ae92651-f21b-40dc-a7b1-2ff7d680e0e5?utm_source=agents&utm_medium=skill&utm_campaign=agents-operation).

## Modelo de documento: montar e ajustar pelo MCP

O console **não monta** um modelo de documento: no editor dá para mudar o texto dos blocos que já existem, o nome, a numeração e o estilo, e só. Adicionar, remover ou reordenar blocos e declarar os campos que o agente preenche é feito pelo MCP (ou pela API). Então, quando o usuário escolhe o modelo **Em branco** no console, ou quer um documento que nenhum modelo pronto cobre, quem constrói é você, pelo MCP, com ele dizendo o que o documento precisa ter. Diga isso a ele com essas palavras se ele estiver esperando um botão de "adicionar campo" na tela.

**Antes de escrever, pergunte.** Pela ferramenta de pergunta estruturada, uma pergunta de cada vez: que documento é (orçamento, proposta, recibo, ordem de serviço), o que o cliente precisa ver nele, o que **o agente** sabe na hora de emitir (vira campo) e o que é fixo (vira texto), se tem tabela de itens com total, validade, condições. Nunca invente dado da empresa (CNPJ, endereço, condições comerciais).

**O caminho, nesta ordem:**

1. `document_starters_list` e `document_template_schema`. O schema é o contrato exato (blocos, campo, estilo e a lista de `{{tokens}}`); leia uma vez antes de escrever bloco. Uma propriedade fora dele é **recusada pelo nome**, não ignorada.
2. `document_template_create` com `starter` (`quote`, `proposal`, `receipt` ou `blank`) e só o que muda por cima: é o caminho mais curto. Sem `dry_run:false` ele **renderiza o PDF e não cria nada**; mostre ao usuário o que vai ser criado e crie só com o OK.
3. Para ajustar um que já existe: `document_template_get` (devolve blocos, campos e estilo exatamente no formato que o update aceita) e `document_template_update`, que é patch. Mandar `blocks` ou `fields` revalida **os dois**, porque metade das regras é sobre como um aponta para o outro.
4. Dar o modelo ao agente: `agent_tools_get` para achar o `documentTemplateId` e `agent_tools_set` com um grant `DOCUMENT`. É **replace-the-set** (seção acima): mande o conjunto inteiro de grants, senão o agente perde as outras ferramentas.

**O que o agente vê.** Cada modelo vira uma ferramenta própria chamada `send_<slug>`, e os `fields` declarados viram os argumentos dela. A **descrição do modelo é anexada à descrição dessa ferramenta**, então escreva-a para o modelo de IA: quando emitir este documento, não o que ele é na tela.

**Regras que recusam a chamada** (o erro diz qual, mas saber antes poupa a volta):

- nome de campo começando com `company_`, `empresa_`, `doc_` ou `documento_` (esses já resolvem para o timbre ou para o próprio documento);
- bloco `lineItems` ou `totals` apontando para um campo que não é do tipo `lineItems`;
- `{{token}}` que não é campo declarado nem nome reservado (sairia como espaço em branco num documento que o cliente guarda).

`totals` calcula a própria conta a partir dos itens: nunca declare um campo para guardar soma, e nunca peça soma ao modelo. Texto aceita `**negrito**`, `*itálico*` e itens com `- `, e nada além disso.

**O timbre não passa pelo MCP.** Nome, CNPJ/CPF, endereço, telefone e logo vêm do perfil da empresa, que o usuário preenche no console em Componentes → Modelos de documento → Perfil da empresa. Se o documento sair sem nome da empresa, é esse perfil que está vazio, não o modelo.

**Validar:** o `dry_run` do create/update já renderiza (um erro de layout aparece ali), e o editor do console mostra a prévia com valores de exemplo; peça ao usuário para abrir e olhar. O playground **não** emite documento (devolve uma resposta simulada, ver `02-reproduce.md`), então para ver o PDF que o cliente recebe use a conversa de teste controlada do `04-validate-and-apply.md`.

## Credenciais

Nunca passe o segredo cru. Na agents o segredo vive no **vault** e é referenciado por nome (`credentialRef` = `vault:<id>`); MCP traduz nome↔ref na borda, nunca o valor. Credencial faltando não é erro: a tool retorna `needsCredential` + URL do console para o usuário preencher fora de banda.
