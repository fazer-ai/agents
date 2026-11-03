# 01: VPS + DNS + SSH

## VPS: qual VPS é escolha do usuário (pergunte, não escolha)

O **`<VPS_IP>` vem do usuário**, nunca de um chute. Se ele não disse qual e o MCP lista mais de uma VM na conta (`vps_virtual-machines_list`), **apresente as opções (id, IP, hostname, plano) e pergunte qual usar**: ter o MCP conectado não autoriza escolher por ele. Confirmada a VPS, **nunca toque em outra** da conta (ver `guardrails.md`). O orquestrador (Coolify, Portainer, outro painel, ou nenhum) já está instalado (brownfield) ou será instalado no deploy do tier (escolhido em 1c).

## SSH: sondar o acesso antes de gerar chave

O acesso à VPS é o 1º ponto onde a run costuma emperrar (a run real bateu em `Permission denied`). O jeito de não emperrar: **sonde antes de pedir qualquer coisa**, e quando precisar de uma chave nova, **guie o cadastro em passos curtos e espere**. **Nunca peça "o caminho da chave SSH" de cara** e **nunca use senha de root** (só chave). Ordem:

**1. Sonde o acesso** (sem perguntar nada): tente logar com as chaves que o operador já tem (default em `~/.ssh` + agent):
```sh
ssh -o ConnectTimeout=12 -o BatchMode=yes -o StrictHostKeyChecking=accept-new root@<VPS_IP> 'echo OK; hostname'
```
- Saiu `OK` → **há acesso**; siga, **não pergunte nada de chave**. Anote qual chave funcionou pra reusar no resto do fluxo.
- `Permission denied (publickey…)` ou exit ≠ 0 → **sem acesso ainda**. Antes de gerar uma chave nova, tente a dedicada de uma run anterior: se `~/.ssh/fazer-ai-agents` existe, sonde de novo com ela (`-i ~/.ssh/fazer-ai-agents`). Logou → já está cadastrada, **reuse** (não gere outra nem peça re-paste). Senão, passo 2. (`BatchMode=yes` evita travar pedindo senha; `dangerouslyDisableSandbox: true` é obrigatório por ser rede.)

**2. Sem acesso: gere a chave dedicada e cadastre a pública na VPS.** Use `scripts/sshkey.py` (não monte o `ssh-keygen` à mão): ele chama o `ssh-keygen` com **argv direto**, então a passphrase vazia passa em qualquer SO. No PowerShell (Windows) o `ssh-keygen -N ""` cru **perde** o argumento vazio, cai no prompt interativo e **trava**.
```sh
python3 scripts/sshkey.py generate --name fazer-ai-agents --comment fazer-ai-onboarding
```
Saída JSON com `public_key` (idempotente: se a chave já existe, só reimprime). **Use o nome FIXO `fazer-ai-agents`, literal, nunca um sufixo inventado nem um placeholder** (`fazer-ai-<algo>`): com nome estável o generate reusa a MESMA chave em toda run, e o operador cola a pública **uma vez só**. Nome novo a cada vez faz a chave que ele colou "sumir" (o agente passa a usar outra) e força re-paste, o atrito recorrente aqui. Daí o cadastro depende do provedor:
- **Hostinger: você mesmo cadastra, pela API, sem pedir nada ao operador.** Chame `vps_ssh-keys_add-virtual-machine` (tool do `hostinger-vps`, `hostinger-api-mcp` 2.10.0 ou mais novo) com `virtualMachineId` = o `<VPS_ID>` (inteiro) **da VPS que o operador escolheu** (de `vps_virtual-machines_list`) e `keys` = lista com a linha `ssh-ed25519 …` do `generate`. A chave entra na VM **já ligada, na hora** (o login funciona logo em seguida, sem reiniciar nem recriar). A resposta é a lista completa de chaves do root: confira que a sua está nela. Diga ao operador em uma frase o que você fez ("cadastrei a chave de acesso na sua VPS") e siga pro passo 3.
- **Reserva (a tool não existe no MCP instalado, a API recusou, ou o provedor não é a Hostinger): o operador cola a chave no painel.** Mostre a linha `ssh-ed25519 …` e **guie o cadastro em passos curtos**, em linguagem clara: "gerei uma chave de acesso; cole a linha abaixo no painel da sua VPS pra eu conseguir entrar". Na **Hostinger**, monte o link direto do hPanel pra **esta** VPS (você já tem o `<VPS_ID>` de `vps_virtual-machines_list`) e entregue pronto: `https://hpanel.hostinger.com/vps/<VPS_ID>/overview`. De lá → card **"Chave SSH"** → **"Gerenciar"** → **"+ Chave SSH"** → cole a chave pública → **"Salvar"**. (O link poupa o operador de caçar a VPS certa quando a conta tem mais de uma.) Em **outro provedor**, o equivalente no painel dele ("SSH Keys" / "Add SSH key" da VPS).

