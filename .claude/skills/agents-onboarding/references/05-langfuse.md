# 05: Deploy do Langfuse (com MinIO obrigatório)

> **Avise o usuário onde você está:** o Langfuse é o **último serviço** do deploy (o painel que registra as conversas do agente). Diga que vai subir o Langfuse agora, é o último; ao terminar, confirme que o deploy dos serviços acabou e que agora vem a configuração do agente. Ver o princípio de narração em `SKILL.md`.

## NÃO use o one-click do Coolify

O template one-click declara os `LANGFUSE_S3_*` mas sobe **sem MinIO e com creds vazias**. Resultado: `POST /api/public/ingestion` dá **HTTP 500** (`Could not load credentials from any providers` → `Failed to upload events to blob storage`) e os traces **somem em silêncio**. Pior: `GET /api/public/projects` lê só o Postgres e retorna 200, então um "test connection" ingênuo **passa** e mascara a ingestion quebrada.

## Use o compose vendorado do repo

`templates/langfuse/docker-compose.coolify.yml`: topologia `langfuse` (web) + `langfuse-worker` + `postgres` + `redis` + `clickhouse` + **`minio`**, com as 3 famílias S3 (`EVENT_UPLOAD`/`MEDIA_UPLOAD`/`BATCH_EXPORT`) apontando pra `http://minio:9000` via as magic vars `SERVICE_USER_MINIO`/`SERVICE_PASSWORD_MINIO`. Deploy via `scripts/coolify.py create-service` (base64) + `set-fqdn` (abaixo). Detalhes e mapa magic-var↔env genérico: `templates/langfuse/README.md`.

## Fluxo headless-seed (você provisiona TUDO num deploy; o usuário só faz login)

Padrão oficial de headless-init do Langfuse, **validado empiricamente** (stack local com o compose deste template: o `LANGFUSE_INIT_USER` vira **OWNER** da org, o signup fica fechado desde o boot, o user semeado loga com `role:OWNER`, e as keys ingerem `207`). **Não deixe o signup aberto**: o Langfuse **não tem** o gate "primeiro-admin-depois-fecha" do Coolify/agents (`AUTH_DISABLE_SIGNUP=true` devolve `422` sempre, sem exceção pro 1º usuário), então signup aberto seria uma janela real pra qualquer um se cadastrar na instância exposta. Semeie tudo de uma vez:

1. **Gere os valores do seed.** Um par de keys `pk-lf-…`/`sk-lf-…`, um id de org e um de projeto (strings únicas), e uma **senha temporária forte com um símbolo** pro login do operador (a política do Langfuse exige um caractere não-alfanumérico em signup/troca; o seed e o login aceitam sem, mas gere com). O **e-mail é o do operador, e você já o tem: NÃO pergunte.** Reuse **exatamente o e-mail que o `chatwoot-admin.py provision` retornou** (etapa 3, campo `email`), pra ele ter um login só entre as ferramentas. **Nunca faça uma pergunta do tipo "qual e-mail você quer usar pro Langfuse/pro OWNER?"**: o admin do Chatwoot já foi resolvido com um e-mail, e é esse que vale aqui; perguntar de novo é retrabalho e confunde. Se por algum motivo você não tem o e-mail em mãos, re-rode o `provision` (etapa 3) pra relê-lo, nunca pergunte ao usuário.
2. **Semeie TUDO num deploy só** (o signup já nasce fechado: `AUTH_DISABLE_SIGNUP=true` é o default do template). Set na env do serviço (Coolify) ou no `.env` (genérico) e **deploy uma vez**:
   - `LANGFUSE_INIT_USER_EMAIL` (operador), `LANGFUSE_INIT_USER_NAME`, `LANGFUSE_INIT_USER_PASSWORD` (a senha gerada)
   - `LANGFUSE_INIT_ORG_ID`, `LANGFUSE_INIT_ORG_NAME`
   - `LANGFUSE_INIT_PROJECT_ID`, `LANGFUSE_INIT_PROJECT_NAME`, `LANGFUSE_INIT_PROJECT_PUBLIC_KEY` (`pk-lf-…`), `LANGFUSE_INIT_PROJECT_SECRET_KEY` (`sk-lf-…`)

   No boot o Langfuse cria o **usuário (OWNER da org) + org + projeto + keys**. O USER exige a ORG (por isso vão juntos); upsert **por id**, então re-deploy não duplica.
