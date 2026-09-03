# Migração da Secretária v3 (n8n) para a V4

Ramificação das etapas **1b, 8, 9 e 10** quando o inventário acha uma Secretária v3. Não é uma jornada paralela: o deploy, o `/setup` e o MCP são os mesmos. O que muda é **de onde sai o agente** (da v3, não da Maria) e **como ele entra no ar** (cutover, não simples bind).

**O princípio que rege tudo aqui:** a v3 fica de pé até o fim, e continua de pé depois. Ela é o plano de rollback. **Deploy, workflows, memória e credenciais ficam intocados.** A única coisa que esta ramificação mexe é o **gatilho** dela, no cutover, e mexe de um jeito que volta em segundos (seção 8). Desligar a v3 de vez existe, é a seção 9, e acontece dias depois do cutover com o usuário decidindo, nunca dentro da migração.

---

## 1. Ler a v3 (etapa 1b, depois da detecção)

**Não peça a senha da UI do n8n.** Os workflows se leem direto, mas **antes confirme onde eles estão**: o padrão do n8n é SQLite, e a v3 pode ter o Postgres só para as três tabelas dela, que são criadas pelos nós SQL do fluxo e não têm relação com o armazenamento do n8n. Leia o `DB_TYPE` do contêiner do n8n: vazio ou `sqlite` quer dizer que `workflow_entity` **não existe** naquele Postgres, e a consulta abaixo devolveria zero workflow numa v3 que a sondagem acabou de encontrar, que é o mesmo erro do `-d n8n` cravado, por outra porta. Nesse caso a leitura vai pela CLI dentro do contêiner do n8n, que serve aos dois armazenamentos: `n8n list:workflow` para a listagem e `n8n export:workflow --id=<id>` para o JSON. Com `DB_TYPE=postgresdb`, vale o comando abaixo:

```sh
n8nenv=$(docker inspect <container-do-n8n> --format '{{range .Config.Env}}{{println .}}{{end}}')
n8ndb=$(printf '%s\n' "$n8nenv" | sed -n 's/^DB_POSTGRESDB_DATABASE=//p')
env=$(docker inspect <postgres-do-n8n> --format '{{range .Config.Env}}{{println .}}{{end}}')
u=$(printf '%s\n' "$env" | sed -n 's/^POSTGRES_USER=//p'); u=${u:-postgres}
d=$(printf '%s\n' "$env" | sed -n 's/^POSTGRES_DB=//p')
sch=$(printf '%s\n' "$n8nenv" | sed -n 's/^DB_POSTGRESDB_SCHEMA=//p')
docker exec -e PGOPTIONS="--search_path=${sch:-public}" <postgres-do-n8n> \
  psql -U "$u" -d "${n8ndb:-${d:-$u}}" -tAc \
  "select id, name, active from workflow_entity order by name;"
```

Usuário e nome do banco só existem dentro do contêiner. Passar uma variável de shell direto no `-U` não resolve: quem expande é o host, antes do `docker exec`, e lá `PGUSER` não existe, então chega vazio. E o banco nem sempre se chama `n8n`, então cravar `-d n8n` devolve zero workflow numa v3 que a sondagem acabou de encontrar. As duas leituras saem do `docker inspect`, como a sondagem da 1b já faz; o `${d:-$u}` cobre o padrão da imagem, que é o banco herdar o nome do usuário quando `POSTGRES_DB` não é setado. E o `POSTGRES_DB` é só o default de inicialização do banco: quando o n8n aponta para outro, quem manda é o `DB_POSTGRESDB_DATABASE` do contêiner do **n8n**, que por isso é a primeira escolha no comando acima. Vale o mesmo para o schema, que nem sempre é `public`: sem o search path do n8n, a consulta a `workflow_entity` não acha nada num banco em que a sondagem acabou de achar as três tabelas, porque ela procura pelo `information_schema` e não depende de schema.

O JSON de cada workflow está em **duas** colunas: `workflow_entity.nodes` traz os nós e `workflow_entity.connections` traz as arestas. Puxe as duas e trabalhe em arquivo, nunca inline. **Redija na própria VPS, antes de qualquer coisa sair de lá**, e faça isso **projetando o que você precisa**, não removendo o que parece perigoso. Denylist por nome de campo não funciona aqui: no n8n a chave de API mora em `queryParameters.parameters[].value`, ou dentro da própria `url`, e o segredo do webhook é o `path` do nó de gatilho. Nenhum desses nomes denuncia o que carregam. O que sai da VPS é isto, e só isto:

```sh
jq 'def mask: if (type == "string" and startswith("=")) then . else "<literal>" end;
{
  prompt:      [.nodes[] | select(.type | endswith(".agent")) | .parameters.options.systemMessage],
  ferramentas: [.nodes[] | select(.type | test("[Tt]ool"))
                | (.parameters.workflowId // null) as $w
                | {nome: .name, tipo: .type,
                   alvo_id:   (if ($w|type) == "object" then $w.value            else $w   end),
                   alvo_nome: (if ($w|type) == "object" then $w.cachedResultName else null end)}],
  saidas:      [.nodes[] | select(.type | test("\\.set$"))
                | {nome: .name,
                   campos: [(.parameters.assignments.assignments // [])[]
                            | {nome: .name, valor: (.value | mask)}],
                   json_cru: (.parameters.jsonOutput != null)}],
  nos:         [.nodes[] | {nome: .name, tipo: .type}],
  arestas:     .connections
}'
```

