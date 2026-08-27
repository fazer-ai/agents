# CLAUDE.md

**fazer.ai agents** é uma aplicação fullstack TypeScript (**Bun + Elysia + React 19 + Tailwind CSS v4**, Prisma/PostgreSQL, JWT, i18n, Biome) que roda **LangGraph TS** no backend para orquestrar agentes de atendimento (IA) sobre o **Chatwoot** fazer.ai. Construída sobre o template **bunfire** (cujos invariantes seguem documentados abaixo). Multi-tenant (`tenant_id` em tudo, isolamento por Prisma `$extends` + RLS), "um core, três transportes" (REST v1, MCP server, UI projetam sobre os mesmos services), distribuição Free (open-source) vs Full.

Guia detalhado por subsistema vive em [`docs/`](docs/); as seções abaixo cobrem o que não cabe lá ou que você deve manter em memória de trabalho.


## Uma PR fecha uma issue, e issue que nenhuma PR fecha está errada

Toda PR sai com `Fixes #N`. O par é o teste de granularidade dos dois lados: se você não consegue apontar a issue que **esta** PR fecha, ou a PR está fazendo mais de uma coisa, ou a issue está pedindo mais de uma.

Quando é a issue que não cabe, **reescrevê-la é parte do trabalho e vem antes do código**: uma issue com três entregáveis vira três issues, cada uma com o seu `Fixes`. Trocar por `Refs` e seguir em frente é o que produz a issue que ninguém consegue fechar, aberta pela metade e sem conseguir dizer o que falta.

Isso é mais estrito do que o [`CONTRIBUTING.md`](CONTRIBUTING.md) pede de quem contribui de fora, e de propósito: lá a orientação é sobre como escrever uma issue, e uma PR sem issue continua bem-vinda; aqui vale para quem também escreve as issues.

Quando de fato não couber, isso aparece pela necessidade concreta e se resolve ali. Não há lista de exceções, e não é esquecimento: a lista é o caminho pelo qual um default vira sugestão.

## Subsystem docs

Each line says what the doc covers and when to open it. **The doc is the current text; this list is not** — when they disagree, the doc wins.

