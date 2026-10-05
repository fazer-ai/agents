# Licenciar a instância Chatwoot no hub (Kanban/Pro)

Habilita as features **Pro** (Kanban etc.) numa instância Chatwoot **Pro já deployada**. Duas coisas são
necessárias e **distintas**:

- A **imagem Pro** (`harbor.fazer.ai/chatwoot/fazer-ai/chatwoot-pro`) traz o **código** do **Kanban**. (O
  WhatsApp nativo já vem no fork OSS público, então não é o que distingue o Pro.) Sem a imagem Pro, não há Kanban.
  A edição é escolhida no deploy (ver [`03-chatwoot-pro.md`](03-chatwoot-pro.md)).
- A **assinatura no hub** dá a habilitação em runtime: **imagem Pro sem assinatura ativa = features
  travadas.** Por isso existe o passo do Refresh (não é restart de container).

## Quando: happy-path se há licença

A edição é decidida **no deploy** pelo marcador do CLI `~/.fazer-ai/onboarding.json`
(`chatwootTier` + `chatwootLicenseId`), com fallback pro `hub licenses` se o marcador faltar:
- **`chatwootTier: "pro"`** (ou, sem marcador, há licença CHATWOOT no hub) → deploy da **imagem Pro** e **estes passos são happy-path**: registrar (pelo **UUID**) + atachar (use `chatwootLicenseId`) + Refresh + ligar o Kanban na conta. Não pule.
- **`chatwootTier: "community"`** (ou, sem marcador, sem licença) → deploy da imagem **OSS** (sem Kanban) e segue; nada a fazer aqui.
- **`chatwootSource: "existing"`** (Chatwoot BYO, sem `chatwootTier` no marcador) → detecte Pro/OSS pela **imagem** (etapa 1b); não assuma Pro. Um Pro existente **sem** Kanban pode ser licenciado por estes passos, mas **não é forçado** (só se o usuário quiser); OSS não tem Kanban.

