# 01b: Inventário brownfield (sondar antes de instalar)

A VPS pode chegar vazia (**greenfield**) ou já com Coolify e/ou Chatwoot e/ou Langfuse e/ou a própria agents, em **qualquer combinação** (**brownfield**). Antes de instalar qualquer coisa (etapas 2 a 5), **sonde** o que já existe e decida **por serviço**: reusar, instalar, ou sinalizar incompatibilidade. É isso que torna as etapas de deploy **idempotentes** (só provisionam o que falta) e **não-destrutivas** (nunca apagam o que o usuário já tem).

## 1. Sondagem (read-only, não muta nada)

Rode na VPS via SSH (etapa 0). Tudo aqui é leitura (`docker ps/inspect`, `ss`, `curl`, `df/free`). O probe tem `{{…}}`, `$()`, aspas aninhadas e múltiplas linhas: **não monte isso inline no `ssh <host> '…'`** (no PowerShell as aspas são comidas e a here-string ganha BOM → o bash quebra; ver `gotchas.md`). **Escreva o probe num arquivo `recon.sh`** e rode pelo `scripts/remote.py`, que entrega byte a byte em qualquer SO:

`recon.sh`:
```sh
sec(){ printf '\n### %s\n' "$1"; }
sec OS;        ( . /etc/os-release && echo "$PRETTY_NAME" )
sec RESOURCES; free -h | awk 'NR==2{print "mem "$2"/"$7" avail"}'; df -h / | awk 'NR==2{print "disk "$2"/"$4" free"}'; echo "cpu $(nproc)"
sec DOCKER;    docker --version || echo absent
sec CONTAINERS; docker ps -a --format '{{.Names}}	{{.Image}}	{{.Status}}	[{{.Label "com.docker.compose.project"}}]'
sec PORTS;     ss -tlnp | awk 'NR>1{n=split($4,a,":");print a[n]}' | sort -un | tr '\n' ' '; echo
sec COOLIFY;   curl -s -m5 -o /dev/null -w 'api8000=%{http_code}\n' http://localhost:8000/api/health
sec IMAGES;    docker ps -a --format '{{.Image}}' | sort -u | grep -iE 'coolify|chatwoot|langfuse|agents|pgvector|clickhouse|minio|traefik|caddy|nginx|n8n'
sec V3;        for c in $(docker ps --format '{{.Names}} {{.Image}}' | grep -iE 'postgres|pgvector' | awk '{print $1}'); do
                 u=$(docker inspect "$c" --format '{{range .Config.Env}}{{println .}}{{end}}' \
                   | sed -n 's/^POSTGRES_USER=//p'); u=${u:-postgres}
                 for db in $(docker exec "$c" psql -U "$u" -d postgres -tAc \
                     "select datname from pg_database where datallowconn;" 2>/dev/null); do
                   docker exec "$c" psql -U "$u" -d "$db" -tA -F' ' -c \
                     "select table_schema, count(*), string_agg(table_name, ',' order by table_name)
                        from information_schema.tables
                       where table_name in ('n8n_historico_mensagens','n8n_fila_mensagens','n8n_status_atendimento')
                       group by table_schema;" 2>/dev/null \
                   | while read -r sch n t; do
                       if [ "$n" = 3 ]; then echo "v3 $c/$db schema=$sch: $t"
                       else echo "parcial $c/$db schema=$sch: $n de 3: $t"; fi
                     done
                 done
               done
```

```sh
python3 scripts/remote.py --ssh root@<VPS_IP> --ssh-opts "-i <chave>" --script-file recon.sh
```

> **Tier B (Portainer):** quando a plataforma é Portainer, a sondagem é **via API do Portainer** (`GET /api/stacks`, `GET /api/endpoints/{id}/docker/containers/json`), não `coolify-db`. A lógica é a mesma (fingerprint por imagem + matriz da seção 3); use `scripts/portainer-brownfield.py` (já detecta quem ocupa 80/443 → se há ingress, o Caddy bundled conflita, reusar ou ir de `templates/docker-compose.prod.yml` BYO-proxy). Ver [`deploy-b-portainer.md`](deploy-b-portainer.md). **A sondagem da v3 não vem de graça aqui**: o `portainer-brownfield.py` faz fingerprint por imagem e não consulta banco nenhum, então ele não enxerga as três tabelas. Em Portainer, pergunte pela v3 explicitamente e rode a checagem das tabelas à mão, no contêiner de Postgres que a listagem da API mostrar.