- [`docs/ui.md`](docs/ui.md): the operator console screen map, the shared client primitives, the tool-selection grant model, the i18n/extract gotchas, and the **app shell** (who renders `<Layout>`, `<PageContainer>`, the sidebar/menu contracts). Read before adding or changing any screen or client primitive.
- [`docs/auth.md`](docs/auth.md): **who may create an account here** — the `/setup` first-run invariant (advisory lock + count re-check, so it holds under concurrency), `SETUP_TOKEN_REQUIRED`, `SIGNUP_ENABLED`, the two domain allowlists, and the threat model behind auto-promotion to ADMIN. Read before touching any registration or promotion path.
- [`docs/google-oauth.md`](docs/google-oauth.md): Google Identity Services wiring, enable/disable steps. Read when adding social login or removing it from a derived project.
- [`docs/modals.md`](docs/modals.md): the `<Modal>` controller pattern, the always-render rule (enforced by lint), and a checklist for async modal flows. Read when adding any modal, especially one that fetches or mutates.
- [`docs/frontend-env-vars.md`](docs/frontend-env-vars.md): `BUN_PUBLIC_*` build-pipeline propagation (Bun `define`, `env.ts`, Dockerfile, CI workflow). Read when exposing a new env var to the browser.
- [`docs/cdn-r2-setup.md`](docs/cdn-r2-setup.md): Cloudflare R2 setup for CDN-served frontend assets (`BUN_PUBLIC_CDN_URL`), comparing the custom-domain and Worker approaches. Read when wiring the CDN for the first time.
- [`docs/routing.md`](docs/routing.md): **BrowserRouter + the `serve.routes` carve-out** — why deep-link refreshes work, why `/api/*` is not served as HTML, and the smoke test to re-run on **every Elysia upgrade**. Read before touching `src/app.ts` routing, the catch-all, or the build's `publicPath`.
- [`docs/csp.md`](docs/csp.md): the Content-Security-Policy `src/app.ts` builds (enforced in prod, Report-Only in dev), where the inline-script hashes come from, and what Google Sign-In changes (including the COOP relaxation). Read when adding an external script, style, font or API origin.
- [`docs/realtime.md`](docs/realtime.md): the WebSocket feature — four patterns, Bun pub/sub, the frontend hook contract, and two load-bearing Elysia 1.4.x gotchas that make a socket fail **silently**. Skim before any WS edit.
- [`docs/i18n.md`](docs/i18n.md): `t()` / `translate()` separation, magic comments for dynamic keys, biome lint plugins that catch missing or malformed translations. Read when adding user-facing text.
- [`docs/eden-treaty.md`](docs/eden-treaty.md): two non-negotiable rules for the Eden client, both of which fail **silently** when broken. Read before declaring any client-side type that consumes the treaty.
- [`docs/tenancy.md`](docs/tenancy.md): the multi-tenant isolation model — closure-bound Prisma `$extends` + Postgres RLS, the branded `ScopedDb`, `runScoped`/`asSuperAdmin`, the non-superuser runtime role, and the SUPER_ADMIN cross-tenant gate. Read before any service that touches tenant data.
- [`docs/api-and-fleet.md`](docs/api-and-fleet.md): the "one core, three transports" service pattern, read API v1, instance identity, and the **outbound** webhook substrate (`emitOutbound` + the single-replica delivery worker). Read when adding a read endpoint, an outbound event, or touching the worker.
- [`docs/integrations.md`](docs/integrations.md): the integration catalog (TOOLPACK/MCP/NATIVE), the **generic inbound receptor** (`/api/v1/integrations/inbound/:routeToken`), pure mappers + registry, and the `agentNudge` seam. Read when adding any integration or inbound webhook.
- [`docs/graph.md`](docs/graph.md): the **agent runtime** (LangGraph TS) — the checkpointer, the model factory over five providers, the supervisor graph, and `runAgentTurn`. Read before touching the graph, models, checkpointer, or the webhook→runtime seam.
- [`docs/chatwoot.md`](docs/chatwoot.md): the **dedicated** Chatwoot integration — dual-token client, the Agent Bot webhook receiver (route-token resolution, HMAC, ack<5s, idempotency ledger), the attribution gate, one-bot-many-inboxes routing, and provisioning. Read before touching the Chatwoot client, receiver, or bot provisioning.
- [`docs/debounce.md`](docs/debounce.md): **inbound message coalescing** (WhatsApp burst grouping) — the webhook branch, the dedicated fast worker and the scheduler lane split, the watermark + post-response supersede that answer a burst **at most once**, and the per-agent config. Read before touching `src/modules/debounce/*`, the scheduler claim split, or the webhook→runtime seam.
- [`docs/stt.md`](docs/stt.md): **voice-note transcription + inbound message rendering** — eager STT at arrival (the transcription lives only in Chatwoot, never our DB), the generic provider registry, and `renderInboundMessage`, which shapes every message for the agent on both the direct path and the flush. Read before touching `src/modules/stt/*`, `chatwoot/render.ts`, the message parser, or the eager-STT seam.
- [`docs/tts.md`](docs/tts.md): **audio replies + per-contact voice preference** — the three reply modes, the generic provider registry, `prepareSpeechText`, and where the preference is stored (an RLS column, **not** a Chatwoot custom attribute). Read before touching `src/modules/tts/*`, `client.sendAudioMessage`, the `set_voice_preference` tool, or the reply-modality branch.
- [`docs/playground.md`](docs/playground.md): the **agent playground** — the production toolset MINUS native conversation tools, on a **fenced** thread that a client-supplied id cannot escape. Read before touching `src/modules/playground/*` or the playground endpoint.
- [`docs/split.md`](docs/split.md): **split + typing (humanized delivery)** — TEXT replies only, off by default: how `deliverReply` splits a reply into balloons and paces them, plus the per-agent config. Read before touching `src/modules/split/*`, `client.toggleTyping`, or the text-delivery branch.
- [`docs/channel-redirect.md`](docs/channel-redirect.md): **WhatsApp → website-chat redirect** — official WhatsApp as an entry door only, the gate that stamps the contact and mints a single-use token in the URL **fragment**, and why no inbox is provisioned from our side. Read before touching the webhook gate or the mint/resolve endpoints in the fork.
- [`docs/contact-auth.md`](docs/contact-auth.md): the **contact authorization gate** — ask an operator-configured endpoint whether the CONTACT may be served, before the turn. Identity is the mirrored identifier and never model text; **fail-closed**, and re-checked on every message unless `mode: "once"`. Read before touching the gate or its seams in `webhook.ts`/`nudge.ts`.
- [`docs/service-window.md`](docs/service-window.md): the **WhatsApp 24h window + HSM templates**, for proactive sends only (reactive replies are always in-window) — the `Conversation.lastInboundAt` anchor, `proactiveSendMode`, and the fallback to a private note when no template is configured. Read before touching the service-window module, `client.sendTemplate`, or the gate in `runAgentNudge`.
- [`docs/spend-ceiling.md`](docs/spend-ceiling.md): the **per-tenant token ceiling** (`tenant.settings.spendCeiling`) — a calendar-month sum of `prompt + completion` over `LlmUsage`, counted in TOKENS, with SEPARATE ceilings for `inbox` and `playground` so testing cannot silence the agent for customers. Over it: the operator's sentence as the persona, a handoff, a private note; below it, a `warnAtPercent` warn on the FIRST verdict at or past the fraction. Which gate answers for which billed call is written down per ledger node in `spend-ceiling/coverage.ts` and fenced against `USAGE_NODE_IS_AGENT_TURN`. A refusal is only reported where a refusal HAPPENED: every gate sits after whatever would have stopped the call anyway (an unreadable file, a missing agent, a retired job, an empty burst) and immediately before the call. An unreadable ceiling ALLOWS the call. Read before touching `src/modules/spend-ceiling/*` or adding a billed call.

