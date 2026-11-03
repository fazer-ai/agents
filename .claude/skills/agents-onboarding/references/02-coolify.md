# 02: Coolify (reusar/instalar, API, Instance Domain)

> **Avise o usuário onde você está:** o Coolify é o **1º serviço** do deploy (o painel que gerencia tudo; depois vêm Chatwoot, fazer.ai agents e Langfuse). Diga que vai começar por ele, e a instalação leva alguns minutos. Dê sinal de vida durante a espera longa (Docker + imagens baixando) em vez de sumir; ao terminar, confirme e anuncie o próximo. Ver o princípio de narração (e a contagem que se ajusta ao caso real) em `SKILL.md`.

## Brownfield: reusar se já existe e está saudável

A VPS pode já vir com Coolify (brownfield). Nesse caso, reaproveite o existente: **nunca** destrua dados do usuário. O inventário brownfield completo (todos os serviços, com a matriz reusar/instalar/sinalizar) está na etapa 1b (`references/01b-brownfield.md`); aqui é só a parte do Coolify.

### Greenfield: instalar o Coolify se a VPS vier sem ele

VPS nova sem Coolify → rode o instalador oficial. **Como você invoca importa mais que o instalador** (é o passo que mais trava): ele puxa Docker + imagens (minutos), lê o próprio stdin e faz job control. Dois anti-padrões fazem ele sair com exit 1/127 fingindo estar "interativo (Y/N)" (e aí um modelo fraco entra num loop de tweaks):

- **Não** jogue a saída do `curl` direto num shell (baixar-e-canalizar): o `bash` passa a ler o SCRIPT do stdin e colide com os prompts do instalador.
- **Não** o passe pelo stdin do `remote.py`/`bash -s` (que já usa o stdin pro próprio script): o instalador herda um stdin ocupado/EOF.

Em vez disso, **baixe o instalador pra um arquivo no remoto e rode o arquivo com stdin limpo (`< /dev/null`), detached**, depois faça poll (não bloqueie o terminal por minutos, a chamada pode ser cortada). O `remote.py --script-file` roda este wrapper, que faz o download+run NO remoto (sem canalizar):

`install-coolify.sh`:
```sh
curl -fsSL https://cdn.coollabs.io/coolify/install.sh -o /tmp/coolify-install.sh
setsid bash /tmp/coolify-install.sh < /dev/null > /tmp/coolify-install.log 2>&1 &
echo "coolify install iniciado (pid $!); log em /tmp/coolify-install.log"
```

Depois faça **poll não-bloqueante** até ficar pronto: `curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/api/health` = `200` e os containers core `Up (healthy)`. Resultado esperado: `/data/coolify` criado, "Your instance is ready to use!" no log, **6 containers core** Up+healthy (`coolify`, `coolify-db`, `coolify-redis`, `coolify-realtime`, `coolify-proxy`, `coolify-sentinel`). Em brownfield (Coolify já presente e saudável) **reaproveite** (etapa 1b); nunca reinstale por cima de dados do usuário.

## Verifique que o Coolify alcança o próprio servidor (localhost): auto-repare a chave

Assim que o Coolify está de pé (greenfield recém-instalado OU brownfield reaproveitado), **confirme que ele consegue se conectar ao próprio host** antes de qualquer deploy. O Coolify gerencia o servidor `localhost` por SSH, do container `coolify` para o host (`root@host.docker.internal`), com uma chave que o instalador adiciona às **chaves autorizadas do root**. É uma falha silenciosa e recorrente: se a última linha desse arquivo **não terminava em newline** (a Hostinger grava a chave assim, pelo painel e pela API; a `01` já roda `sshkey.py normalize-keys` no 1º SSH para evitar isto, mas instância existente ou passo pulado ainda caem aqui), o `cat >>` do instalador **cola** a chave do Coolify no fim da linha anterior: ela deixa de ser uma entrada válida, o servidor `localhost` fica **Unreachable** e **todo deploy falha depois** (sem erro óbvio; a UI só mostra o servidor inacessível).