**3. Confirme o acesso sozinho.** Em vez de pedir "me avise quando cadastrar", deixe o helper **aguardar** o acesso (faz poll do SSH e detecta sozinho quando a chave entra):
```sh
python3 scripts/sshkey.py wait-access --ssh root@<VPS_IP> --ssh-opts "-i ~/.ssh/fazer-ai-agents"
```
Cadastrada pela API, a chave já vale e o poll sai na 1ª ou 2ª tentativa, então pode rodar em foreground. No caminho de reserva (o operador colando no painel) **rode em background, não em foreground** (o poll trava o seu turno enquanto ele cola a chave); retome quando sair. `ok:true` → há acesso, siga. `ok:false` (timeout) → aí sim volte ao operador (ver troubleshooting abaixo). Daí use o **comando de trabalho** no resto do fluxo, com a chave que funcionou (a dedicada `~/.ssh/fazer-ai-agents`, ou a existente que a sondagem achou no passo 1):
```sh
ssh -o IdentitiesOnly=yes -o IdentityAgent=none -o ConnectTimeout=12 -o BatchMode=yes \
    -o StrictHostKeyChecking=accept-new -i ~/.ssh/fazer-ai-agents root@<VPS_IP>
```
Bash com rede → `dangerouslyDisableSandbox: true`. Um comando de **uma linha sem** `"`/`$()`/`{{…}}`/`(` pode ir inline; qualquer **script não-trivial** (multi-linha, com aspas/`$()`/`{{…}}`/heredoc) vai por arquivo `.sh` + `scripts/remote.py`, nunca inline no `ssh <host> '…'` nem por here-string no PowerShell (aspas comidas + BOM; ver `gotchas.md`). **Windows:** passe o caminho da chave no `--ssh-opts` (helpers preservam as barras `\`); todo helper que fala SSH aceita `--ssh-opts "-i <caminho>"`.

**4. Normalize as chaves autorizadas do root, logo no 1º SSH que funcionou** (qualquer caminho: chave que a sondagem achou, cadastro pela API ou colada no painel), **antes de qualquer instalador**:
```sh
python3 scripts/sshkey.py normalize-keys --ssh root@<VPS_IP> --ssh-opts "-i ~/.ssh/fazer-ai-agents"
```
Saída `{"ok":true,"changed":…,"keys":N}`. Por quê: a Hostinger (painel e API) grava `"\n" + chave` e **nunca termina o arquivo com newline**: sobra uma linha em branco antes da chave nova, e o arquivo fica sem o `\n` final. O instalador do Coolify acrescenta a chave dele com `cat >>`, que **gruda** no fim da última linha e a invalida (servidor `localhost` Unreachable, ver `gotchas.md`). O comando só descarta linhas em branco e garante o newline final: não toca nas chaves, é idempotente (arquivo já limpo não é reescrito) e é seguro em qualquer provedor. Quando mudou o arquivo, guarda uma cópia ao lado. Não o confunda com `coolify.py heal-localhost` (02): aquele roda **depois** do Coolify, desgruda o que já grudou e verifica o SSH container→host; este evita o problema e roda antes.

### Se persistir "Permission denied (publickey,password)"

O sintoma da run real. Não é um beco sem saída; quase sempre é uma destas causas, na ordem pra checar:

1. **A chave não foi cadastrada nesta VPS.** É a causa nº 1: o poll do passo 3 continua `ok:false` porque a chave não entrou. Na Hostinger, confira com `vps_ssh-keys_list-virtual-machine` (mesmo `virtualMachineId`) se a linha da sua chave aparece; se não, cadastre de novo com `vps_ssh-keys_add-virtual-machine` e confira o `<VPS_ID>`. No caminho de reserva (painel), peça ao operador, **em linguagem simples**, pra confirmar que colou a chave **nesta** VPS e clicou Salvar: "não consegui entrar ainda; você chegou a colar aquela chave no painel desta VPS e salvar?".
2. **Chave errada apontada.** Confirme que o `-i` aponta pra chave cuja **pública** foi cadastrada (`~/.ssh/fazer-ai-agents` se você gerou no passo 2). Se a sondagem do passo 1 achou uma chave existente, use **essa**, não a dedicada.
3. **Provedor só injeta a chave em provisionamento.** Em alguns provedores, cadastrar a chave no painel só a aplica ao **criar/recriar** a VM, não numa VM já rodando. **Não é o caso da Hostinger** pelo endpoint de chave da VM (`vps_ssh-keys_add-virtual-machine` escreve na VM ligada); o que não aplica a quente lá são os endpoints antigos de chave da conta (ver *Nota MCP*). Se o provedor não aplica a quente, o operador precisa adicioná-la por um acesso que já funcione (um console web do provedor, ou uma chave que já entra) e colá-la nas chaves autorizadas do root (o arquivo padrão de chaves SSH, em `~/.ssh/`). **Nunca** recrie a VM pra forçar a chave: isso apaga os dados.
4. **Login de root desabilitado.** Se `PermitRootLogin` está `no` no `sshd`, nem a chave certa entra como root. Aí o operador loga com o usuário dele (com sudo) e o fluxo segue com esse usuário + `sudo` (o `remote.py` tem `--sudo`).

Só depois de descartar 1 e 2 (as comuns) leve 3/4 ao operador. Enquanto isso, **não** caia pra senha de root nem invente contornos.

### Nota MCP: as tools de chave da Hostinger
- **Use** `vps_ssh-keys_add-virtual-machine` (POST, escreve na VM ligada e devolve todas as chaves do root), `vps_ssh-keys_list-virtual-machine` (lê as chaves do root direto do arquivo) e, só se o operador pedir, `vps_ssh-keys_remove-virtual-machine`. Confirme o acesso **por sondagem** (passo 3), nunca só pelo 200 da API.
- **Não use** os endpoints antigos de chave da conta (`vps_public-keys_create`/`attach`/`list`/`delete`, as antigas `VPS_attachPublicKeyV1` e parentes): estão deprecated, e o `attach` responde 200 mas **não** injeta a chave numa VM ligada (só em provisionamento/`recreate`, que apaga dados).
- **Apagar chave tem armadilha.** Se outra chave estiver grudada na linha da que você quer tirar (ver `gotchas.md`), o `remove` com o texto exato da linha grudada responde 200 e **não remove nada**; apagar pelo hPanel remove as duas e deixa uma linha em branco. Sem nada grudado, apagar (painel ou API) devolve o arquivo idêntico ao de antes. Por isso o passo 4 vem antes de qualquer instalador, e a skill nunca apaga chave sozinha.

## DNS (MCP Hostinger, domínio `<seu-dominio>`)

O **domínio raiz (`<seu-dominio>`) é escolha do usuário**: liste os domínios da conta (`domains_portfolio_list`) e **pergunte qual usar como raiz**: nunca assuma um porque "estava na conta". Definido o raiz, crie os A-records apontando pra `<VPS_IP>` (os três da app são o contrato; ver 1c):
- `agents.<seu-dominio>`: fazer.ai agents
- `chatwoot.<seu-dominio>`: Chatwoot (Pro ou OSS)
- `langfuse.<seu-dominio>`: Langfuse (recomendado)
- **painel do orquestrador** (se houver e você quiser um domínio limpo): `coolify.` (Tier A) / `portainer.` (Tier B); outro painel usa o próprio; no compose genérico (Tier C) pode não haver painel.

Tools do `hostinger-dns`: `dns_records_list` (inspecionar), `dns_records_update` (setar). **Confirme a resolução antes de prosseguir** (o ACME (Traefik do Coolify, Caddy do Portainer, ou o proxy do tier) só emite o certificado quando o A-record resolve; sem isso os serviços sobem mas ficam 503/sem TLS). Não confie num `dig` único: faça **poll do DNS em loop** até o registro apontar pro IP, para cada subdomínio que você criou:
```sh
until [ "$(dig +short agents.<seu-dominio> @1.1.1.1 | tail -1)" = "<VPS_IP>" ]; do sleep 15; done; echo "agents resolvido"
```
Repita pra `chatwoot.`/`langfuse.` e o subdomínio do painel (`coolify.`/`portainer.`). Só **anexe o domínio no painel / suba o proxy depois** que resolver. (Windows sem `dig`: `nslookup agents.<seu-dominio> 1.1.1.1`; no PowerShell, adapte o loop com `Start-Sleep`.)

## Outro provider (VPS/DNS fora da Hostinger)

Se o usuário usa outro provider de VPS e/ou DNS, **não há MCP da Hostinger**. Pergunte qual provider ele usa e conduza com base no seu conhecimento dele. Só o **provisionamento de VPS/DNS** muda de ferramenta; do SSH em diante (deploy do tier, agents, branding, bind) o fluxo é idêntico.

- **DNS:** crie os **mesmos A-records** (`agents.`/`chatwoot.`/`langfuse.` + o painel do tier → IP da VPS) pelo painel/CLI/API do provider do usuário. Confirme a resolução igual, com o mesmo poll `until [ "$(dig +short <sub>.<seu-dominio> @1.1.1.1 | tail -1)" = "<VPS_IP>" ]; do sleep 15; done` (o ACME só emite o cert quando o A-record resolve).
- **VPS:** o usuário cria a VPS no provider dele e fornece **IP + chave SSH**. Confirme que a porta 22 está aberta e que dá pra logar como root (ou com sudo). O resto da `01` (comando SSH, base64-pipe) vale igual.
- **Sem VPS ainda?** Sugira adquirir (recomendado: Hostinger, [link de parceiro fazer.ai](https://www.hostg.xyz/SHJfs), cupom `FAZERAI` = 10% de desconto na primeira compra). Detalhe na `00-prereqs-and-access.md`.