- [`docs/deploy.md`](docs/deploy.md): the deploy contract — the **two database roles** (superuser for migrate/bootstrap, non-superuser for runtime, with boot fail-fast), the boot ordering, and the **single-replica / one-leader** invariant. Read before touching Dockerfile/compose/`db-bootstrap`/boot sequence.
- [`docs/mcp.md`](docs/mcp.md): the **MCP server + OAuth 2.1** (third transport) — discovery order, the access token and its revocation denylist, the grant, per-request principal-bound tools behind the tenant fence, the write tools' dry-run-by-default, and the checkpointer thread-prefix fence. Read before touching anything under `src/modules/mcp/`.
- [`docs/documents.md`](docs/documents.md): **document templates + issuance + delivery** — the closed block vocabulary, the declared `fields` that BECOME the agent tool's argument list, token resolution, totals computed by the renderer and never by a model, and the two-phase idempotent `issueDocument`. Read before touching the documents module, the document tools, or the attachment queue.
- [`docs/logs.md`](docs/logs.md): **execution-flow logs + alerting + retention** — the per-stage `ExecutionLog` (fire-and-forget, PII-free), the alert channels with coalescing dispatch, the per-tenant retention job, and the keyset `GET /v1/logs`. Read before touching the flowlog module, the seam wiring, or the Logs page.
- [`docs/bun-compile-segfault.md`](docs/bun-compile-segfault.md): why the deploy runs the TypeScript entrypoint **interpreted** (`bun src/index.ts`) and not a `bun build --compile` binary, which segfaults on boot. Read before changing the Dockerfile entrypoint or reaching for `--compile`.
- [`.claude/rules/prisma.md`](.claude/rules/prisma.md): the Prisma/migrations constraints — externally-managed tables, the pgvector index Prisma does not model, RLS around data migrations, the querying traps that produce **no error**, the real precondition for `DROP COLUMN`, and the fact that a Postgres catalog column has a version. It carries a `paths:` header, but read it before any schema, migration or bootstrap change.

The three operational **skills** (`.claude/skills/agents-{onboarding,operation,dev}/`) are the living, agent-facing procedures for standing up, operating, and developing an instance. Read the relevant one when the task is a full journey (deploy from zero, debug a live conversation, or onboard a contributor) rather than a single-subsystem change.