## 2. Ler os sinais

**Identifique o serviço pela IMAGEM, não pelo nome do projeto** (é um UUID opaco). Fingerprints:

| Serviço | Imagem (fingerprint) | Saúde = todos healthy | Versão |
|---|---|---|---|
| **Coolify** | `coollabsio/coolify` (+ `coolify-db`/`-redis`/`-realtime`, `-proxy`=`traefik`) | container `coolify` + API `:8000`=200 | tag da imagem (ex. `:4.1.2`) |
| **Chatwoot** | imagem com `chatwoot` (+ `sidekiq`, e `baileys-api` para WhatsApp) | `chatwoot` + `sidekiq` Up | tag (`:latest` → ver via `/version`) |
| **Langfuse** | `langfuse/langfuse` (+ `-worker`, `clickhouse`, **`minio`**) | web+worker+clickhouse+minio Up | tag (ex. `:3`) |
| **fazer.ai agents** | `ghcr.io/fazer-ai/agents` (+ `pgvector`) | container Up + `/api/health` | tag |
| **Secretária v3** | `n8nio/n8n` (+ `n8nio/runners`), **e** as tabelas `n8n_historico_mensagens`, `n8n_fila_mensagens`, `n8n_status_atendimento` no Postgres dele | container Up | tag |

As portas das apps **não** ficam expostas no host (atrás do Traefik); só Coolify (`:8000`) e o proxy (`:80`/`:443`) escutam. `curl localhost:80` sem o Host certo dá 404/503 (esperado). Pra health de uma app, use o FQDN dela.

## 2b. Achou n8n com as três tabelas: é uma Secretária v3

As três tabelas juntas (`n8n_historico_mensagens`, `n8n_fila_mensagens`, `n8n_status_atendimento`) são a assinatura: é a v3 rodando, não um n8n qualquer. **A v3 não entra na matriz da seção 3**: ela não é serviço para reusar nem para instalar, é a configuração do agente do usuário morando em outra ferramenta, e vira **fonte de leitura** para a etapa 8.

**Juntas quer dizer as três, no mesmo schema, e é isso que a sondagem imprime como `v3`.** Uma ou duas saem como `parcial`, e `parcial` não é v3: pode ser uma v3 meio desmontada, um banco compartilhado com outra coisa, ou um nome parecido por coincidência. Nesse caso não entre na migração, pergunte ao usuário o que é aquilo. Ir para a jornada de migração com base em uma tabela solta custa caro no fim, porque a seção 7 desliga o que ela acredita ser a v3.

Achando, **ofereça a migração como caminho padrão** e siga [`migracao-v3.md`](migracao-v3.md). A alternativa (montar o agente do zero, ignorando a v3) é escolha legítima de quem acha o próprio prompt ruim, mas o usuário precisa dizer isso explicitamente. **Desligar a v3 não é opção nesta jornada em hipótese nenhuma**: ela intacta é o plano de rollback, e sai de cena depois, com a V4 provada.

**Não achou o n8n aqui, pergunte assim mesmo.** A v3 pode estar em outra VPS: "você já roda a Secretária v3, aqui ou em outro servidor?".

**Estando em outro servidor, o que importa não é onde o n8n roda, é qual Chatwoot ela atende.** O cutover troca quem responde **numa conta de Chatwoot**, então ele só existe se a V4 for vinculada àquela mesma conta, com as caixas e as conversas que já estão lá. Levante a **URL** dela, porque a jornada precisa entrar no caminho de Chatwoot **existente**. O token não: esse é o Caso B do [`09-chatwoot-bind.md`](09-chatwoot-bind.md), em que o agente não recebe o token e manda o usuário colá-lo no console pelo deep-link. Pedir o token aqui é o caminho curto que põe um admin token no transcript.

