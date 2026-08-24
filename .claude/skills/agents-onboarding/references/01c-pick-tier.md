# 01c: Selecionar o tier de deploy + o contrato

Depois do inventário brownfield (1b) você sabe **o que já existe** na VPS. Agora escolha **a trilha de
deploy** (qual orquestrador sobe Chatwoot + fazer.ai agents + Langfuse com TLS) e siga só ela. As etapas 6 a 10 (a
**espinha**: `/setup` → MCP → import → bind → E2E) são **idênticas em qualquer tier**: elas
consomem o *resultado* do deploy, não se importam com *como* ele foi feito.

## Qual tier

O probe do 1b já revela o orquestrador instalado (fingerprint por imagem). Mapeie:

| Sinal na VPS (1b) | Tier | Trilha de deploy |
|---|---|---|
| **Coolify** saudável (ou usuário quer Coolify) | **A** | etapas 2-5 ([`02-coolify.md`](02-coolify.md) → `03` → `04` → `05`) |
| **Portainer** (ou usuário quer Portainer) | **B** | [`deploy-b-portainer.md`](deploy-b-portainer.md) |
| **Tudo o mais**: VM crua, ou um painel sem trilha dedicada (Easypanel, Dokploy, CapRover, …) | **C** | [`deploy-c-compose.md`](deploy-c-compose.md) |

Coolify ou Portainer presentes e saudáveis ganham (reusar > instalar; o 1b decide por serviço); **qualquer
outro painel cai no Tier C** (compose genérico, adaptado ao painel com seu conhecimento dele). Nenhum sinal
claro → **pergunte ao usuário**, não adivinhe.

> A trilha C (compose genérico) é mais nova que A/B; trate-a como primeira run guiada.

## O contrato de deploy (o que a trilha entrega à espinha)

Qualquer que seja o tier, o segmento de deploy termina quando **entrega exatamente isto**. A espinha
(6-10) não pede mais nada e não olha pra dentro do orquestrador:

1. **Três URLs HTTPS públicas**, com **DNS resolvido + TLS válido** (Let's Encrypt):
   - `agents.<domínio>` → agents (`GET /api/health` = 200).
   - `chatwoot.<domínio>` → Chatwoot (Pro ou OSS).
   - `langfuse.<domínio>` → Langfuse (recomendado; o E2E valida traces).
2. **agents subida com as duas roles de DB** (superuser p/ bootstrap+migrate, runtime **não-superuser**) e o
   env mínimo: `PUBLIC_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, os dois pares de URL
   (`MIGRATION_DATABASE_URL` = superuser; `DATABASE_URL` + `LANGGRAPH_DATABASE_URL` = runtime),
   `BRANDING_STORAGE_DIR`/`DOCUMENTS_STORAGE_DIR` no volume persistente, **réplica única**. O
   `scripts/gen-onboarding-env.ts` gera os secrets + URLs; os composes
   do repo já trazem o resto.
3. **agents acessível + `/setup` alcançável** em `${PUBLIC_URL}/setup` (o onboarding sobe com `SETUP_TOKEN_REQUIRED=false`, então o `/setup` **não pede token**; ver [`06-setup-and-mcp.md`](06-setup-and-mcp.md)).
4. **admin token do Chatwoot** obtível (via Rails runner) pro `deployment_connect`/bind da etapa 9.
5. **Langfuse com MinIO** (a ingestion v3 exige blob storage) + as chaves (public/secret) obtíveis.

Entregou os 5 → vá direto pra **etapa 6** (a mesma pra todos os tiers).

> **Chatwoot existente (`chatwootSource: existing` no marcador):** só **fazer.ai agents + Langfuse** a provisionar: `chatwoot.<domínio>` é a instância que **já está no ar** (não a crie nem lhe mexa; o item 1 e o deploy do Chatwoot da trilha do tier são pulados). O admin token (item 4) vem via **Rails runner** se a instância é on-box/alcançável por SSH; se for **off-box** (Chatwoot Cloud / outro host), o **usuário fornece** um admin API token (Chatwoot → Profile → Access Token). O bind (etapa 9) usa a URL pública + esse token.

## Invariantes (valem em todos os tiers)

- **`pgvector/pgvector:pg17`**, nunca Postgres puro: o schema roda `CREATE EXTENSION vector`.
- **Réplica única** do fazer.ai agents: os workers (scheduler/debounce/outbound) assumem um único líder; não escale o
  serviço `agents` pra >1 (ver o aviso no `templates/docker-compose.prod.yml`).
- **DNS antes do ACME**: o cert só emite com o A-record já resolvendo pro IP da VPS. Crie os A-records
  (etapa 1) e confirme a resolução com o poll `until [ "$(dig +short <sub>.<domínio> @1.1.1.1 | tail -1)" =
  "<VPS_IP>" ]; do sleep 15; done` **antes** de anexar o domínio no painel / subir o Caddy.
- **Quem ocupa 80/443**: se já há um proxy/ingress (Traefik do painel, nginx, um Caddy), o Caddy
  *bundled* do `templates/docker-compose.portainer.yml` **conflita**:
  reuse o proxy existente com `templates/docker-compose.prod.yml` (BYO-proxy).
  O 1b já sinaliza quem detém as portas.
- **Não sobrescreva `command:`** no serviço do fazer.ai agents: o CMD da imagem faz `bootstrap → migrate deploy →
  serve`. Um `command:` próprio quebra o boot.
- **agents → Chatwoot pela URL pública**: o `deployment_connect` funciona contra a URL **pública** do Chatwoot,
  sem gambiarra de rede interna (detalhe na gotcha de [`deploy-b-portainer.md`](deploy-b-portainer.md)).