**O `saidas` é o template de resposta da ferramenta, e sem ele a migração inventa um.** Na v3 quem monta o que a ferramenta devolve ao agente é um nó Set depois da chamada HTTP, e `nome`+`tipo` não dizem nada sobre isso: no subfluxo do Asaas, o `Resultado` devolve `resultado`, `valor`, `vencimento` e `link`, cada um vindo de um campo específico da resposta. Os valores seguem a regra da seção inteira, expressão passa e literal vira `<literal>`, e é assim que o `Info` sai com `url_chatwoot` e `id_conta` cegos. Set em modo JSON cru é outra forma: `campos` sai vazio e `json_cru: true` marca, que é o sinal para ler aquele nó na VPS em vez de confiar na projeção.

O `alvo_nome` não é enfeite: o nome do nó e o do subfluxo que ele chama divergem com frequência (`Enviar arquivo` chamando `02. Baixar e enviar arquivo do Google Drive`), e mapear pelo nome do nó põe você lendo a implementação errada. Isso cobre as quatro linhas da tabela abaixo e fecha a porta por onde o segredo costuma sair, porque `parameters` de nó que não é o agente nunca é emitido. **Sobra uma que a estrutura não fecha, e ela não fecha mesmo**: o prompt é texto livre, e para migrar é preciso lê-lo. Não existe procedimento que leia o prompt e garanta que nenhum segredo entrou no transcript, então **não trate nada aqui como garantia**. O que existe é um aviso, barato, para rodar antes de trazer:

```sh
# a projeção acima gravada em projecao.json na VPS.
# -q de propósito: o teste diz SE tem, nunca O QUE tem.
jq -r '.prompt[]' projecao.json \
  | grep -qiE 'sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{20,}[.][A-Za-z0-9_-]{10,}|(bearer|basic|token|apikey) +[A-Za-z0-9._=-]{16,}|https?://[^ :]+:[^ @]+@|https?://[^ ]*(token|key|secret|senha|password)=' \
  && echo 'ATENCAO: forma de chave no prompt' \
  || echo 'nenhuma das formas conhecidas'
```

**"Nenhuma das formas conhecidas" não quer dizer limpo.** A lista cobre os formatos com prefixo reconhecível e não tem como cobrir uma senha solta ou um identificador interno. O `-i` não é detalhe: a grafia padrão do HTTP é `Bearer`, com maiúscula, e sem ele o aviso passava batido no caso mais comum de todos. O ponto do JWT vai como `[.]`, entre colchetes, porque contrabarra dentro de aspas simples num trecho que vai ser copiado e colado erra calada, e um `\\.` deixa aquela alternativa exigindo uma contrabarra literal no texto, ou seja, morta. Por isso o passo seguinte não é seu, é do usuário: **peça que ele leia o prompt na VPS e tire o que for sensível antes de você trazer.** É a mesma regra do resto da jornada, em que o segredo é decisão dele e não passa por você.

**As ferramentas HTTP também saem projetadas, não lidas cruas**, e aqui a linha que separa o que sai do que não sai é outra: **expressão do n8n é mapeamento e você precisa dela; valor literal é candidato a segredo e não precisa**. Um `={{ $json.cnpj }}` diz de onde o campo vem; um `abc123...` cravado no header é a chave. Emita a estrutura com os literais mascarados:

```sh
jq 'def mask: if (type == "string" and startswith("=")) then . else "<literal>" end;
     def scrub: tostring
       | sub("//[^/@ ]+@"; "//<userinfo>@")
       | gsub("(sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,}|gh[pousr]_[A-Za-z0-9]{30,})"; "<segredo>");
     def urlmask: tostring
       | if startswith("=") then scrub else (scrub | sub("\\?.*$"; "?<query>")) end;
     [.nodes[] | select(.type | test("httpRequest"))
      | {nome: .name, metodo: (.parameters.method // "GET"),
         url:       (.parameters.url | urlmask),
         url_expr:  (.parameters.url | tostring | startswith("=")),
         query:   [(.parameters.queryParameters.parameters  // [])[] | {name, value: (.value | mask)}],
         headers: [(.parameters.headerParameters.parameters // [])[] | {name, value: (.value | mask)}],
         body:    [(.parameters.bodyParameters.parameters   // [])[] | {name, value: (.value | mask)}]}]'
```

Com isso vem o que constrói a ferramenta nova (método, URL, nomes e de onde cada campo sai) sem os valores cravados. **Um `<literal>` que você precisa entender é pergunta para o usuário**, não motivo para trazer o valor.

**E `url_expr: true` é o que o usuário lê antes de qualquer coisa sair da VPS.** Sair inteira é o único jeito de a URL chegar sem mapeamento quebrado, e o preço é que um segredo digitado literal no meio dela sai junto, que nenhum filtro pega sem interpretar a linguagem de expressão. Nesse campo não existe versão que preserve o mapeamento e cegue o valor ao mesmo tempo; existe escolher qual das duas falhas você aceita, e deixá-la visível. Por isso essas URLs entram na lista do fechamento da seção, e não na conta do que a projeção já resolveu. E não conte com isso ser caso raro: na v3 de referência, as 14 chamadas HTTP saem marcadas, todas.

**A URL segue a mesma regra, só que decidida por nó inteiro, e vale entender por quê.** No n8n a query costuma morar dentro da própria URL, e apagar tudo depois do `?` levava junto o `{{ }}` que diz de onde o campo vem: a ferramenta nova nascia sem uma entrada obrigatória, e sem sinal de que faltava. Só que o caminho oposto, sair mascarando par a par, é pior: aquele campo é texto livre numa linguagem de template, e picar string sem entender a linguagem quebra a expressão. Um `={{ 'https://api/x?id=' + $json.id }}` tem o `?` **dentro** da expressão, e cortar ali devolve um pedaço truncado que ainda parece uma URL de verdade. Por isso a decisão é do nó, não do caractere: **URL literal sai com a query cega** (`?<query>`), porque ali não há mapeamento a perder; **URL expressão sai inteira**, porque ela é o mapeamento, e vem marcada com `url_expr: true`.

