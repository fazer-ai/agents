<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/assets/logo.png">
  <img alt="fazer.ai agents" src="public/assets/logo-light.png" width="200">
</picture>

# fazer.ai agents

**Customer-service AI agents on top of Chatwoot.**
WhatsApp-first. Multimodal, humanized, self-hosted.

[Português (Brasil)](README.md) · **English**

![Free: Apache 2.0](https://img.shields.io/badge/Free-Apache%202.0-3B82F6)
![Bun](https://img.shields.io/badge/Bun-000?logo=bun&logoColor=fff)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=fff)
![React 19](https://img.shields.io/badge/React%2019-149ECA?logo=react&logoColor=fff)
![PostgreSQL + pgvector](https://img.shields.io/badge/PostgreSQL%20+%20pgvector-4169E1?logo=postgresql&logoColor=fff)
![LangGraph](https://img.shields.io/badge/LangGraph-1C3C3C)

</div>

---

**fazer.ai agents** turns WhatsApp into a real AI-powered service channel. Agents run on top of your Chatwoot and talk like actual people: they transcribe voice notes, read images, reply by text or voice, query the knowledge base, schedule, quote, move the pipeline and hand off to the human team at the right moment. All on your own infrastructure.

### Highlights

- 🗣️ **Natively multimodal:** listens to voice notes, reads images and replies by voice, no plugins.
- 🧠 **Any model, including local ones:** OpenAI, Anthropic, Google, DeepSeek, OpenRouter or local models (Ollama, LM Studio, vLLM) through an OpenAI-compatible endpoint.
- 💬 **Human pace:** waits for the customer to finish typing, shows "typing…" and replies in message bubbles, at a person's rhythm.
- 🧰 **Acts, not just answers:** knowledge base (RAG), HTTP tools, MCP servers and toolpacks. Schedules, quotes, moves the pipeline and hands off to humans.
- 🚀 **Up in one command:** AI-guided onboarding installs the whole stack on a VPS and validates it end to end.

## 🚀 Get started

From the first command to an agent answering on WhatsApp, driven by an **AI agent in your terminal**. A single line installs the CLI, authenticates with fazer.ai, connects the MCPs and installs the onboarding skill, which brings up the full stack (Chatwoot + fazer.ai agents + observability, with TLS) on a VPS and validates the instance end to end.

**macOS and Linux**

```bash
curl -fsSL https://app.fazer.ai/api/agents/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://app.fazer.ai/api/agents/install.ps1 | iex
```

The [Pro edition](https://app.fazer.ai/#/agents) has its own installer, available to subscribers.

Three skills cover the operation, from installation to day-to-day use:

- **`agents-onboarding`:** brings the stack up from zero on a VPS (Coolify, Portainer or compose) and validates it end to end.
- **`agents-operation`:** investigates production conversations and adjusts the agent's behavior, with every change approved.
- **`agents-dev`:** clones the code and drives development following the project's invariants.

## Features

### 🤖 Agent

- **LangGraph TS** runtime with durable per-conversation memory (checkpointer in Postgres).
- Multi-model per agent: OpenAI, Anthropic, Google, DeepSeek, **OpenRouter** and **local models** via an OpenAI-compatible endpoint (Ollama, LM Studio, vLLM), with the key in the vault.
- Progressive editor: prompt, tools, behavior and knowledge base in one place.
- **Playground** to chat with the agent before putting it live.

### 💬 WhatsApp and channels (via Chatwoot)

- One agent, **many inboxes**, with per-inbox routing.
- WhatsApp's 24-hour window respected, with **HSM templates** for proactive sends outside the window.
- **Channel redirect:** optionally use official WhatsApp only as the entry door and take the conversation to the website chat, with no per-message cost during the service.
- Omnichannel: any channel Chatwoot supports.

### 🎙️ Multimodal and humanization

- **Voice-note transcription** (STT): OpenAI, Gemini, ElevenLabs or OpenAI-compatible.
- **Voice replies** (TTS) with per-contact preference (the customer chooses audio or text replies): OpenAI and ElevenLabs.
- **Vision:** interprets images and documents sent by the customer.
- **Debounce:** groups message bursts and answers once.
- **Split and "typing…":** breaks the reply up at a natural rhythm.

### 🧰 Tools and knowledge

- **Knowledge base (RAG)** with pgvector and a suggestion-approval queue.
- Native tools and **custom HTTP tools** (schema, host allowlist, credential in the vault).
- Integration catalog: toolpacks, MCP servers and native tools.
- Connect the agent to **external MCP servers**.

### 📈 Sales and operations

- **Google Calendar scheduling** with automatic reminders.
- **Pipeline Kanban:** the agent moves the card as the conversation progresses. Requires [Chatwoot fazer.ai Pro](https://fazer.ai/kanban).
- **Proactive follow-ups** that respect business hours.
- **Human handoff:** routes through the queue, or lets the agent pick the team or agent to hand off to.

### 🖥️ Operator console

- Dashboard with KPIs and **real LLM cost** (via Langfuse).
- Conversations with detail view, error notices and a re-engage action.
- Reusable components (building-block pools) to compose the agent's behavior.
- Channels, Webhooks, API keys, Logs, Admin and Settings.
- Multi-language (i18n) and light/dark theme.

### 🔌 Platform and API

- One core, three ways to drive it: **REST v1**, **MCP server** and **web console**.
- MCP server with OAuth 2.1 and write tools with **dry-run by default**.
- **Outbound webhooks** with HMAC, backoff retry and a dead-letter queue.
- **Per-stage execution logs**, with alerts (Discord or webhook) and retention.

### 🔒 Security and self-hosting

- Encrypted secrets **vault**.
- Auth with JWT and Google, first-run setup and signup control.
- PostgreSQL with **RLS** and a non-superuser runtime role.
- Deploy on **Docker**, Coolify, Portainer or compose.

## Editions

The **Free** edition is open-source (Apache 2.0) and includes everything above.

The **Pro** edition adds what operating at scale requires:

- **Multi-tenant:** several customers or brands in a single deploy, isolated in the database by RLS.
- **Your own branding:** the panel under your identity (white-label).

Details at [app.fazer.ai/#/agents](https://app.fazer.ai/#/agents).

## Stack

Bun + Elysia · React 19 + Tailwind CSS v4 · Prisma + PostgreSQL (pgvector) · LangGraph TS · Langfuse (observability, optional).

## Local development

```bash
bun install
cp .env.example .env      # DATABASE_URL, MIGRATION_DATABASE_URL, ENCRYPTION_KEY
docker compose up -d      # PostgreSQL (pgvector)
bun db:bootstrap          # runtime role + grants
bun prisma:migrate
bun dev                   # http://localhost:3000
```

## Links

- 🌐 Website: [fazer.ai](https://fazer.ai)
- 📚 Documentation: [`docs/`](docs/)
- 🤝 Contributing: [CONTRIBUTING-en.md](CONTRIBUTING-en.md)
- 💬 Support: support@fazer.ai

<div align="center">
<sub>Free under Apache 2.0 · Pro under a proprietary EULA · made with ☕ by fazer.ai</sub>
</div>
