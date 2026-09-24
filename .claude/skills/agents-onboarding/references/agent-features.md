# Pós-import: resolver avisos + ligar features do agente

Depois do import (`08`), o agente entra **disabled + test**. Antes de validar (`10`), **resolva todos os
avisos de configuração** (não bloqueiam o boot, mas degradam a qualidade) e ligue as features opcionais que
o agente usa. Trate a seção 1 como **gate**, não como "nice to have".

## 1. Avisos pós-import (gate, obrigatório)

O editor do agente lista "Avisos de configuração". Resolva **cada um** (ou desligue a feature
conscientemente):

- **KB sem indexar.** Os docs do import entram UNINDEXED e só indexam com o embedding por-tenant ligado
  + o OpenAI preenchido (sem isso ficam UNINDEXED, não FAILED). Sequência (detalhe em
  [`08-agent-import.md`](08-agent-import.md) §4-5): setar embedding por-tenant → `knowledge_reindex` da
  base (devolve `blocked` + `fillAt` se falta preencher a credencial; `include_failed:true` recupera
  FAILED reais), até **todos READY**.
  Depois **verifique grounding**: pergunte no playground algo que só a KB sabe e confirme que a resposta usa
  o conteúdo indexado. KB não-READY = sem grounding = critério de aceite (`10`) não batido.
- **STT/TTS/visão ligados sem chave.** Conecte a credencial (deeplink) **ou** desligue a feature. Não deixe
  o aviso aberto.

## 2. Voz (STT/TTS): opcional, por-agente

MCP `agent_settings_set` (dry-run por padrão; `credentialRef` aceita o **nome** da entrada do vault):

```jsonc
agent_settings_set {
  "agent_id": "<id>",
  "stt": { "enabled": true, "provider": "openai", "model": "whisper-1", "language": "pt", "credentialRef": "<nome no vault>" },
  "tts": { "mode": "mirror", "provider": "openai", "model": "tts-1", "voice": "alloy", "credentialRef": "<nome no vault>" }
}   // dry_run:false pra aplicar
```

- Campos (fonte `src/modules/stt/settings.ts`, `src/modules/tts/settings.ts`): STT
  `enabled/provider/model/language/credentialRef/baseURL`; TTS
  `mode (never|mirror|preference)/provider/model/voice/credentialRef/normalize`. ElevenLabs exige `voice`.
- **`agent_settings_set` é tool separada do `agent_update`** (este é nome/enabled/mode/modelConfig). Os
  blocos de comportamento (stt/tts/split/handoff/etc.) vão pelo `agent_settings_set`.
- REST equivalente: `PATCH /api/v1/agents/:id { settings: { stt, tts } }` (aqui o `credentialRef` tem que
  ser `vault:<id>`; REST não resolve por nome).
- A chave (OpenAI/ElevenLabs) é credencial do vault, preenchida por deeplink como qualquer outra (`08` §2).

### Checagem do áudio sintetizado: oferecer quando a resposta em áudio fica ligada

**Gatilho:** um agente fica com `tts.mode` diferente de `never`, seja porque você ligou acima, seja porque o import já trouxe assim (a Maria vem com `mirror`). Com `tts.mode: never` em todos os agentes, este trecho não existe para a instalação: não ofereça, não mencione.

Por que existe: de vez em quando a síntese volta quebrada com o texto certo (fala embolada que não forma palavra, um zumbido sem fala, ou um buraco mudo no meio da frase), e nada no envio percebe. Um detector separado ouve cada áudio antes (ou depois) de sair. Contrato e comportamento em `docs/tts.md`, seção "Checking the audio".