**Duas coisas que essa projeção não mostra e que quebram a ferramenta migrada em silêncio:**

- **Autenticação por credencial do n8n.** É o caso comum, e ela não aparece em header nenhum: mora em `.parameters.authentication` / `.parameters.genericAuthType` e em `.credentials`. Um nó assim projeta como se fosse anônimo, e a ferramenta nova nasce sem credencial e falha na primeira chamada. Carregue o **tipo e o nome** da credencial (nunca o valor) e recrie no cofre.
- **Modos alternativos de parâmetro.** Com query, header ou corpo em JSON cru, as expressões ficam em `jsonQuery`, `jsonHeaders` e `jsonBody`, e os arrays acima saem vazios. Nó nesse formato vai para conversão manual, não para a projeção.

**E o filtro acima é ponto de partida, não contrato.** O nó de HTTP do n8n tem várias formas, e a cada uma nova a projeção erra por omissão, calada. Confira a forma do nó antes de confiar na saída; não batendo, leia aquele nó na VPS.

> **Nada disto é garantia, e a regra é uma só para a seção inteira.** A projeção derruba a maior parte da exposição; ela não cobre um segredo escrito num lugar sem forma reconhecível, no prompt ou num caminho de URL. Por isso o passo que fecha é sempre o mesmo, e não é seu: **o usuário revê na VPS o que vai sair e tira o que for sensível.** Vale para o prompt e para os nós, e é a mesma regra do resto da jornada, em que segredo é decisão dele e não passa por você.

**O que você precisa levantar, e é só isso:**

| Do workflow principal | Para quê |
|---|---|
| `systemMessage` do nó do agente | vira o `systemPrompt` (seção 2) |
| Lista de `toolWorkflow` conectados | vira o de-para de ferramentas (seção 3) |
| Nós de LLM auxiliares (formatar, dividir) | quase todos têm par nativo; ver seção 3 |
| Config de fila e memória | vira agrupamento e memória nativos, sem configurar |

**Mostre o de-para ao usuário antes de construir.** "Li isso da sua v3, cada ferramenta vira isso, confirma?" A parte mecânica é sua; a decisão de para onde vai cada coisa é dele.

---

## 2. Converter o prompt

A parte que parece cópia e não é. **Seis armadilhas, todas já vistas em migração real:**

1. **O prompt não é texto, é uma expressão.** No JSON, o `systemMessage` começa com `=`, tipo `=# PAPEL`. Aquele sinal é a marca de expressão do n8n. Copiar o campo inteiro leva um `=` solto na primeira linha. **Vale para todo prompt de v3**, porque é assim que o campo é preenchido lá.

2. **Expressões no corpo.** Blocos tipo `{{ $('Info').item.json.nome_contato }}` são código do orquestrador e chegariam ao modelo como texto cru. Cada um tem um destino, e **só um deles é apagar**. Data e hora saem do prompt e viram `get_current_time`; atributos saem e viram contexto de atributos (item 5). **Identidade do contato não sai: ela é traduzida.** O runtime não anexa nome nem telefone sozinho, ele **substitui marcador que ficou no prompt**, então `{{ $('Info').item.json.nome_contato }}` vira `{{nome_contato}}`, e o telefone vira `{{telefone_contato}}`. Apagar a linha, que é o reflexo certo para os outros casos, é o que faz o agente perder o nome de quem está falando com ele. Os marcadores reconhecidos são `nome_contato`, `telefone_contato`, `email_contato`, `canal`, `nome_empresa` e `nome_agente`; expressão da v3 que aponte para qualquer um desses vira o marcador, não vira deleção.

3. **Nomes de ferramenta estão espalhados.** Renomear a seção `<ferramentas>` não basta: os nomes antigos aparecem nos fluxos e nos exemplos ("chame `Consultar_cnpj`", "registre com `Salvar_informacao`"). **Grep cada nome antigo no prompt convertido e exija zero ocorrências**, senão o prompt manda chamar ferramenta que não existe e o modelo obedece o texto, não a lista.

4. **Parâmetro que não tem par.** O `Escalar humano` da v3 recebia `resumo` e `area`. O `handoff_to_human` não recebe argumento livre. Dobre a área para dentro do resumo com `transferWithSummary`, ou use `private_note` antes do transbordo. **Diga ao usuário o que se perde**: a área deixa de ser campo e vira frase. **Com times cadastrados no Chatwoot dá para recuperar o roteamento, e o modo decide como.** O `handoff.mode` nasce `route` (o Chatwoot distribui) e o `targetTeamId` **só é lido em `pinned`**, que manda *todo* transbordo para um alvo fixo. O `area` da v3 era decisão por conversa, então o par dele é `agent_choice`: o modelo passa o nome do time, resolvido contra a lista viva do Chatwoot, e as opções vão nas instruções de transbordo. Preencher `targetTeamId` com o modo em `route` não roteia nada e não avisa.

5. **Chave de atributo precisa de vocabulário fixo.** A v3 dizia só "chave, valor" e o modelo inventava o `snake_case` a cada conversa, o que lá não incomodava porque nada relia. Na V4 os atributos voltam ao prompt pelo contexto de atributos, e a invenção quebra: o agente grava `faturamento`, o contexto injeta `faturamento_mensal`, e ele fica cego para o que acabou de escrever. **Liste as chaves canônicas no prompt e declare as mesmas em `attributeContext.contact`.** Declarar sem fixar no prompt não resolve.

