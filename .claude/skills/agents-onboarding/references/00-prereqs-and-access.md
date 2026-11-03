# 00: Pré-requisitos e acesso

## MCPs (ligar ANTES de começar; reiniciar a sessão cedo)

- **Hostinger** (3 servers do pacote `hostinger-api-mcp`, que a CLI instala em `~/.fazer-ai/mcp` e roda pelo runtime local, sem `npx`; stdio, `HOSTINGER_API_TOKEN`): `hostinger-dns`, `hostinger-vps`, `hostinger-domains`. DNS é o uso central (etapa 1: A-records); VPS/domains pra descoberta/gestão. **Só quando a infra é Hostinger**: em outro provider não há esses MCPs (ver "Outro provider" na `01-vps-dns-ssh.md`). Chame as tools pelo **nome completo** `mcp__hostinger-{dns,vps,domains}__<Tool>` (ex.: `mcp__hostinger-vps__vps_virtual-machines_list`); o nome cru (`vps_...`, `domains_...`) devolve *No such tool available*.
- **Hub `app-fazer-ai`**: **não** é conectado como MCP na sua sessão. As ops do hub que o onboarding precisa (registry credential do Harbor, cadastro/atacha da instância na licença) saem pelo **proxy do CLI**: `bunx @fazer-ai/agents hub <op>` (usa o OAuth do `~/.fazer-ai/oauth.json` do bootstrap; dry-run por padrão, `--apply` pra escrever). Você ganha só essas ops, sem token `mcp:admin` na sessão. Detalhe em `03-chatwoot-pro.md` / `chatwoot-hub-register.md` / `04-agents-image.md`; limites em `guardrails.md`.
- **agents** (OAuth): conectado **SÓ na etapa 6**, depois do `/setup` (antes disso a instância nem existe). **Não trate a ausência dessas tools como estado inconsistente nem motivo pra parar**: até a etapa 6 ela é o estado esperado da jornada; o gate "sem tools → PARE" de `06-setup-and-mcp.md` só vale **depois** da conexão.
- Depois de adicionar os MCPs, **reinicie a sessão do harness** pra eles ficarem disponíveis na execução.

## Estado do CLI de onboarding (em disco, `~/.fazer-ai/`)

O CLI `@fazer-ai/agents` roda ANTES do handoff e deixa marcadores que você deve **ler em vez de re-perguntar**:

- **`onboarding.json`**: `{ chatwootSource: "new" | "existing", chatwootTier?: "pro" | "community", chatwootLicenseId?, edition: "free" | "pro" }`. **Eixos independentes:** a **origem** do Chatwoot (`chatwootSource`: `new` = subir um novo, aí `chatwootTier` diz a edição; `existing` = plugar num Chatwoot que **já existe** / BYO, **sem** tier nem licença), a edição do **Chatwoot** quando é novo (`chatwootTier`, etapa 3 / `chatwoot-hub-register.md` / `templates/chatwoot/README.md`) e a edição da **fazer.ai agents** (`edition`, etapa 4 / `04-agents-image.md`: `pro` = imagem privada Harbor; `free` = pública). É a escolha **explícita** do operador; respeite-a (inclusive `existing` = não provisionar Chatwoot; `community`/`free` = seguir sem Pro, mesmo que haja licença/acesso no hub).
- **`hostinger.json`**: `{ token }` da API Hostinger (quando o provider é Hostinger); o CLI também já o injeta nos MCPs.
- **`preferences.json`**: defaults de UX do CLI (agente/provider/última licença); informativo, não load-bearing.

Marcador ausente (fallback por token, ou outro ponto de entrada) → decida pelo hub via proxy: `bunx @fazer-ai/agents hub licenses` / `hub whoami`.

## Acesso (fornecido pelo usuário)

> Peça **cada item quando a etapa que o usa chegar**, 1-2 por mensagem; **não** despeje esta lista inteira de uma vez (princípio "Uma pergunta de cada vez" no SKILL.md). Ex.: IP do VPS na 01 (a chave SSH só se a sondagem falhar, ver 01); domínio na 01 (DNS); chave do provedor de modelo só perto do import/E2E; número de WhatsApp só na etapa 10. (O **nome de exibição não é perguntado**: default fixo `fazer.ai agents`, ver SKILL.md.)

- **VPS:** `root@<VPS_IP>` (no Hostinger, o id da VM é `<VPS_ID>`). **Qual VPS é escolha do usuário**: se a conta tem mais de uma, liste e **pergunte** (nunca escolha). Acesso SSH como `root` (sonde primeiro; só peça ou gere chave se faltar). Coolify pode já estar instalado (brownfield) ou não. Sondagem + comando SSH na `01-vps-dns-ssh.md`.
- **Sem VPS ainda?** Sugira adquirir uma. Recomendado: Hostinger, pelo [link de parceiro fazer.ai](https://www.hostg.xyz/SHJfs) (cupom `FAZERAI` = 10% de desconto na primeira compra). Em **outro provider**, o usuário cria a VPS lá e fornece IP + chave SSH; o fluxo segue igual (ver `01-vps-dns-ssh.md`).
- **Domínio:** `<seu-dominio>`. **O domínio raiz é escolha do usuário**: liste os domínios da conta e **pergunte qual** (nunca assuma). Os subdomínios de onboarding ficam livres pra apontar (`agents.`, `chatwoot.`, `coolify.`, `langfuse.`).
- **Chave do provedor de modelo** (OpenAI ou outro): o usuário fornece pra preencher o vault do agente (playground/E2E). As demais credenciais entram via deeplink (pending).
- **Número de WhatsApp** que o usuário controle, se for validar o transporte real no E2E (etapa 10).

## Operacional (comandos remotos)

- Chamadas de rede via Bash (ssh/curl) precisam de `dangerouslyDisableSandbox: true`.
- Pra evitar inferno de aspas em SSH/psql/Rails runner: **base64 local → pipe → `base64 -d`** no destino. É o padrão recorrente de todo o fluxo (ex.: `echo <B64> | base64 -d | docker exec -i coolify-db psql ...`).

## Gates de conta

- O **usuário** cria o 1º admin de Coolify/Portainer/Chatwoot/Langfuse/agents no browser; você entrega link + instrução e **espera**, nunca cria por conta própria. Detalhe em `guardrails.md`.