1. **Já existe detector?** Se o `TTS_CHECK_URL` já está no serviço agents (o campo **Audio check** / **Verificação do áudio** da aba Behavior aparece habilitado; sem URL ele fica desabilitado dizendo o que falta), não ofereça outro serviço nem meça memória de novo. Sem perguntar nada, o agente segue o padrão da instalação (**Instance default** / **Padrão da instalação**, `checkMode: null`); para dar a ele um modo próprio (passo 5), pergunte antes ao usuário e só grave com o sim.
2. **Existe uma imagem de detector?** Não há imagem pública. O detector é qualquer serviço que responda ao contrato de `docs/tts.md`, e o compose só referencia `${TTS_CHECK_IMAGE}`. Se o usuário não tem uma imagem, diga isso em uma linha e siga: sem imagem, não defina `TTS_CHECK_URL`, `TTS_CHECK_MODE` nem `checkMode`. Não invente nome de imagem ou registry.
3. **Folga de memória.** Meça no host a memória disponível (a linha `mem` da sondagem da [1b](01b-brownfield.md), ou `free -h` pelo SSH). O detector precisa de **cerca de 4 GB livres** (o compose reserva `mem_limit: 5g`). Sem essa folga, diga ao usuário que o detector não cabe nesta máquina por memória, e siga o onboarding: o áudio funciona sem ele. Não suba com limite menor.
4. **A oferta, em uma frase, com pergunta:** "Às vezes a voz sintetizada sai quebrada (embolada, zumbindo ou com um trecho mudo) e ninguém percebe; posso subir um detector que confere cada áudio, ele ocupa cerca de 4 GB de memória do servidor. Quer?" Sem um sim explícito, nada abaixo acontece: **nunca instale em silêncio**.
5. **Aceito:**
   - descomente o serviço `audio-check` no compose da instalação (o bloco já vem comentado nos três compose de deploy) com `TTS_CHECK_IMAGE` apontando para a imagem do usuário;
   - no serviço agents, defina `TTS_CHECK_URL=http://audio-check:<porta do detector>` e `TTS_CHECK_TOKEN` só se o detector exigir um; **nunca** `TTS_CHECK_MODE` sem `TTS_CHECK_URL` (o boot recusa);
   - redeploy do serviço agents: a URL é env, lida no boot;
   - modo do agente em `settings.tts.checkMode` (`agent_settings_set` bloco `tts`, `PATCH /api/v1/agents/:id`, ou o campo na aba Behavior): comece em `shadow` (**Record only** / **Só registrar**), que só registra o veredito sem segurar a resposta. Os limiares do detector foram calibrados no áudio de um provedor; passe para `enforce` (**Regenerate** / **Regenerar**) só depois de ouvir o que ele marcou no tráfego real desta instalação. `off` desliga para este agente, e `null` segue o padrão da instalação (`TTS_CHECK_MODE`; com URL e sem modo, é `shadow`);
   - confirme: gere uma resposta em áudio (playground com `reply_with_audio`) e procure no `/logs` a linha do estágio `tts_check` (**Audio check** / **Verificação do áudio**) desse turno.

### Links de afiliado da fazer.ai (ElevenLabs + Asaas)

Quando o usuário **não tem conta** no ElevenLabs (voz) ou no Asaas (cobrança PIX), ofereça o **link de
afiliado da fazer.ai** pra ele criar a conta. O mesmo link aparece na UI (no formulário de credencial, como
"Não tem conta ainda? Crie pela fazer.ai"), então é o caminho consistente:

- **ElevenLabs:** `https://try.elevenlabs.io/fazer-ai-agents-cli`
- **Asaas:** `https://www.asaas.com/r/5ec90fd5-677d-40c7-b577-cc1f6de62fec`

Ofereça só quando fizer sentido (o usuário vai usar voz/cobrança e não tem conta): é conveniência, não
empurre. A chave em si continua entrando pelo deeplink do vault; o segredo **nunca** passa pelo agente.

## 3. Google (Calendar/Drive): opcional, **fora do MCP por design**

As tools de Google usam uma credencial kind `google_oauth`. **Não há MCP write tool pra conectar o Google**
(o segredo e o consent nunca cruzam o MCP). É um fluxo de **console** (o usuário faz):

1. Pré: no Google Cloud, um OAuth 2.0 Client ID (Web) com a redirect URI
   **`${PUBLIC_URL}/api/v1/oauth/google/callback`** registrada.
2. No console `/resources/vault`: criar credencial kind `google_oauth` com Client ID + Client Secret.
3. Na `GoogleOAuthSection`: escolher os scopes (Calendar/Drive/...) → "Sign in with Google" → popup de
   consent → o callback grava os tokens (criptografados) na entrada do vault.
4. Status: "Connected as <email>". A partir daí, as tools de Calendar/Drive resolvem por `vault:<id>` (token
   renovado automaticamente).

Endpoints (fonte `src/api/v1/oauth-google.controller.ts`): `POST /api/v1/vault/:id/oauth/google/authorize {scopes}`,
`GET /api/v1/oauth/google/callback`, `GET .../status`, `POST .../disconnect`. Não confundir com o login
social do `docs/google-oauth.md` (é outra coisa).

> Princípio: tudo o mais é MCP-first, mas **o connect do Google é console-only por design**. Entregue o
> link/instrução ao usuário; o agente não vê o segredo.