6. **Instrução de formatação SAI do prompt, não entra.** O Chatwoot converte markdown para a sintaxe do WhatsApp no caminho de saída (`MessageContentPresenter` → `WhatsAppRenderer`). Uma regra do tipo "escreva negrito com um asterisco só" faz o modelo emitir `*assim*`, que o renderer lê como itálico e entrega `_assim_`. **As duas conversões se compõem.** Se a v3 tinha essa instrução no prompt, ela é justamente o que não migra.

---

## 3. O de-para de ferramentas

Nem tudo vira ferramenta, e é isso que o usuário precisa ver:

| Na v3 | Na V4 |
|---|---|
| Escalar humano (workflow) | `handoff_to_human` nativa, mais as instruções de quando escalar |
| Salvar informação | `set_custom_attribute`, escopo `contact` |
| Reagir mensagem | `react_to_message` |
| Preferência de áudio | `set_voice_preference` (só conceda se o TTS for ligado; com `tts.mode: never` ela grava dado sem efeito) |
| Ferramenta HTTP customizada (`toolWorkflow` com HTTP Request) | Ferramenta HTTP declarativa: `urlTemplate`, `allowedHosts`, contrato de entrada, `expectedStatuses` e **template de resposta** |
| Nó `Set` que formata a resposta da API | O **template de resposta** da ferramenta HTTP. Sem ele o modelo recebe o corpo cru cortado em 4.000 caracteres e inventa o que ficou de fora |
| Nó de LLM que formata o texto | O renderer do Chatwoot. Some da conversão (ver 2.6) |
| Quebrar e enviar mensagens | Divisão de mensagem nativa |
| Refletir (think) | Nada. O modelo raciocina sozinho |
| Fila em `n8n_fila_mensagens` | Agrupamento nativo, ligado por padrão |
| Memória em `n8n_historico_mensagens` | Memória própria. **Não migra** |
| Trava em `n8n_status_atendimento` | Nativo no runtime |
| Etiqueta `agente-off` | O mesmo papel com o **sinal trocado**: `open` ou atribuída a uma pessoa. Ver a nota abaixo |

**A etiqueta troca de sinal, e é o erro mais caro do de-para.** Na v3, `agente-off` **presente** queria dizer robô calado. Na V4 quem cala o robô é a conversa estar `open` ou atribuída a uma pessoa, e `pending` é justamente o estado em que ele **age**. Ler a linha como "quem tinha a etiqueta vai para `pending`" liga a automação exatamente nas conversas em que alguém a tinha desligado. O sentido é: **com** etiqueta → `open`/atribuída; **sem** etiqueta → `pending`.

**Sobre o template de resposta**, que é o item mais fácil de esquecer e o mais caro: declare-o sempre que a API devolver mais do que o agente usa. Sem template, o corpo cru é cortado e um campo que fica depois do corte não chega como "faltando", chega como lacuna que o modelo preenche de cabeça. Campo que não voltou renderiza como `(not returned)`; **instrua o prompt a tratar esse texto como dado ausente**, nunca a deduzir.

**Status esperados**: pergunte à API, não ao usuário. Um "não encontrado" que volta 400 e não 404 vira falha de integração com alerta se você declarar só o 404.

---

## 4. Montar o agente

Igual à etapa 8, com quatro pontos do schema que não são adivinháveis:

- `meta` é **opcional**, mas não pela metade: existindo, os três campos (`exportedAt`, `exportedFrom`, `appVersion`) precisam estar lá, todos string. Bundle escrito à mão nasce com um `meta` incompleto, e é aí que o validador reclama. Montando a partir da v3, o mais honesto é **omitir**: copiar a data e a versão do sample inventa uma procedência que não existe.
- `agent.businessHours` e `agent.followUpHours` precisam existir, mesmo valendo `null`.
- Concessão de ferramenta HTTP é `{"source":"HTTP","tool":"<nome>","enabledTools":["<nome>"]}`, não só `enabledTools`.
- No `components.httpTools`, `outputSchema` e `ackEnabled` são obrigatórios.

Modelo pronto e validado por import: [`samples/agents/rui-transportadora-http.json`](../samples/agents/rui-transportadora-http.json), que é o menor bundle com ferramenta HTTP declarativa e template de resposta. Use-o como forma, não como conteúdo.

**Rode o import com `dry_run` antes.** É ele que devolve o nome do campo errado em um segundo, em vez de você descobrir por tentativa.

O agente nasce **desabilitado e em modo de teste**. O modo de teste vai até o cutover; o `enabled` sobe na seção 6, que explica o que ele destrava e o que exige junto.

**Horário de atendimento**: se a v3 tratava como texto no prompt, mantenha como texto. Configurar `business_hours` muda o comportamento (o agente deixa de responder fora da janela) e isso não é migrar, é redesenhar.

---

## 5. A credencial é o único passo de console

O import cria a credencial que falta como **pendente** e mantém a referência ligada, **quando o tipo dela pode nascer pendente**. Nem todo tipo pode, e a migração cai bem no que não pode: ferramenta HTTP da v3 que autentica por header ou por query precisa do nome do parâmetro, e OpenAI-compatível precisa da URL base, metadados que o bundle não carrega. Aí o import não falha: ele avisa e importa a ferramenta **sem credencial nenhuma**.

**Leia os avisos do import antes de seguir**, porque os dois pedem coisas diferentes:

- `credentialPending`: só falta o usuário preencher. O link **não vem no retorno do import**; pegue o `id` da entrada no `vault_list` e monte você mesmo.
- `credentialNotFound`: o tipo precisa de metadado que o bundle não tem, e a ferramenta entra sem credencial nenhuma.