> **Sem licença e o usuário quer Kanban?** Sugira virar membro Pro da comunidade do Lucas Moreira
> ([lucasmoreira.ai](https://lucasmoreira.ai)): ganha licença grátis do Kanban (1 conta no plano mensal,
> 2 ilimitadas no anual). Depois é só rodar o CLI de novo e escolher "já me tornei membro" pra a nova
> licença aparecer; ou seguir em OSS.

> Pré-requisitos: `FRONTEND_URL` setado no container do Chatwoot (vira o host que identifica a instância e
> gateia o Refresh). As ops do hub saem pelo **proxy do CLI** (`bunx @fazer-ai/agents hub …`), que usa
> o OAuth do `~/.fazer-ai/oauth.json` do bootstrap (sem hub MCP na sessão); se ele expirou (erro de auth),
> o operador re-roda o CLI. Writes do hub são **dry-run por padrão** (aplique com `--apply`); mexa só na sua
> própria licença/instância (ver `guardrails.md`).

## Passos

> **Ao pedir o OK do usuário** para aplicar (passos 2 a 5), fale em linguagem de usuário: "vou ativar o seu plano Pro nesta instalação e ligar o Kanban no Chatwoot". **Não** cite `attach-license`, "Refresh da assinatura", "habilitar a feature na conta", "idempotente" nem os comandos: são o seu mecanismo. Frases boas × ruins em `guardrails.md`.

> **O Kanban depende de TRÊS coisas, todas necessárias** (por isso os 5 passos): (a) a **imagem Pro** (código, decidido no deploy); (b) a **assinatura casada** no hub (passos 1 a 4: a licença atachada à instância certa + Refresh que grava o token); (c) a **feature ligada na conta** (passo 5). Cada uma sozinha não basta: assinatura casada com a feature desligada na conta = Kanban invisível. É a pegadinha nº 1.

1. **Identidade da instância.** Pegue o identificador que o hub casa, direto do Chatwoot (read-only, sem hub):
   ```sh
   python3 scripts/chatwoot-admin.py installation-id --ssh root@<VPS_IP> --container <chatwoot-rails-container>
   ```
   Devolve `installation_identifier` (o **UUID de instalação**) + `frontend_url` (o host). **O hub casa a instância pelo `installation_identifier` (UUID), NÃO pelo host**, o host é só metadado que o ping preenche depois. Use o **UUID** como `--identifier` no passo 2. (Criar a instância com o host é a causa clássica de "assinatura verifica mas o Kanban não vem": o ping manda o UUID, não casa com a instância criada pelo host, e o hub responde inativo.)
2. **Instância no hub.** Liste e reuse a instância cujo `identifier` == o **UUID** do passo 1; crie só se faltar (dry-run primeiro; `--apply` pra valer):
   ```sh
   bunx @fazer-ai/agents hub instances
   bunx @fazer-ai/agents hub create-instance --identifier <installation_identifier UUID> --apply
   ```
   O ping **não** auto-cria a instância no hub: ela precisa existir (com o UUID) antes de casar. Uma instância com `host: null` / `metadata: null` em `hub instances` = nunca recebeu ping (identifier errado): não atache a licença nela.
3. **Atacha a licença** (uma feature por instância; os tipos têm que bater). O `--instance` é o id da instância do UUID (passo 2), não o número:
   ```sh
   bunx @fazer-ai/agents hub attach-license --license <licença CHATWOOT> --instance <id> --apply
   ```
4. **Refresh + verify da assinatura** (o botão "Refresh" do super admin) via `scripts/chatwoot-admin.py`, que roda o job e reporta o estado da assinatura (NÃO despeja valores crus que poderiam ser segredo):
   ```sh
   python3 scripts/chatwoot-admin.py refresh-subscription --ssh root@<VPS_IP> --container <chatwoot-rails-container>
   ```
   **`jitter_applied: true` é obrigatório** (o script já passa). Sem ele, o job só se reagenda (janela determinística de até 30 min) e o sync nem roda.

   **Leia a saída e só siga se a assinatura vier ATIVA: não basta o comando ter rodado, nem `VERIFIED_AT` estar preenchido.** O sinal real é o bloco `subscription`: verde = `token_present: true` **E** `subscription_active: true` **E** `kanban_enabled: true`. **Uma recusa 403/inativo do hub AINDA grava `VERIFIED_AT` e limpa o token**, então "existe uma chave `FAZER_AI_SUBSCRIPTION_*`" ou "`SYNC_ERROR_MESSAGE` nil" **não** provam nada. Interpretação das falhas:
   - `token_present: false` (com `SYNC_ERROR_MESSAGE` nil) → o hub respondeu **inativo**: a licença não está atachada à instância do **UUID** certo. Volte aos passos 1 a 3 (confira o casamento por UUID) antes de seguir. Não declare a assinatura ativa.
   - `SYNC_ERROR_MESSAGE` preenchido → o hub **recusou** ou não respondeu. Se for "hub não respondeu" (transitório), re-rode o Refresh; senão trate a causa (`FRONTEND_URL`, attach).
5. **Ligar o Kanban na conta** (a ativação por-conta que a assinatura só autoriza) via `scripts/chatwoot-admin.py`:
   ```sh
   python3 scripts/chatwoot-admin.py enable-kanban --ssh root@<VPS_IP> --container <chatwoot-rails-container>
   ```
   Liga o flag da feature na conta do onboarding (a primeira conta; use `--account-id` só num brownfield multi-conta). A validação do próprio Chatwoot roda um sync fresco e **recusa se a assinatura não conceder o Kanban**, então este passo, além de ativar, **prova a cadeia inteira** licença/instância. Idempotente (no-op se já ligado).

   **Só dê o 9b por concluído com `kanban_feature_enabled: true`.** O script sai com erro (exit 1) se não conseguir ligar; leia o `enable_error`:
   - `kanban_feature_not_available` → a assinatura não está concedendo o Kanban: a instância/licença não casou (volte aos passos 1 a 4, confira o UUID). Este é o erro que expõe o identifier errado do passo 1.
   - `kanban_account_limit_reached` → o limite de contas da licença já foi atingido por outras contas; num onboarding novo não deve acontecer.

   Confirmação visual do mesmo estado: no super admin (`/super_admin/settings`), "fazer.ai Subscription" fica ativa e o board de Kanban aparece no Chatwoot da conta.

## Erros comuns

- **`hub …` diz que "o hub não respondeu ao refresh da sessão" / instabilidade:** é **transitório** (a
  sessão segue válida; o refresh token nem foi consumido): **rode o MESMO comando de novo** em instantes.
  Só **"sessão expirada/ausente"** (erro de auth real) pede re-rodar o CLI de onboarding pra logar no
  browser. Em nenhum dos casos contorne o `hub` indo por REST/MCP por fora: ou re-tenta, ou re-loga.
- **Instância criada com o host em vez do UUID:** o ping manda o `installation_identifier` (UUID), não casa
  com a instância do host, e o hub responde inativo (token nunca grava). Sintoma: `hub instances` mostra a
  instância com `host: null` / `metadata: null` e o Refresh dá `token_present: false`. Crie/reuse a instância
  do **UUID** (passo 1) e mova a licença pra ela (`attach-license --instance <id do UUID>`).
- **Kanban não aparece com imagem Pro e assinatura ativa:** faltou o **passo 5** (ligar a feature na conta).
  A assinatura só autoriza; o flag por-conta é separado. Rode `enable-kanban` e confirme `kanban_feature_enabled: true`.
- **Kanban não aparece + assinatura não ativa:** faltou o **passo 4** (Refresh) ou ele não veio verde
  (`token_present`/`subscription_active`/`kanban_enabled`). A imagem traz o código; a assinatura libera em
  runtime. Confira o casamento por UUID (passos 1 a 3) e re-rode.
- **`FRONTEND_URL` vazio:** o controller do Refresh recusa, e o `installation_host` enviado ao hub fica
  vazio. Sete antes.
- **403 / inativo no `/api/ping`:** a licença não está atachada à instância certa no hub. Confira
  `bunx @fazer-ai/agents hub get-license --license <id>` / `hub get-instance --instance <id>` (casamento pelo **UUID**, não pelo host).
- **Assinatura "out of sync" > 3 dias:** o job auto-desativa (`auto_deactivate_if_stale`). Rode o Refresh
  pra re-sincronizar.

OSS não tem nada disso (sem Kanban). Migrar OSS → Pro = re-deploy com a imagem Pro + estes passos.
