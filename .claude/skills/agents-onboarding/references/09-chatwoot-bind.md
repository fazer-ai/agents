# 09: Plugar o Chatwoot no fazer.ai agents

> **Havendo uma Secretária v3 atendendo essas caixas, este passo é um cutover** e a ordem é obrigatória: cortar a v3, **triar** as conversas em aberto, passar o agente para `(enabled: true, mode: production)`, e só então `inbox_bind`. Ligar o bot com o webhook da v3 ativo faz o cliente receber tudo em dobro; vincular na véspera já muda o status das conversas novas; e vincular com o agente ainda em `(false, test)` **consome** a mensagem que chegar antes de você habilitar. O vínculo é o último passo porque é ele que põe no ar. Ver [`migracao-v3.md`](migracao-v3.md) seções 7 e 8.

> **Ao pedir o OK do usuário** para aplicar (cada `dry_run:false` abaixo), descreva o efeito, não a tool: "vou conectar o seu Chatwoot ao agente e ligar o robô na caixa de entrada, pra ele começar a responder as conversas". **Não** cite `deployment_connect`/`inbox_bind`/`webhook`/"Agent Bot". Frases boas × ruins em `guardrails.md`.

Sequência MCP-first. As tools de deployment são `mcp:admin` (SUPER_ADMIN); `inbox_bind` é `mcp:write`. O admin token do Chatwoot **não é credencial de vault** (é guardado encriptado na linha do deployment), então **não** use o fluxo de pending/deeplink dele. Há dois caminhos pra entregá-lo, conforme quem tem o token (o **mesmo** vale para `chatwootSource: existing`, Chatwoot BYO): se a instância é on-box/alcançável por SSH, o agente pega o token via Rails runner (Caso A); se é off-box (Chatwoot Cloud / outro host), o usuário fornece o token (Caso B).

## 1. Conectar o deployment

### Caso A: o agente provisionou o Chatwoot (tem o token)

O agente extraiu o admin token via Rails runner (etapa 3), então registra direto por MCP, em uma chamada:

```jsonc
deployment_connect { "base_url":"https://chatwoot.<seu-dominio>", "admin_token":"<token cru>" }  // dry_run:false pra aplicar
```

O token é usado in-band e **redatado no audit** (o audit guarda só metadados). Valida via `/profile`, **persiste o deployment** (URL + token criptografado na linha do deployment) e retorna as contas alcançáveis. Ainda **não** conecta as contas: isso é o passo 2.

Passar o `admin_token` cru como argumento aqui é o **caminho sancionado**, não um vazamento: o audit redige server-side e a tool nunca devolve o token. **Não recuse** por "segredo no argumento" nem invente pending/deeplink (o admin token não é de vault); leve o token do arquivo `0600` (`chatwoot-admin.json`) pro argumento **sem** `cat`/print (ver `guardrails.md` › Segredos).

### Caso B: traga seu próprio Chatwoot (só o usuário tem o token)

O agente **não** tem o token. Em vez de inventar credencial pending (o token nem é de vault), o agente **linka o usuário pra `/channels?connect=<base_url_do_chatwoot>`** — o deep-link já abre o modal "Connect instance" (SUPER_ADMIN) com a **Base URL preenchida**, faltando só o token: o usuário cola o Admin access token (validado via `/profile`, guardado encriptado). **Onde achar o token no Chatwoot:** `<base_url_do_chatwoot>/app/accounts/1/profile/settings` → seção **"Access Token"** (copie o valor; conta 1 no install padrão, mas o token é do usuário, então qualquer conta que ele acesse serve). O usuário pode seguir ali pelo "Manage accounts" e pelo bind de inbox, ou devolver pro agente continuar via MCP.

## 2. Conectar a conta + sincronizar inboxes (`deployment_set_accounts`)

```jsonc
deployment_set_accounts { "account_ids": [1] }   // dry_run:false pra aplicar
```

Conecta as contas selecionadas (cria a instância + sincroniza os inboxes pra agents) e soft-desconecta as de-selecionadas. **É este passo que conecta as contas** (o `deployment_connect` só registrou o deployment e listou as contas).

## 3. Bindar o inbox ao agente (`inbox_bind`)

> **Pré: o inbox precisa existir no Chatwoot.** Se o usuário ainda não criou a caixa de entrada (WhatsApp, widget de site, etc.), entregue o **link direto da página de criação**, nunca "vá em Configurações → Caixas de entrada": `<base_url_do_chatwoot>/app/accounts/<accountId>/settings/inboxes/new` (conta 1 no install padrão). O deep-link abre direto o assistente de novo canal; o usuário cria o inbox e volta pro bind. O mesmo link também está na tela **Canais** do console (botão "Criar caixa de entrada no Chatwoot", por conta).

> **Se o canal for WhatsApp pela API oficial (Cloud API), o trabalho pesado acontece ANTES do assistente.** O Chatwoot só pede o que a Meta já emitiu (`phone_number_id`, `business_account_id` da WABA e o token permanente); criar o app na Meta, verificar o número e gerar o token é um fluxo à parte, do lado da Meta, e nenhuma tool do MCP alcança isso (nem a inbox em si: ela nasce no assistente, como acima). Entregue ao usuário o passo a passo gratuito da comunidade, que vai da criação do app na Meta até a inbox pronta no Chatwoot: [WhatsApp com API Oficial no Chatwoot (fluxo manual)](https://www.lucasmoreira.ai/c/conteudos-exclusivos/whatsapp-com-api-oficial-no-chatwoot-fluxo-manual-9ae92651-f21b-40dc-a7b1-2ff7d680e0e5?utm_source=agents&utm_medium=skill&utm_campaign=agents-onboarding). Ele volta pro bind quando a inbox existir; o bind é o mesmo em qualquer canal.

```jsonc
inbox_bind { "inbox_id":"<id do inbox no fazer.ai agents>", "agent_id":"<id do agente>" }   // dry_run:false pra aplicar
```

O bind **provisiona/conecta o bot do agente no Chatwoot** (Agent Bot + webhook `/v1/chatwoot/webhook/:routeToken`); o `routeTokenHash`/`inboundSecretRef` ficam encriptados no fazer.ai agents e **nunca** saem no export. Não precisa setar `webhook_url` à mão. Verifique: bot-status do inbox = `active`.

## Só MCP (nada de REST à mão)

O fazer.ai agents expõe endpoints REST equivalentes por baixo (o que a tela `/channels` chama), mas **não os chame à mão**: as tools MCP `deployment_connect`/`inbox_bind` são o único caminho (regra MCP-only, ver `SKILL.md` e `06-setup-and-mcp.md`).