**Esse segundo aviso você não espera acontecer, você prevê.** Ele só sai do import aplicado, então esperar por ele é importar errado de propósito. Quem responde antes é o `dry_run`, que devolve `credentialsNeeded` com `name` e `kind` de cada uma, e o `kind` decide sozinho: o import cria a entrada pendente passando **só nome e tipo**, então todo tipo que exige URL base (`openai_compatible`, `chatwoot_api_token`, `langfuse`, `mcp_oauth`) ou nome de parâmetro (`header`, `query`, `mcp_env`), mais os de OAuth gerenciado (`google_oauth`, `mcp_oauth`), falham **sempre**. Na migração da v3 os que aparecem são `header` e `query`, das ferramentas HTTP, e `openai_compatible`.

A ordem que funciona, então: rode o `dry_run`, leia os `kind` de `credentialsNeeded`, **cruze com o `vault_list`**, e crie com `credential_create` só as que faltam mesmo, passando `base_url` ou `param_name` conforme o tipo pede. Depois disso, aplique.

**Esse cruzamento não é zelo, é obrigatório.** `credentialsNeeded` lista tudo que o bundle referencia, sem olhar o cofre do destino: é a lista do que o agente usa, não a do que falta aqui. Num tenant que já tem coisa (e a migração cai justamente nesses, porque o Chatwoot já está lá), criar uma entrada que já existe com o mesmo nome e tipo devolve conflito e trava a criação.

**E o cruzamento é por metadado, não por existência.** A resolução no import casa por nome e tipo, só isso, e reusa a entrada que achar. Então uma entrada `header` que já existe com o mesmo nome mas apontando para outro parâmetro é aceita calada, e a ferramenta migrada passa a mandar o segredo no cabeçalho errado; com `openai_compatible`, o modelo vai falar com a URL errada. O `vault_list` devolve `baseUrl` e `paramName` justamente para isso: compare os dois antes de decidir que a entrada serve. Batendo, reuse. Não batendo, **pare e resolva com o usuário**, porque aquela entrada é de algo que já está rodando: ou ela está errada e quem corrige é ele no console, ou é outra credencial com o mesmo nome, e aí o que muda é o nome no bundle antes de importar. O que não existe aqui é reusar no escuro. Os dois de OAuth gerenciado são exceção e o `credential_create` também não os cria, porque é o mesmo caminho por dentro: aqueles vão pelo fluxo de conexão do console. E tendo aplicado antes de tudo isso, não repita o import: a ferramenta está lá com a referência vazia e falha na primeira chamada, então crie a credencial e ligue nela na própria ferramenta.

Preencher o segredo **não tem caminho de API**, por construção. O formato do link é `{baseUrl}/resources/vault?fill=<id da entrada>&switchTenant=<id numérico do tenant>`, e o **numérico** não é detalhe: o console compara esse parâmetro contra id, então o slug que serve no argumento `tenant` das tools não serve aqui. Com slug, o link não troca de tenant e a entrada não aparece.

Sem isso o playground não roda, então avise antes de chegar aqui.

**Nunca escreva o valor de um segredo numa mensagem, num log ou num arquivo.** Diga onde ele está e como obter. Se a chave da v3 servir (mesma conta, sem custo novo), diga isso ao usuário e deixe **ele** copiar.

---

## 6. Testar antes de virar a chave

**Duas camadas, e a segunda tem pré-requisito.**

**Playground** cobre prompt, modelo e ferramentas HTTP sem encostar no Chatwoot: sem vínculo, sem `enabled`. Esgote o playground antes de precisar de canal.

**Teste pelo canal** é o que exercita as ferramentas nativas (transbordo, etiqueta, atributo), a divisão de mensagem e o áudio. Ele precisa das duas coisas ao mesmo tempo:

- `enabled: true` **junto com** `mode: test`. O `enabled` é o que destrava a **resposta**, não o reconhecimento do comando: com o agente desligado o `/teste` é aceito do mesmo jeito, marca a conversa como ativada e devolve uma nota dizendo que o agente está desativado. Ou seja, testar com ele em `(false, test)` parece funcionar e não responde nada, e a conversa fica ativada para quando você ligar.
- Uma **caixa vinculada**, porque o `/teste` chega pelo webhook do Chatwoot.

**O par `(enabled, mode)` é estado, e ele atravessa as seções.** Sai da seção 4 como `(false, test)`, sobe para `(true, test)` aqui, e **volta para `(false, test)` ao fim desta seção**. Só o cutover o leva a `(true, production)`.

**E a caixa vinculada aqui é descartável, nunca a de produção**: uma `Channel::Api` criada para isso, ou um número que não é do cliente. Vincular a de produção antes do cutover já muda o status das conversas novas e some com elas da tela da equipe (seção 7).

O agente em modo de teste fica calado até alguém mandar `/teste` naquela conversa.

> **`/teste` e `/reset` colidem com a v3.** A v3 trata os dois comandos num nó que roda **antes** do filtro de etiquetas, então ela responde ao comando mesmo com `agente-off`. Pior: o `/reset` da v3 é um `DELETE FROM n8n_historico_mensagens WHERE session_id = <telefone>`. Testar a V4 com `/reset` **apaga a memória da v3 daquele contato, sem volta**, e fura o plano de rollback por dentro.
>
> **A caixa descartável não isola nada da v3.** O webhook dela é de conta e dispara para todas as caixas, então na conversa de teste as duas respondem e as ferramentas migradas rodam duas vezes, escrita inclusive. Cale a v3 pelo mecanismo dela: aplique `agente-off` na conversa de teste. E use um telefone sem linha em `n8n_historico_mensagens`, porque a etiqueta **não cobre os comandos**, que rodam antes do filtro.
>
> **Antes de testar em produção, dumpe as três tabelas da v3**, e combine com o usuário que o comando de limpar contexto na fase de teste não é o `/reset`. Esse dump tem o mesmo conteúdo do arquivo da seção 9, a conversa de todos os clientes, então vale a mesma regra: sai do `pg_dump` direto para a cifragem, sem um `.sql` intermediário no disco, e é do usuário. A diferença é o prazo, e ela é a favor: este aqui é rede de segurança de uma fase, não acervo, então combine na hora de criá-lo que ele é apagado quando o teste terminar.