3. **Handoff explícito, com pausa (headless não é silencioso).** O Langfuse é semeado sem o usuário ver nada acontecer, então **anuncie** que o painel está no ar e **entregue o login**: a URL em **`/auth/sign-in`** (login, **não** signup), o **e-mail derivado** (o do admin do Chatwoot, etapa 3) e a **senha temporária gerada** (mostre a senha, é o único jeito de ele entrar), e peça pra **trocar no 1º acesso** pela UI. **Espere um "consegui entrar" antes de seguir** a run (não avance enquanto ele não confirmar o acesso). O seed é **create-if-not-exists** (validado: a troca de senha do operador **sobrevive** a redeploys, o `LANGFUSE_INIT_USER_PASSWORD` fica inerte), então a senha definitiva é a dele e nunca passou por você. Ele nunca abre "Settings → API Keys" nem copia key nenhuma.

Como **você gerou** as keys no passo 1, elas já estão na sua mão pra ligar no fazer.ai agents (abaixo). Um deploy, sem redeploy, sem ler `org_id` no Postgres, e o signup **nunca** ficou aberto.

## FQDN (preserve a porta)

`scripts/coolify.py set-fqdn --ssh root@<VPS_IP> --app-id <id> --fqdn https://langfuse.<seu-dominio>:3000` (ache o id com `list-apps`). O template mapeia o FQDN pra porta 3000 do container; **dropar o `:3000` quebra o routing**. Ver `gotchas.md`.

## Verifique a ingestion (health verde NÃO basta)

`scripts/langfuse-verify.py` POSTa um batch em `/api/public/ingestion` e exige **207/200** (não 500); as chaves são o par que você semeou, lidas de um arquivo `0600` (a secret key fora do argv):
```sh
echo '{"publicKey":"<pk-lf>","secretKey":"<sk-lf>"}' > langfuse.keys && chmod 600 langfuse.keys
python3 scripts/langfuse-verify.py ingestion --base-url https://langfuse.<seu-dominio>:3000 --keys-file langfuse.keys
```
Status 500 = quase sempre MinIO/S3 ausente.

## Ligue no fazer.ai agents (por MCP, `langfuse_connect`)

O wiring é **por MCP**, num tool só: `langfuse_connect` recebe `public_key`/`secret_key`/`base_url` **inline** (as keys que você semeou), cria a credencial no vault **já preenchida** (`kind:"langfuse"`, `{publicKey, secretKey}` + `baseUrl`) e liga o tracing no tenant-settings. É dry-run por padrão: revise o preview (keys redigidas) e reenvie com `dry_run:false` pra aplicar. Mesmo padrão do `deployment_connect` do Chatwoot (segredo de infra inline). Como as keys já existem, a credencial nasce **preenchida** (NÃO `pending`): uma entry pending não resolve o segredo e o tenant-settings rejeita com `credential ref not found`. (No vault o campo é `baseUrl` camelCase, ver `gotchas.md`; doc do tool em `docs/mcp.md`.)

> **Ao pedir o OK do usuário** pra aplicar, fale do benefício, não do mecanismo: "vou ligar o painel que registra as conversas do agente, pra você acompanhar e depurar depois". **Não** cite `langfuse_connect`/"tracing"/"tenant-settings"/keys. Frases boas × ruins em `guardrails.md`.

## Langfuse que já existe, chaves criadas pelo operador

Quando o Langfuse já está no ar e quem cria a API key é o operador (um projeto novo para mais um tenant, um Langfuse Cloud, um Langfuse que você não semeou), você não tem as chaves, então o `langfuse_connect` não serve. O caminho é a credencial pending: `credential_create` com `kind:"langfuse"` e o `base_url` do Langfuse, que devolve o `fillAt` **e um `fillHint`**. Repasse o `fillHint` ao operador junto com o link, no lugar de descrever os campos: o Langfuse imprime um bloco `.env` ao criar a key (Settings → API Keys → Create new API keys) e o formulário do console lê as duas chaves e a URL desse bloco colado inteiro no campo "Langfuse .env". Pedir para copiar a Public Key e a Secret Key uma a uma é o caminho longo e pula a URL. Depois que a entrada sair de `pending` no `vault_list`, ligue o tracing com `tenant_settings_update` (`langfuse: { enabled: true, credential_ref: <nome> }`).