**E o Chatwoot é só metade: a v3 mora numa VPS que não é esta.** Ler os workflows, drenar a fila e desativar o gatilho pedem acesso àquele servidor, e o escopo desta jornada é a VPS que o usuário indicou, só ela. Então isso se resolve **antes** de prometer a migração, e tem dois desfechos legítimos: o usuário autoriza explicitamente a segunda VPS, e ela passa a ser alvo declarado, ou ele não autoriza, e aí a migração é **operada por ele**, com você entregando o que extrair e o roteiro de cutover para ele executar. O que não existe é a terceira via de tocar em servidor que ninguém liberou. Deixar a matriz da seção 3 classificá-lo como ausente provisiona um Chatwoot novo e vazio, e aí não há cutover a fazer: há uma migração de canal, que é outro trabalho e outra conversa com o usuário.

**Se o `onboarding.json` já marcou `chatwootSource: "new"`, pare aqui e resolva com o usuário.** O marcador é escolha explícita dele e a seção 1 manda respeitá-lo, então não invente um inventário que o contradiz: as duas leituras são incompatíveis e só ele decide qual vale. Subir um Chatwoot novo é legítimo, só não é cutover, e ele precisa saber que está escolhendo entre as duas coisas.

## 3. Matriz de decisão (por serviço)

- **Ausente** (nenhum container com o fingerprint) → **instala** do zero (etapa do serviço).
- **Presente + saudável + compatível** → **reaproveita**: capture endpoint/UUID/FQDN pro state, NÃO recrie (a etapa do serviço vira no-op + captura).
- **Presente + não-saudável** (container existe mas não Up/healthy) → **pare e sinalize**: investigar/consertar antes de prosseguir; nunca instalar por cima.
- **Presente + incompatível** → **pare e sinalize ao usuário** (atualizar / migrar / instalar em paralelo, decisão dele). Ver compatibilidade abaixo.

Greenfield = tudo ausente = instala tudo. O resultado é um inventário por serviço (`ausente | reusar | sinalizar`) que dirige as etapas 2 a 5.

## 4. Compatibilidade (o que torna "presente" em "incompatível")

- **Chatwoot OSS vs Pro:** a imagem revela. `harbor.fazer.ai/chatwoot/fazer-ai/chatwoot-pro` = **Pro** (Kanban + features fazer-ai). `ghcr.io/fazer-ai/chatwoot` (nosso fork OSS), ou o `chatwoot/chatwoot` oficial do Docker Hub num brownfield de terceiro, = **OSS**: o core do agente funciona (Agent Bot é padrão), mas **sem** Kanban/features Pro. Se o usuário quer essas features, sinalize a migração pra Pro.
- **Langfuse v3 vs v2:** o fazer.ai agents fala com a v3 (arquitetura `clickhouse` + **`minio` obrigatório**, ver `references/05-langfuse.md`). Tag `:2`, ou ausência de `clickhouse`/`minio`, → incompatível/parcial: sinalize.
- **Coolify:** validado em `4.x`. Versões muito antigas têm API diferente; confirme `:8000/api/health`=200 e cheque a versão pela tag.
- **Postgres reusado (fora do Coolify, Tier B/C):** o fazer.ai agents exige **pgvector** (extensão `vector`) e um **superuser** pro bootstrap das 2 roles (ver `references/04-agents-image.md`). Um Postgres compartilhado sem pgvector ou sem acesso superuser → sinalize.

## 5. Reaproveitar (capturar pro state, sem recriar)

Pra um serviço que vai reusar, capture o que as etapas seguintes precisam:
- **No Coolify, do container ao FQDN:** cruze o label `com.docker.compose.project` (= `uuid` do serviço) com o `coolify-db` pra pegar o endpoint público (sub-componentes como `sidekiq`/`minio`/`clickhouse` têm `fqdn` vazio):

  ```sh
  docker exec -i coolify-db psql -U coolify -d coolify -c \
    "SELECT s.uuid, s.name, sa.fqdn FROM services s
     JOIN service_applications sa ON sa.service_id=s.id
     WHERE sa.fqdn IS NOT NULL AND sa.fqdn<>'' ORDER BY s.id;"
  ```

  Ou via API: `GET /api/v1/services` (etapa 2). Preserve a porta do FQDN quando houver (ex. Langfuse `:3000`).
- **Endpoints/creds:** FQDN público + credenciais já existentes (admin token do Chatwoot via Rails runner; chaves do Langfuse) buscadas **transitoriamente** (ver `guardrails.md`), nunca persistidas.
- **Nunca** recrie um serviço saudável só pra "padronizar": isso destrói dados do usuário. Em brownfield, reusar > reinstalar.