Teste em **conversa descartável**, nunca nas conversas que a demonstração ou o cliente precisam. Apagar mensagem no Chatwoot deixa lápide que não sai.

Cubra todas as ferramentas da origem, uma a uma, e o ramo de erro de cada uma.

**Ao terminar, desfaça o teste antes de ir para o cutover**: desvincule a caixa descartável e devolva o agente para `enabled: false`. Não é higiene, é o que impede o passo seguinte de quebrar. Agente **habilitado em modo de teste** numa caixa de produção não fica calado de graça: ele **consome** a mensagem do cliente, marca como tratada, e deixa uma nota privada por conversa que ninguém está lendo naquela hora.

---

## 7. O cutover (etapa 9, ramificada)

**Aprove tudo antes de cortar.** Cada escrita desta jornada pede preview e OK do usuário, e pedir isso **depois** do passo 1 põe a espera dentro da janela de silêncio: uma dúvida dele, uma recusa na validação ou uma falha no vínculo estica a queda por tempo indeterminado. Rode os `dry_run` do `agent_update` e do `inbox_bind`, mostre o que vai acontecer, e peça o OK **do cutover inteiro** antes de encostar na v3. **E o passo 2 entra nesse mesmo pacote, porque ele também escreve.** Levantar as conversas em aberto e classificar cada uma pela régua da subseção é leitura pura: não há motivo para isso acontecer dentro da janela de silêncio, e acontecendo lá, cada dúvida do usuário sobre uma conversa custa minutos de produção sem ninguém atendendo. Faça o levantamento **antes do passo 1**, leve a lista classificada junto do resto para o OK, e deixe para a janela só o que ela precisa mesmo: reler a lista para pegar o que chegou no meio, e aplicar. **E o OK precisa cobrir o rollback junto**, porque ele também escreve: desvincular, devolver o par de estado, recriar o gatilho, repor o status das conversas. Aprovar só a ida deixa a volta sem autorização exatamente no minuto em que não dá para parar e perguntar. Depois disso os quatro passos correm sem parar para perguntar. **E se um deles falhar, o caminho não é parar para perguntar: é rolar de volta na hora** (seção 8) e só então relatar. Passado o passo 1, parar no meio deixa a produção sem ninguém atendendo, nem a v3 nem a V4, pelo tempo que a sua pergunta levar para ser respondida.

**A ordem não é estética. Quatro passos, nesta sequência:**

**Esta sequência pressupõe janela de baixo volume, e isso é pré-condição, não preferência.** Entre o corte e o vínculo ninguém atende, e a triagem leva minutos: mensagem que chega nesse intervalo fica visível na conversa, sem ninguém avisado. Quem não pode ter essa janela, uma operação de plantão ou 24/7, não segue isto direto: levante e classifique as conversas **antes** do passo 1, com a v3 ainda no ar, e deixe para a janela só reler a lista e aplicar. Encurta o intervalo ao mínimo sem inverter a ordem.

**Antes de tudo, confirme que a migração é do tráfego inteiro da v3.** Os dois caminhos de corte são globais: o webhook é **de conta** e o workflow é um só. Se a v3 atende alguma caixa que não entra nesta migração, cortar derruba o atendimento dela também, e não existe meia-dose aqui. Levante quais caixas a v3 serve e compare com as que vão ser vinculadas; sobrando alguma, **pare e diga ao usuário**: migração parcial não é esta jornada.

1. **Corte a v3** por um dos dois caminhos: apagar o webhook de conta no Chatwoot, ou desativar o workflow no n8n. Medido: ~120 ms. **Antes de apagar, anote o que o rollback vai precisar**: os eventos assinados, o id, e **qual dos dois caminhos você usou**, porque o rollback desfaz esse e só esse. **A URL não entra no registro**: webhook de n8n sem autenticação é credencial, e o guardrail de segredo vale para ela igual. Ela é redescobrível na hora, no nó de gatilho do workflow, que continua de pé.
2. **Trie as conversas em aberto**, e antes de qualquer vínculo. É a subseção logo abaixo. Ela vem aqui e não depois por um motivo mecânico: a partir do vínculo, mensagem que chega numa conversa `open` é registrada como tratada e some, e triagem leva minutos.
3. **Passe o agente para `(enabled: true, mode: production)`.** Os dois campos, e ainda sem caixa nenhuma vinculada: agente habilitado que não recebe entrega não faz absolutamente nada, então este passo não tem efeito visível. É de propósito.
4. **Vincule as caixas** (`inbox_bind`). **É este o passo que põe no ar**, e o único instantâneo da sequência.

**O corte para o que entra, não o que já entrou.** Execução que a v3 pegou segundos antes segue viva: ela termina, chama ferramenta e responde. Acontecendo depois do vínculo, o cliente recebe as duas respostas, que é justamente o que a ordem existe para evitar. Antes do passo 4, confirme que a v3 esvaziou: `n8n_fila_mensagens` sem linha pendente e a lista de execuções do n8n sem nada em andamento. A triagem costuma dar esse tempo sozinha, mas isso se verifica, não se assume.