## Resetar a senha do Langfuse (fora da UI, break-glass)

O caminho normal de troca de senha é a **UI do Langfuse** (o operador troca no 1º acesso; a troca sobrevive a redeploys, o `LANGFUSE_INIT_USER_PASSWORD` fica inerte). Só caia aqui quando o operador **perdeu o acesso** e não consegue logar pra trocar. O Langfuse v3 **não tem env/CLI** pra rotacionar a senha depois do seed: o único jeito é reescrever o hash **bcrypt** na coluna `users.password` do Postgres do Langfuse (o serviço `postgres` do stack do Langfuse). O Langfuse verifica com `bcryptjs`, que aceita o prefixo `$2b$` que o Bun emite (cost 12 = o mesmo do Langfuse).

Use o `scripts/langfuse-set-password.py` (não monte o `docker exec`/`psql` à mão): ele faz tudo numa conexão SSH só, com os payloads sempre por stdin (sem o footgun de aspas comidas/BOM que o `remote.py` existe pra matar), e **é dry-run por padrão** — confirma o schema read-only, gera o hash e imprime o `UPDATE` **sem escrever nada**. A senha **nunca** passa por argv (nem no `ssh`, nem no `docker exec`, nem no container): vai por stdin (arquivo `0600` ou prompt interativo). Ache os nomes reais dos containers com `docker ps` (sob Coolify ganham sufixo): o **`agents`** roda `…/agents-pro` (tem o Bun que gera o hash) e o **Postgres do Langfuse** é o `postgres` do stack do Langfuse — **NÃO** o Postgres do agents, **NÃO** o `coolify-db`.

```sh
printf '<NOVA_SENHA>' > /tmp/lfpw && chmod 600 /tmp/lfpw   # a senha fora do argv

# 1) DRY-RUN (não escreve): confirma users.password + gera o hash no container agents + mostra o SQL
python3 scripts/langfuse-set-password.py \
  --ssh root@<VPS_IP> --ssh-opts "-i ~/.ssh/fazer-ai-agents -o IdentitiesOnly=yes" \
  --agents-container <agents> --langfuse-pg <postgres-langfuse> \
  --email <email> --password-file /tmp/lfpw

# 2) APLICA (mutação): idem + escreve o UPDATE e confirma `UPDATE 1`
python3 scripts/langfuse-set-password.py \
  --ssh root@<VPS_IP> --ssh-opts "-i ~/.ssh/fazer-ai-agents -o IdentitiesOnly=yes" \
  --agents-container <agents> --langfuse-pg <postgres-langfuse> \
  --email <email> --password-file /tmp/lfpw --apply
rm -f /tmp/lfpw
```

O e-mail é o do operador (o mesmo do Chatwoot/seed). Depois do `--apply`, ele loga em **`/auth/sign-in`** com a nova senha.

> Isto **muta o banco do Langfuse** (não é o Postgres do fazer.ai agents): o script é dry-run por padrão de propósito — peça o **OK explícito** do operador antes do `--apply` e só rode quando ele pediu o reset. **Por baixo** ele confirma o schema (`\d users` tem `password : text` — validado ao vivo, Langfuse v3 + agents-pro), gera o hash com o Bun do `agents` (**não** no container do Langfuse: o `bcryptjs` dele mora num caminho pnpm interno que `require` não resolve de `/app`) e aplica via heredoc de delimitador aspado (o `$` do hash não sofre expansão). Fallback manual, se precisar sem o script: `docker exec -e NP='<senha>' <agents> bun -e 'process.stdout.write(await Bun.password.hash(process.env.NP,{algorithm:"bcrypt",cost:12}))'` pro hash, e `remote.py --in-container <postgres-langfuse> --exec 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' --script-file lf.sql` pro `UPDATE`.