## Development setup

- Before configuring `DATABASE_URL` in `.env`, check for existing PostgreSQL instances by scanning ports (e.g. `lsof -nP -iTCP:5432 -sTCP:LISTEN` on macOS, `ss -tlnp | grep 543` on Linux). Use port 5432 as the default, but if it is already in use by another service, pick the next available port (5433, 5434, etc.) and set `POSTGRES_PORT` accordingly in `.env`
- **Never run a bare `prisma migrate reset`**: it recreates the `public` schema and wipes the runtime role's grants, so every query on the next boot fails with Postgres `42501` (`permission denied for schema public`). Use `bun db:reset` (reset + `db:bootstrap`) instead, or re-run `bun db:bootstrap` after any reset (including a `migrate dev` that resets on drift). Details in `docs/deploy.md`
- **Inspecting the DB directly with `psql`: `DATABASE_URL` is the NON-superuser runtime role (`fazerai_app`) and RLS is enforced on it.** A raw `psql "$DATABASE_URL"` query without a tenant context returns **zero rows** for every tenant-scoped table (e.g. `agents`) — the rows are there, RLS is just filtering them. This is a silent empty result, not an error, so it reads like "the record doesn't exist" when it actually does. To read across tenants for diagnostics, either (a) connect as the superuser via `MIGRATION_DATABASE_URL` (the `postgres` role, which BYPASSES RLS — read-only only, never mutate prod), or (b) set the GUC in-session first: `SET app.tenant_id = '<id>';` (or, for the cross-tenant path's own role, `BEGIN; SELECT set_config('role', public.fazerai_fleet_role(), true); SELECT …; COMMIT;` — the `true` is transaction-local, so in psql's autocommit the role resets the moment that `SELECT` returns and the next query runs as the ordinary role again; `SET app.is_super_admin` has granted nothing since #382) before the `SELECT`, matching the `set_config('app.tenant_id', …)` the app issues per request (`src/lib/tenancy/multi-tenant.ts`). Do NOT conclude a row is missing from a bare runtime-role query. See [`docs/tenancy.md`](docs/tenancy.md)

## Common commands

| Command                            | Description                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `bun dev`                          | Start dev server with hot reload (port 3000)                                             |
| `bun build`                        | Build frontend assets to `dist/`                                                         |
| `bun test`                         | Run tests                                                                                |
| `bun test:coverage`                | Run tests with coverage report                                                           |
| `bun lint`                         | Lint with Biome                                                                          |
| `bun format`                       | Format with Biome                                                                        |
| `bun check`                        | Lint + type-check + i18n + tests                                                         |
| `bun prisma:migrate`               | Run database migrations                                                                  |
| `bun db:bootstrap`                 | Provision the NON-superuser runtime role + schema grants (run after any reset)           |
| `bun db:reset`                     | Reset the database AND re-provision runtime-role grants (never bare `migrate reset`)     |
| `bun db:test:setup`                | Provision/migrate the isolated test database                                             |
| `bun prisma:generate`              | Generate Prisma client                                                                   |
| `bun i18n:extract`                 | Extract translation keys (also part of `bun check`)                                      |
| `bun set-admin <email> [password]` | Promote a user to admin (creates the user if it doesn't exist; optionally sets password) |


## Project layout

**App:**

- `src/modules/`: the **core** domain services — one folder per subsystem (`agents`, `chatwoot`, `debounce`, `stt`, `tts`, `rag`, `integrations`, `scheduler`, `vault`, `flowlog`, `followups`, `handoff`, `kanban`, `playground`, `service-window`, `split`, `webhooks`, `mcp`, `models`, …). The "one core, three transports" services live here; REST v1 / MCP / UI all project over them
- `src/graph/`: the LangGraph TS agent runtime + `tools/` (native tools)
- `src/api/`: Elysia backend — `features/` (auth, admin, health, i18n), `v1/` (REST v1 controllers + the MCP mount — the read API / fleet transport), `lib/`, `middlewares/`, `locales/`
- `src/lib/`: shared libs, incl. `tenancy/` (Prisma `$extends` + Postgres RLS)
- `src/client/`: React frontend (`pages/`, `components/`, `contexts/`, `hooks/`, `lib/`, `locales/`)
- `src/app.ts`: Elysia app setup · `src/config.ts`: env config · `src/index.ts`: entry point
- `prisma/`: schema + migrations · `public/`: static assets + `index.html` · `build.ts`: custom build (Tailwind plugin)
- `scripts/`: `db-bootstrap.ts`, `set-admin.ts`, `seed-local-demo.ts`, `i18n-extract.ts`, `gen-onboarding-env.ts`, MCP smoke checks, `setup.ts` (legacy template init)
- `tests/`: test suite mirroring `src/` (`api/`, `client/`, `graph/`, `lib/`, `modules/`)
- `workers/cdn/`: Cloudflare Worker for CDN-served frontend assets
- `Dockerfile` + `docker-compose.yml` (dev) / `.prod.yml` / `.coolify.yml` / `.portainer.yml` (deploy targets)


## Theming

- All colors are CSS custom properties defined in the `@theme` block in `public/index.css` (dark mode defaults). Light mode overrides live in the `html[data-theme="light"]` block in the same file
- When adding a new color, always define both the dark value (in `@theme`) and the light value (in `html[data-theme="light"]`)
- Never use hardcoded Tailwind color classes (e.g. `bg-red-500`, `text-blue-100`) or hex values in components. Always use the CSS variable-based classes (`bg-error`, `text-accent`, `border-border`, etc.)
- For text on accent-colored backgrounds (e.g. primary buttons), use `text-accent-foreground` which flips between dark/light text per theme
- For theme-aware static assets (e.g. logos), use the `useThemedAsset` hook from `ThemeContext`. It appends `-light` before the file extension in light mode (e.g. `logo.png` becomes `logo-light.png`)
- The `ThemeProvider` wraps the entire app in `App.tsx`. Use `useTheme()` to access `{ theme, resolvedTheme, setTheme }`
- An inline script in `public/index.html` sets `data-theme` before React hydrates to prevent flash of wrong theme
- Theme preference is stored in localStorage under `@app:theme` (values: `auto`, `light`, `dark`)

## Encryption

- `ENCRYPTION_KEY` env var is used to encrypt sensitive data at rest in the database (API tokens, secrets, credentials)
- Always use `encryptJson()` / `decryptJson()` from `src/api/lib/crypto.ts` for sensitive data. **Store the resulting base64 blob in a plain `String` (or `Bytes`) column, never a Prisma `Json` column** — `encryptJson` returns a base64 string, and putting secrets in a `Json` column invites accidental logging/serialization. (e.g. `VaultEntry.secret`, `ChatwootInstance.adminToken`/`agentBotToken`/`webhookSecret` are all `String`.) Throw, don't fall back, when a blob fails to decrypt
- The key must be set to a unique, strong value in production (min 32 characters recommended)
- Changing the key will invalidate all previously encrypted data. Plan a migration if key rotation is needed
- Never log, expose in API responses, or include in frontend bundles

## Code style

- Biome for linting and formatting (2-space indent, LF line endings)
- Path alias: `@/` maps to `src/`
- Strict TypeScript
- Husky pre-commit hooks run lint, type-check, and tests
- Prefer `Bun.file(path).text()` / `Bun.file(path).json()` over `node:fs` for file reads. The Bun API is idiomatic in this runtime and supports both sync and async patterns cleanly.
- Always run `bun check` after applying all code changes to ensure code quality and correctness
- Only add comments when strictly necessary, never obvious/redundant ones. **Where the tag goes**: a comment that DOCUMENTS a symbol (the module header at the top of a file, or the docstring directly above a declaration, exported or not) carries **no** tag; a comment INSIDE a body must have one: `// TODO:`, `// NOTE:`, or `// FIXME:`. Spelled out because the shorter phrasing reads as "every comment needs a tag", which makes review tooling flag every docstring in the tree
- **Cursor styles**: `cursor: pointer` is set globally on `button`, `select`, `[role="button"]` in `public/index.css`. Never use `cursor-pointer` on individual elements. Only use cursor utilities for overrides like `cursor-not-allowed` on disabled states
- Use the `cn` utility for component classNames. For conditional classNames, use object syntax `cn("base", { "active": isActive })`, not ternary operators
- Add `aria-*` attributes for accessibility on interactive elements
- **`FormField` `group` prop**: a `<FormField>` whose children are NOT a single focusable control (segmented/pill toggles, a list with an "Add" button, multiple inputs, a custom picker) MUST receive `group`. Without it, `FormField` renders a `<label>` and the browser forwards a click on the field title (and on the empty space beside the children) to the first focusable descendant, so clicking the title silently activates the first button. `group` instead renders `<div role="group" aria-labelledby>` with a plain `<span>` title (clicking it does nothing), keeping screen-reader grouping. Only omit `group` when the single child is a real `<input>`/`<select>`/`<textarea>` that legitimately wants the label-for-control behavior. Reference: `src/client/components/FormField.tsx:17-24`
- **Never use the HTML `title` attribute** (the native browser tooltip: unstyled, no touch/keyboard support, inconsistent across browsers, and it collides with our `<Tooltip>`). When a hover/focus hint adds value, use the `<Tooltip>` primitive (`src/client/components/Tooltip.tsx`): `<Tooltip content={hint}><button …/></Tooltip>`. It wraps a single child via Radix `asChild`, so native elements (`<button>`/`<span>`/`<a>`/`<div>`) go directly inside, but components that don't `forwardRef` (e.g. our `<Button>`) need a `<span className="inline-flex">` wrapper inside the `<Tooltip>` (see `Gated` in `PlaygroundChat.tsx`). This does NOT apply to the `title` **prop** of components (`<Modal>`/`<EmptyState>`/`<Section>`) or the document `<title>` — those are legitimate
- Always check `.env.example` when adding new environment variables to ensure consistency

## Branding

- "fazer.ai" is always lowercase. "fazer-ai" is acceptable in slugs/identifiers. Never "Fazer.ai" or "Fazer.AI"

## UX

- Always consider UX for backend requests: loading states, debouncing, error handling, and user feedback

### Loading states: skeletons over spinners

- **Skeletons are the default** for content that is loading: page data, lists, tables, cards, dashboards, message threads, anything whose final layout shape is known ahead of time. They preserve layout (no content shift when data arrives), communicate the shape of what's coming, and lower perceived latency. Use the `<Skeleton>` primitive (`src/client/components/Skeleton.tsx`): a single styled `div`, so compose several to mirror the real layout (`<Skeleton className="h-4 w-32" />`). It carries `animate-pulse` (neutralized by the global `prefers-reduced-motion` rule in `public/index.css`) and `aria-hidden` — wrap the loading region with `role="status"` + a visually-hidden `t("common.loading")` label so screen readers still get an announcement.
- **`<DataBoundary>` is the chokepoint.** Its `loading` branch renders a skeleton, not a spinner: a generic row-skeleton by default (covers the row-list pages: Agents, the Resources pools, Experiments, etc.) and a caller-supplied `skeleton={<…/>}` for distinctive layouts (Dashboard cards+chart, Conversations list, Channels two-section, the Agent editor form). The `role="status"` + sr-only label live inside `DataBoundary`, so a bespoke `skeleton` prop only supplies the visual placeholder. Pages that don't use `DataBoundary` (admin tables, Approvals, the conversation message thread) replace their inline loading branch with the same composition and wrap it in `role="status"` + sr-only themselves.
- **Spinners are the exception, used sparingly**, reserved for: button loading states (`<Button loading>` renders an inline spinner) and the app-boot / auth-resolution / invite-token splash (`AuthContext`, `ProtectedRoute`, `AcceptInvitePage`, where we can't skeleton the shell because we don't yet know whether to render the app or redirect). Both are intentional, not inconsistencies. Reach for a spinner only when there's no meaningful layout shape to stand in for.
- **Don't skeleton sub-perceptible or unknown-shape loads.** A skeleton that flashes for a single frame is worse than nothing. For very fast loads (<~300ms) prefer no indicator; for genuine waits on known layout, prefer a skeleton.