**Por que a v3 sai primeiro.** Os dois caminhos são independentes e nenhum sabe do outro: o gate da V4 protege contra atendente humano, não contra a v3. Ligar a V4 com o webhook ativo faz o cliente receber tudo em dobro. O preço de cortar antes é uma janela de silêncio, e ela só é de segundos quando não há conversa aberta para triar. Havendo, são **minutos** (o passo 2 e a subseção dele). Continua sendo o lado certo para errar, mas é número que se combina com o usuário antes de marcar a hora, não depois.

**Por que habilitar antes de vincular, e não o contrário.** Porque a janela entre os dois não é neutra: ela **perde mensagem**. Vinculada a caixa, o Chatwoot já entrega ao bot, e com o agente ainda em `(false, test)` a entrega bate no portão de modo de teste, é **consumida e marcada como tratada**, e subir o `enabled` depois não reprocessa nada. O cliente escreveu, ninguém respondeu, e a mensagem não ficou esperando em lugar nenhum. Habilitando antes, a janela some e o `inbox_bind` vira a borda de entrada no ar.

> **O vínculo liga o bot no Chatwoot por conta própria**, e é por isso que ele é a borda. A associação nasce ativa (`agent_bot_inbox`: enum `{ active: 0, inactive: 1 }`, coluna com `default: 0`, o inverso do enum de `Conversation`). Assim que a caixa é vinculada, toda conversa nova nasce `pending`, e a visão padrão da barra lateral filtra por `open`: **conversa nova some da tela da equipe**, enquanto a v3 ainda responde. Nunca vincule "só para deixar preparado" na véspera.

### A triagem das conversas em aberto (passo 2)

A v3 nunca usou `pending`, então tudo que ela deixou aberto está em `open`. **A V4 só age em `pending`, e `open` não vira `pending` sozinho**: a transição que reabre em `pending` só roda em conversa **resolvida**.

Consequência medida: depois do cutover, o cliente que responde numa conversa já aberta **não recebe nada**, e não aparece erro em lugar nenhum.

E é pior do que ficar sem resposta: **cada mensagem que chega numa conversa `open` com o bot no ar é recusada pelo portão e marcada como tratada**. Ela não fica esperando, some da vista do agente para sempre. Por isso a triagem entra **antes do vínculo**, dentro da janela do cutover, e não depois. **O que entra na janela é aplicar, não decidir**: o levantamento e a classificação saem antes do passo 1, aprovados junto com o resto do cutover.

A régua é quem está devendo resposta:

| A conversa aberta espera | O que fazer | Por quê |
|---|---|---|
| Um humano da equipe | **Nada** | Resolver marcaria como concluído o que ninguém respondeu, e apagaria a fila de trabalho. A pessoa responde, resolve, e a próxima mensagem do cliente já entra em `pending` |
| O robô continuar o fluxo | Resolver, ou pôr em `pending` na mão | É a que morre calada |

**Nunca resolva em massa sem olhar.** Leia o fim de cada conversa antes de decidir.

**A janela de triagem é de silêncio real, e dura minutos.** Entre o corte da v3 e o vínculo, mensagem que chega não vai para lugar nenhum: a v3 não tem mais gatilho e a V4 ainda não recebe entrega. Ela não se perde, fica na conversa à vista da equipe, mas ninguém é avisado e o vínculo depois **não reprocessa** o que entrou nesse intervalo. Duas coisas encurtam o estrago: trie rápido, e **releia a lista uma última vez logo antes de vincular**, para pegar o que chegou enquanto você trabalhava.

**E o que caiu na janela precisa ser respondido na mão.** Mudar o status não processa mensagem nenhuma: o webhook daquele minuto não chegou a ninguém e não volta. Depois de vincular, liste as conversas com mensagem do cliente dentro da janela e sem resposta, e passe cada uma para um humano responder. Vale igual na janela do rollback.

### O que o agente herda de uma conversa antiga

Numa conversa que a V4 nunca atendeu, o primeiro turno recebe as mensagens de entrada da **página mais recente** da conversa, coalescidas. Três ressalvas para dizer ao usuário:

- Entra **só o lado do cliente**: a V4 herda o que o cliente pediu, nunca o que a v3 prometeu. O risco é contradizer um compromisso.
- É **uma página**, não a conversa inteira. Conversa comprida entrega o fim, não o começo.
- Vale só enquanto **nenhuma mensagem passou pelo portão**. O que o cliente escreveu com a conversa `open` e o bot no ar já foi marcado como tratado.

### Validação (etapa 10, ramificada)

Mande a primeira mensagem você mesmo, de um número que não é o de teste habitual. Depois fique olhando as primeiras conversas reais, uma a uma, na primeira hora.

**Leia a saúde de configuração que as próprias escritas devolvem, e não dê a migração por validada com alerta em pé.** `agent_create`, `agent_update`, `agent_clone`, `agent_import`, `agent_tools_set` e `agent_settings_set` devolvem `configHealth` na resposta da chamada que causou o problema, então o alerta chega em quem o causou, sem depender de alguém lembrar de olhar. Escrita que não é do agente não carrega o campo: o `inbox_bind` devolve a caixa e nada mais. Alerta ali é motivo de parar, não de seguir. O console continua entrando só para preencher segredo, que não tem caminho de API.

---

## 8. O rollback

Quatro passos na ordem inversa. Os três primeiros levam segundos; o quarto depende de quantas conversas mudaram de estado:

1. **Desvincule** as caixas (`inbox_bind` com agente nulo).
2. **`enabled: false` e `mode: test`.** Os dois: deixar em produção arma uma armadilha para a segunda tentativa, porque a seção 6 assume modo de teste e o agente passaria a responder tudo sem `/teste` no instante em que alguém revincular.
3. **Devolva o gatilho da v3 pelo mesmo caminho que o cortou**: recrie o webhook com os eventos anotados no passo 1 do cutover e a URL lida na hora, do nó de gatilho do workflow, ou reative o workflow no n8n. Recriar o webhook quando o corte tinha sido a desativação do workflow deixa a v3 parada com cara de restaurada, e ninguém percebe até o cliente escrever.