Não conserte na mão (editar as chaves autorizadas por SSH→PowerShell é a classe de quoting que mais quebra). Rode o helper: ele normaliza o arquivo (uma chave por linha, sem linhas grudadas, newline no fim, permissões), garante a chave do Coolify como linha própria, e **verifica** o SSH container→host:
```sh
python3 scripts/coolify.py heal-localhost --ssh root@<VPS_IP>
```
`reachable:true` → o Coolify alcança o próprio host; siga. **Idempotente**: rode sempre (greenfield ou brownfield); se já estava são, não muda nada e confirma `reachable:true`. O flag interno do Coolify (`is_reachable`) fica em cache e **não** revalida sozinho de forma confiável (o job periódico costuma ser pulado por lock); ele só reflete o conserto após um `docker restart coolify` (que o passo do **Instance Domain** já faz antes dos deploys), então um "Unreachable" na UI até lá é cosmético. Se **não** for setar o Instance Domain antes do 1º deploy, rode `docker restart coolify` depois do heal pra revalidar. `reachable:false` → confira que o container `coolify` está `Up` e que o host aceita login root por chave, e re-rode.

## 1º admin (o ÚNICO passo do usuário no Tier A)

O **usuário cria** o 1º admin pelo browser em `http://<VPS_IP>:8000` (gate de conta): **esse é o único passo manual do Tier A**; você entrega o link e **espera** (`wait-admin`), nunca cria por conta própria. Depois do admin, **NÃO peça mais nada ao usuário**: o token e o Instance Domain você faz por SSH (abaixo). **Nunca** mande o usuário abrir "Settings → …".

Em vez de pedir "responda quando criar", **aguarde** o admin aparecer (poll no banco via psql, não trava o operador). **Rode em background, não em foreground**: o poll bloqueia por minutos e não há nada a fazer no meio, então dispare non-blocking e retome quando o comando sair (nunca deixe o poll travar o seu turno). Como o gate depende do usuário criar a conta no browser, dê uma janela larga (`--attempts 120`, ~10 min):
```sh
python3 scripts/coolify.py wait-admin --ssh root@<VPS_IP> --attempts 120   # em background, non-blocking
```
`ok:true` (com `users>0`) → siga pro token. `ok:false` (timeout) → re-lance ou pergunte ao operador. **Não avance pro token antes do `ok:true`.** Brownfield: se já existe admin, detecta na 1ª tentativa e segue. (O detector é psql, não Tinker: não dá o falso "sem admin" que o Tinker dava ao ecoar o payload.)

## API Access (token): você faz por SSH, não pela UI

Dois passos, ambos por SSH, **sem o usuário**. Os dois (e toda chamada à API daqui pra frente) saem do `scripts/coolify.py` (Python stdlib, embutido nesta skill): ele base64-pipa o payload por SSH, semeia o `currentTeam`, e **mantém o token Sanctum `<id>|<token>` fora de qualquer shell** (o `|` só vive num arquivo `0600` e no header HTTP). Foi um `|` num comando montado à mão que já derrubou uma run. Rode via Bash com sandbox desligado, como todo ssh/curl (ver `00`).

**1. Habilite a API**: vem **desabilitada** por padrão; sem isto todo request dá `403 {"message":"API is disabled."}`:
```sh
python3 scripts/coolify.py enable-api --ssh root@<VPS_IP>
```
Pega na hora, sem restart, idempotente. `allowed_ips` vazio (default) = sem restrição de origem; **não mexa** (o agente acessa de fora).

**2. Gere o token root.** O `createToken` cru falha com `team_id null`, então o script **semeia a sessão** (`currentTeam`) antes de gerar, extrai o `<id>|<token>` e grava num arquivo `0600` (ability `*` = root; o segredo **não** é impresso):
```sh
python3 scripts/coolify.py token --ssh root@<VPS_IP> --out coolify.token   # arquivo no scratchpad, transitório
```
Daí toda chamada autenticada lê o token do arquivo, você **nunca** digita o token num `curl`. Valide a API:
```sh
python3 scripts/coolify.py api-get --base-url http://<VPS_IP>:8000 --token-file coolify.token --path /servers   # → 200
```
`create-service` (deploy de serviço), `api-post` (qualquer POST autenticado) e `set-fqdn` usam o mesmo `--token-file`. O arquivo é transitório (scratchpad); **nunca** em repo/log/commit. **Windows/PowerShell:** no `api-post`, prefira `--json-file` a `--json-stdin`: o pipe do PowerShell manda o stdin em UTF-16 e quebra o JSON (o helper tolera BOM/UTF-16 como rede de segurança, mas `--json-file` é determinístico).

## Instance Domain: você seta por SSH (faça ANTES de deployar os serviços)

Troca o acesso ao **painel** de `http://<VPS_IP>:8000` para `https://coolify.<seu-dominio>` (TLS). O deploy dos serviços não depende disto (rodam pelo IP cru), mas **faça**: é parte do contrato do painel, não item descartável. Duas regras de ordem/confiabilidade que já queimaram runs:

1. **Faça ANTES de deployar os serviços.** O passo termina com `docker restart coolify`, que **zera a fila de deploy** do Coolify (`gotchas.md`: "o `start` da API pode não materializar"). Reiniciar o `coolify` no meio do deploy faz os serviços não subirem. Ordem: token → **Instance Domain** → deploy dos serviços.
2. **NÃO monte o psql + restart inline no `ssh <host> '…'`**: o `UPDATE …` com aspas e o `; docker restart` quebram no PowerShell (aspas comidas, `\`/BOM; é exatamente onde uma run real falhou e o agente desistiu chamando de "cosmético"). Escreva um `.sh` e rode pelo `remote.py` (entrega byte-exato):

`set-instance-domain.sh`:
```sh
docker exec -i coolify-db psql -U coolify -d coolify -c "UPDATE instance_settings SET fqdn='https://coolify.<seu-dominio>';"
docker restart coolify
```
```sh
python3 scripts/remote.py --ssh root@<VPS_IP> --ssh-opts "-i <chave>" --script-file set-instance-domain.sh
```
O `UPDATE` **sozinho não regenera** o proxy; é o **`restart coolify`** (o app, **NÃO** `coolify-proxy`) que reescreve a rota do painel. Derruba painel+API ~30-40s (o token já gerado **sobrevive**). Exige o A-record `coolify.` (etapa 1). O cert Let's Encrypt não sai instantâneo (restart + ACME levam alguns segundos), então **não valide com um `curl` único** (um `000`/`503` na 1ª tentativa não quer dizer que falhou): faça **poll com retry ~90s**:
```sh
for i in $(seq 1 18); do
  code=$(curl -so /dev/null -w "%{http_code} ssl=%{ssl_verify_result}" https://coolify.<seu-dominio>)
  echo "try $i: $code"; case "$code" in 200*|302*) echo "coolify domain OK"; break;; esac; sleep 5
done
```
Esperado: `200`/`302` com `ssl=0` (cert válido). **Se estourar os ~90s**, suba a escada de diagnóstico antes de desistir:
1. **DNS resolve pro IP?** `dig +short coolify.<seu-dominio> @1.1.1.1` deve devolver `<VPS_IP>`. Se não, o A-record não propagou: volte à etapa 1 e refaça o poll de DNS.
2. **80/443 abertas na VPS?** o ACME (HTTP-01) precisa da 80 e o acesso da 443. De fora: `curl -sS -o /dev/null -w '%{http_code}\n' http://coolify.<seu-dominio>/.well-known/acme-challenge/probe` (um firewall/security-group do provedor pode estar bloqueando).
3. **Logs do proxy:** `docker logs --tail 50 coolify-proxy` (procure erro de emissão/ACME).

Só siga sem o domínio se ele **falhar de verdade** após esta escada (não como atalho).

## DB do Coolify (acesso direto; ver gotchas)

```sh
docker exec -i coolify-db psql -U coolify -d coolify
```

## Projeto + ambiente

Crie (ou reaproveite) um projeto com o **nome padrão `fazer.ai agents`** (não perguntado; o operador renomeia depois no console se quiser) e o ambiente `production`. Os UUIDs (server/projeto/env/serviços) são **gerados a cada instalação**: descubra-os pela API/DB; nunca chumbe UUIDs de outra instalação.

## Registry privado do Harbor (só Pro)

Imagens **Pro** (Chatwoot `chatwoot-pro`; fazer.ai agents no projeto `agents`) são privadas no Harbor: o Coolify precisa da credencial registrada **antes** de puxar, senão o deploy falha (pull denied / 401). Só no caminho Pro:

1. Provisione a credencial **per-user** pelo **proxy do hub no CLI** (não há hub MCP na sessão; o CLI tem o OAuth do bootstrap):
   ```sh
   bunx @fazer-ai/agents hub registry-credential --apply --out harbor.secret
   ```
   Grava o secret em `harbor.secret` (`0600`) e imprime só `username` + caminho (o secret **nunca** sai no output). Idempotente (garante o robot per-user, sem rotação).
2. Registre no Coolify (Servers → Registries, ou via API) apontando pra `harbor.fazer.ai` com o `username` (do passo 1) e o secret de `harbor.secret`. **Nunca** logue o secret.

No caminho **OSS** (imagem pública), pule isto inteiro.
