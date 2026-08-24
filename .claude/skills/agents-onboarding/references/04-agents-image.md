# 04: Deploy do fazer.ai agents

> **Avise o usuário onde você está:** o fazer.ai agents vem **depois do painel e do Chatwoot**; em seguida só falta o Langfuse. Diga que vai subir o fazer.ai agents agora e que leva alguns minutos; dê sinal de vida durante a espera longa e confirme ao terminar. Ver o princípio de narração (com a contagem que se ajusta ao caso real) em `SKILL.md`.

## Edição: Free ou Pro (lê o marcador PRIMEIRO)

Leia `~/.fazer-ai/onboarding.json` → `edition` (`free` | `pro`; ausente = `free`). É a escolha **explícita** do CLI; respeite-a. Eixo **independente** do `chatwootTier` (etapa 3).

- **`free`** → imagem **pública** `ghcr.io/fazer-ai/agents:latest` (default do compose, multi-arch amd64/arm64). **Sem** `docker login`, não seta `AGENTS_IMAGE`.
- **`pro`** → imagem **privada** no Harbor: `harbor.fazer.ai/agents/fazer-ai/agents-pro:latest`. Provisione a credencial **per-user** pelo **proxy do CLI** (`bunx @fazer-ai/agents hub registry-credential --apply --out harbor.secret`, robot per-user, grava o secret `0600` e imprime só o `username`), logue com `scripts/harbor-login.py login` (secret via `--secret-file harbor.secret`; protege o `$` do robot), e setar `AGENTS_IMAGE` pra esse path. **Nunca** logar o secret.
  - **Reuso (per-user):** se o Chatwoot também for Pro (etapa 3), é o **mesmo** `docker login`, não logar duas vezes.
  - **Tier A (Coolify):** setar a env `AGENTS_IMAGE` no serviço + registrar a Harbor registry credential no Coolify (igual ao Chatwoot Pro).
  - **Tier B/C (compose):** `export AGENTS_IMAGE=<imagem>` (ou no `.env`) antes do `docker compose up`.

## Compose

Use o `templates/docker-compose.coolify.yml` do repo via `scripts/coolify.py create-service` (lê o compose, base64-encoda, POSTa em `/api/v1/services`). Topologia: `agents` (imagem conforme a **edição** acima; o compose default é a Free) + `postgres` (`pgvector/pgvector:pg17`: NÃO postgres puro: o schema precisa de `CREATE EXTENSION vector`). Volume `storage:/app/storage`. Healthcheck `wget -qO- http://localhost:3000/api/health`.

## Magic vars (Coolify gera; NÃO setar à mão)

- `SERVICE_URL_AGENTS` → `PUBLIC_URL` e `CDN_URL`.
- `SERVICE_USER_DBUSER` / `SERVICE_PASSWORD_64_DBPASSWORD` → **superuser** (dono do Postgres) → `MIGRATION_DATABASE_URL`.
- `SERVICE_USER_APPDBUSER` / `SERVICE_PASSWORD_64_APPDBPASSWORD` → **app role** (não-superuser) → `DATABASE_URL` + `LANGGRAPH_DATABASE_URL`.
- `SERVICE_PASSWORD_64_JWTSECRET` → `JWT_SECRET`; `SERVICE_PASSWORD_64_ENCRYPTIONKEY` → `ENCRYPTION_KEY`.

## Persistência de branding/documentos (fix: já no compose)

```
BRANDING_STORAGE_DIR=/app/storage/branding
DOCUMENTS_STORAGE_DIR=/app/storage/documents
QUOTES_STORAGE_DIR=/app/storage/quotes
```
Sem isso caem em `./data/*` (FS efêmero do container) e logo/favicon (+ PDFs de documento) somem no redeploy. Já corrigido no `templates/docker-compose.coolify.yml`; **confira que está lá** (branding é refino manual opcional depois, em `/admin/branding`, mas a persistência precisa já estar no lugar).

`QUOTES_STORAGE_DIR` é o nome antigo de `DOCUMENTS_STORAGE_DIR` e continua sendo lido como fallback: numa instalação **existente** o valor foi congelado na criação e nunca recebe o nome novo, então tirar a linha manda os PDFs para o FS efêmero, em silêncio. Instalação nova pode ficar só com `DOCUMENTS_STORAGE_DIR`.

## Boot = CMD da imagem (NÃO sobrescrever `command`)

A sequência `bootstrap → migrate deploy → serve` é o CMD do Dockerfile. **Não** declare `command:` no compose (sobrescrever crash-loopa). Detalhe em `gotchas.md`.

## FQDN + 503 + verificação

O `SERVICE_FQDN_*` não dirige o Traefik; quem roteia é a linha em `service_applications` (ver `gotchas.md`). Ache o id e seta o FQDN:
```sh
python3 scripts/coolify.py list-apps --ssh root@<VPS_IP>            # ache o id do agents
python3 scripts/coolify.py set-fqdn  --ssh root@<VPS_IP> --app-id <id> --fqdn https://agents.<seu-dominio>
python3 scripts/coolify.py api-post  --base-url http://<VPS_IP>:8000 --token-file coolify.token --path /services/<uuid>/restart
```
Antes do DNS resolver, verifique o routing por sslip.io: `curl http://agents-<service-uuid>.<VPS_IP>.sslip.io/api/health`. Depois do `/setup` (etapa 6) o app responde em `https://agents.<seu-dominio>`.