**E o passo 3 tem a mesma regra do cutover, só que virada.** Desvincular corta o que entra; o turno que a V4 já começou continua, porque ele já carregou cliente e ferramentas e vai até o fim chamando o que tiver que chamar. Devolvendo o gatilho no mesmo segundo, aquele turno termina com a v3 já viva, e o cliente leva as duas respostas, além dos efeitos externos que a ferramenta dele causar. Entre o passo 2 e o passo 3, confirme que não sobrou turno em andamento. É a mesma verificação da seção 7, e o custo dela é uma olhada.

Medido ponta a ponta: **14 segundos**, dos quais ~120 ms são a chamada que devolve o serviço da v3.

**O que de fato para a V4 é o desvínculo**, não o `enabled: false`: sem associação o Chatwoot não entrega nada ao bot. O desvínculo não deixa resíduo, e o bot fica lá para o próximo vínculo.

Recriar o webhook gera um secret novo, e isso não quebra a v3: o nó de gatilho dela é um webhook do n8n sem autenticação.

4. **Devolva para `open` as conversas que ficaram em `pending`.** Não é opcional e não acontece sozinho: desvincular tira o bot, e só. Ficam em `pending` as que a triagem pôs lá na mão e todas as que nasceram enquanto a caixa esteve vinculada, e a v3 nunca usou esse estado, então ninguém as atende. Pior, a visão padrão da equipe filtra por `open`: elas somem da tela em vez de voltar para a fila. Enumere as conversas do bot em `pending` e reponha o status.

**O que o rollback não desfaz**: mensagens que a V4 já mandou, atributos que gravou, etiquetas que aplicou. Liste as conversas que ela tocou e passe a um humano; não são caso de rollback, são caso de alguém olhar.

**A v3 continua inteira**: workflows, memória e credenciais intocados. Só o gatilho saiu, e ele volta.

---

## 9. A saída da v3 (depois, nunca agora)

A jornada termina com a V4 validada **e a v3 no ar**. Desligá-la é assunto de outro dia, e o encerramento escrito deve dizer isso ao usuário.

**O gatilho é evidência, não calendário:** o log de execuções do n8n em silêncio, a tabela de histórico parando de ganhar linha, e a V4 tendo exercitado em produção cada ferramenta que a v3 tinha.

**A ordem, do mais reversível para o menos:**

1. Desativar os workflows no n8n. Um clique, e já basta.
2. **Exportar os workflows e as três tabelas para arquivo.** É o passo que se esquece, e o único que preserva o histórico de conversa do cliente: a V4 não importa essa memória, aquele banco é a única cópia. **E esse arquivo é o contrário do que sai na seção 1.** Lá a projeção existe justamente para o segredo não viajar; aqui é despejo cru, com o literal cravado no nó e a conversa inteira do cliente em texto puro. Escolher a pasta não protege nada, e `chmod 600` também não: permissão vale contra outro usuário da máquina, não contra snapshot do provedor, backup do volume ou o disco em si. **Então o arquivo já nasce cifrado**, com o export indo direto para a cifragem em vez de passar por um `.json` no disco (`... | gpg -c` ou `age -p`, o que ele tiver). A senha é do usuário e vai pro cofre dele, e vale dizer o preço na hora: perdeu a senha, perdeu a única cópia do histórico do cliente. O arquivo é dele do começo ao fim, **não passa por você em momento nenhum**, e quem gera, guarda e move é ele. Antes do passo 4, que é irreversível, **confira o arquivo**: decifra com a senha que ele guardou, tem os workflows que a seção 1 listou, e a contagem de linhas de cada tabela bate com a do banco. Decifrar faz parte da conferência de propósito, porque senha que não abre e arquivo vazio dão no mesmo. Backup que ninguém leu não é backup.

   **E seja claro com o usuário sobre o que esse arquivo não é: ele guarda o que aconteceu, não reconstrói uma v3 funcionando.** O JSON de workflow referencia credencial por id e nome, não por valor (no export real da v3, `{"chatwootApi":{}}`), e os valores moram cifrados na tabela de credenciais do próprio n8n, que só abre com a chave de criptografia daquela instância. Passo 4 leva as duas coisas junto. Então, se o usuário quiser poder **rodar** a v3 de novo algum dia, o artefato é outro: dump do banco inteiro do n8n, ou do volume, **mais** a chave de criptografia. E a chave é segredo, então vai pro cofre dele, não para o lado do arquivo. Essa escolha é dele e se faz **antes** do passo 4, porque depois não tem a quem perguntar.

3. Parar o contêiner. É aqui que a RAM volta: medido, ~470 MiB entre n8n, o Postgres dele e os task-runners, com a v3 ociosa.
4. Apagar serviço e tabelas. Irreversível, e **nunca sem o passo 2**.

   **E antes, responda se aquele n8n é só da v3, porque a sondagem não respondeu isso.** Achar as três tabelas prova que a v3 mora ali, não que ela mora sozinha, e apagar o serviço leva junto workflow, credencial e histórico de execução de tudo que estiver na mesma instância. A resposta já está na mão: a listagem de `workflow_entity` da seção 1 mostra o que existe. Sendo só o pacote da v3, apagar o serviço é a opção mais limpa. Tendo qualquer outra automação ali, o serviço **fica de pé** e você apaga só os workflows da v3 e as três tabelas. Na dúvida sobre um workflow, ele não é da v3: pergunte antes de apagar.
