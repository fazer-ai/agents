<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/assets/logo.png">
  <img alt="fazer.ai agents" src="public/assets/logo-light.png" width="200">
</picture>

# fazer.ai agents

**Agentes de IA de atendimento sobre o Chatwoot.**
WhatsApp em primeiro lugar. Multimodais, humanizados e self-hosted.

**Português (Brasil)** · [English](README-en.md)

![Free: Apache 2.0](https://img.shields.io/badge/Free-Apache%202.0-3B82F6)
![Bun](https://img.shields.io/badge/Bun-000?logo=bun&logoColor=fff)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=fff)
![React 19](https://img.shields.io/badge/React%2019-149ECA?logo=react&logoColor=fff)
![PostgreSQL + pgvector](https://img.shields.io/badge/PostgreSQL%20+%20pgvector-4169E1?logo=postgresql&logoColor=fff)
![LangGraph](https://img.shields.io/badge/LangGraph-1C3C3C)

</div>

---

**fazer.ai agents** transforma o WhatsApp num canal de atendimento com IA de verdade. Os agentes rodam sobre o seu Chatwoot e atendem com cara de gente: transcrevem áudios, leem imagens, respondem por texto ou por voz, consultam a base de conhecimento, agendam, orçam, movem o funil e passam para o time humano na hora certa. Tudo na sua própria infraestrutura.

### Destaques

- 🗣️ **Multimodal nativo:** ouve áudios, lê imagens e responde por voz, sem plugin.
- 🧠 **Qualquer modelo, inclusive local:** OpenAI, Anthropic, Google, DeepSeek, OpenRouter ou modelos locais (Ollama, LM Studio, vLLM) por endpoint OpenAI-compatível.
- 💬 **Ritmo de gente:** espera o cliente terminar de escrever, mostra "digitando…" e responde em balões, no tempo de uma pessoa.
- 🧰 **Age, não só responde:** base de conhecimento (RAG), ferramentas HTTP, servidores MCP e toolpacks. Agenda, orça, move o funil e passa pro humano.
- 🚀 **Sobe num comando:** onboarding guiado por IA instala a stack inteira num VPS e valida ponta a ponta.

## 🚀 Comece agora

Do primeiro comando ao agente atendendo no WhatsApp, conduzido por um **agente de IA no seu terminal**. Uma linha só instala o CLI, autentica na fazer.ai, conecta os MCPs e instala a skill de onboarding, que sobe a stack completa (Chatwoot + fazer.ai agents + observability, com TLS) num VPS e valida a instância ponta a ponta.

**macOS e Linux**

```bash
curl -fsSL https://app.fazer.ai/api/agents/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://app.fazer.ai/api/agents/install.ps1 | iex
```

A [versão Pro](https://app.fazer.ai/#/agents) tem o próprio instalador, liberado para assinantes.

Três skills acompanham a operação, desde a instalação ao uso no dia a dia:

- **`agents-onboarding`:** sobe a stack do zero num VPS (Coolify, Portainer ou compose) e valida ponta a ponta.
- **`agents-operation`:** investiga conversas em produção e ajusta o comportamento do agente, com toda mudança aprovada.
- **`agents-dev`:** clona o código e conduz o desenvolvimento seguindo os invariantes do projeto.

## Funcionalidades

### 🤖 Agente

- Runtime **LangGraph TS** com memória durável por conversa (checkpointer no Postgres).
- Multi-modelo por agente: OpenAI, Anthropic, Google, DeepSeek, **OpenRouter** e **modelos locais** via endpoint OpenAI-compatível (Ollama, LM Studio, vLLM), com a chave no cofre.
- Editor progressivo: prompt, ferramentas, comportamento e base de conhecimento num só lugar.
- **Playground** para conversar com o agente antes de colocá-lo no ar.

### 💬 WhatsApp e canais (via Chatwoot)

- Um agente, **várias caixas de entrada**, com roteamento por inbox.
- Janela de 24h do WhatsApp respeitada, com **templates HSM** para envios proativos fora da janela.
- **Redirecionamento de canal:** opção para usar o WhatsApp oficial só como porta de entrada e leva a conversa para o chat do site, sem custo por mensagem durante o atendimento.
- Omnichannel: qualquer canal que o Chatwoot suporta.

### 🎙️ Multimodal e humanização

- **Transcrição de áudios** (STT): OpenAI, Gemini, ElevenLabs ou OpenAI-compatível.
- **Respostas em voz** (TTS) com preferência por contato (cliente escolhe se quer resposta em áudio ou texto): OpenAI e ElevenLabs.
- **Visão:** interpreta imagens e documentos enviados pelo cliente.
- **Debounce:** agrupa rajadas de mensagens e responde uma vez só.
- **Split e "digitando…":** quebra a resposta com ritmo natural.

### 🧰 Ferramentas e conhecimento

- **Base de conhecimento (RAG)** com pgvector e fila de aprovação de sugestões.
- Ferramentas nativas e **ferramentas HTTP customizadas** (schema, allowlist de host, credencial no cofre).
- Catálogo de integrações: toolpacks, servidores MCP e ferramentas nativas.
- Conecte o agente a **servidores MCP externos**.

### 📈 Vendas e operação

- **Agendamento no Google Calendar** com lembretes automáticos.
- **Kanban de funil:** o agente move o card conforme o estágio da conversa. Requer [Chatwoot fazer.ai Pro](https://fazer.ai/kanban).
- **Follow-ups proativos** que respeitam o horário de atendimento.
- **Handoff para humano:** roteia pela fila, ou deixa o agente escolher pra qual time ou agente passar.

### 🖥️ Console do operador

- Dashboard com KPIs e **custo real de LLM** (via Langfuse).
- Conversas com detalhe, aviso de erro e ação de re-engajar.
- Componentes reutilizáveis (pools de building blocks) para montar o comportamento do agente.
- Canais, Webhooks, API keys, Logs, Admin e Configurações.
- Multi-idioma (i18n) e tema claro/escuro.

### 🔌 Plataforma e API

- Um núcleo, três formas de dirigir: **REST v1**, **servidor MCP** e **console web**.
- Servidor MCP com OAuth 2.1 e ferramentas de escrita com **dry-run por padrão**.
- **Webhooks de saída** com HMAC, retry com backoff e fila morta.
- **Logs de execução** por etapa, com alertas (Discord ou webhook) e retenção.

### 🔒 Segurança e self-host

- **Cofre** de segredos criptografados.
- Auth com JWT e Google, setup de primeiro acesso e controle de cadastro.
- PostgreSQL com **RLS** e role de runtime sem superusuário.
- Deploy em **Docker**, Coolify, Portainer ou compose.

## Edições

A edição **Free** é open-source (Apache 2.0) e traz tudo que está acima.

A edição **Pro** acrescenta o que quem opera em escala precisa:

- **Multi-tenant:** vários clientes ou marcas num único deploy, isolados no banco por RLS.
- **Branding próprio:** painel com a sua identidade (white-label).

Detalhes em [app.fazer.ai/#/agents](https://app.fazer.ai/#/agents).

## Stack

Bun + Elysia · React 19 + Tailwind CSS v4 · Prisma + PostgreSQL (pgvector) · LangGraph TS · Langfuse (observability, opcional).

## Desenvolvimento local

```bash
bun install
cp .env.example .env      # DATABASE_URL, MIGRATION_DATABASE_URL, ENCRYPTION_KEY
docker compose up -d      # PostgreSQL (pgvector)
bun db:bootstrap          # role de runtime + grants
bun prisma:migrate
bun dev                   # http://localhost:3000
```

## Links

- 🌐 Site: [fazer.ai](https://fazer.ai)
- 📚 Documentação: [`docs/`](docs/)
- 🤝 Contribuições: [CONTRIBUTING.md](CONTRIBUTING.md)
- 💬 Suporte: support@fazer.ai

<div align="center">
<sub>Free sob Apache 2.0 · Pro sob EULA proprietária · feito com ☕ pela fazer.ai</sub>
</div>
