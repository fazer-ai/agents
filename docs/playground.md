# Agent playground

Chat with a configured agent straight from the console — no Chatwoot, no webhook, no real conversation, no debounce, no auto-reply. It runs the **same** model + system prompt + knowledge/HTTP/MCP/integration tools as production, so the operator tests behavior faithfully before going live. (Closes the market-validation "no playground" gap.)

## Backend (`src/modules/playground/service.ts`)

`runPlaygroundTurn({ tenantId, agentId, message, threadId?, deps })`:

- Loads the agent config with `loadAgentConfig(..., { ignoreDisabled: true })` — the `enabled` toggle only gates production auto-replies, so the playground tests config regardless. Dummy `instanceId=0n`/`conversationId=0` → no mirror row → empty contact/prompt vars.
- Builds the toolset with only the **utility** native tools (`utilityNativeAllow` — calculator, get_current_time), excluding the native **conversation** tools (handoff/resolve/…) since there is no conversation to act on, while keeping knowledge, HTTP, MCP and integration tools live. A dummy client satisfies the type and is never called.
- Invokes the graph on a **fenced** playground thread and returns `{ reply, threadId, trace, sources }`.

### Multimodal capability gating (STT / vision / TTS)

Voice notes (STT), file attachments (vision) and audio replies (TTS) each need their own credential. Unlike the agent's overall `enabled` toggle (ignored — you test before going live), the per-feature `stt.enabled` / `vision.enabled` toggles **are** respected: a disabled feature reads as "not configured" both in the UI (the composer control is disabled with a reason) and in the service (`transcribePlaygroundAudio` / `extractPlaygroundFile` throw `errors.sttNotConfigured` / `errors.visionNotConfigured`). The live draft carries `enabled`, so the operator still tests before saving by flipping the toggle on. Audio **reply** is a manual playground toggle (`forceAudio`), so it only needs TTS configured, not `tts.enabled`. The reply is synthesized through the **same** `synthesizeReply` the inbox path uses, speech rewrite included (`buildSpeechNormalizer`): the operator hears what the customer would hear, and the rewrite's model call is billed like any other, tagged `source=playground` so it stays out of the dashboard and never pages an alert channel.

Extraction is **fail-soft**: a provider error (bad file, refusal, timeout) does NOT interrupt the turn — `extractPlaygroundFile` logs it at error-level (the ops alert channel) and returns the `unsupported` marker so the agent still answers. Vector/markup images (`image/svg+xml`) are classified unsupported up front (`visionKindForMime`), avoiding a guaranteed provider rejection. The inbound path (`extractInboundFile`) is symmetric (logs + returns `null`).

### Execution trace + KB sources (debug surface)

`runPlaygroundTurn` returns a sanitized `trace` (`src/graph/trace.ts`, `buildPlaygroundTrace`): the sequence of **tool calls** (name + args), **tool results** (output / `isError`), and any intermediate assistant reasoning for the latest turn only (it walks the messages after the last human message, and excludes the final reply — that is `reply`). Every arg/output passes through `src/lib/redact.ts` (`redactSecretsDeep`/`redactSecretsInText`) — credential-named keys are dropped and secret-shaped substrings scrubbed; a resolved credential can never reach here anyway (those live only in request headers at fetch time, never in a message). `search_knowledge` additionally returns its grounding via the LangChain **`content_and_artifact`** response format: the model still sees the passage string, while the ToolMessage carries a `{ sources: [{ marker, chunkId, kb, title?, url? }] }` artifact that the trace surfaces. `collectTraceSources` flattens+dedups them into the top-level `sources`. This is **internal traceability only** (item 2): nothing changes for the customer — the Chatwoot reply stays plain text/audio, the `[n]` markers are a grounding/attribution aid the model is told to cite.

### Thread fence (security)

The checkpointer is outside RLS, so the thread id is the tenant fence. Playground threads are `tenantId:playground:agentId:uuid`. A client-supplied `threadId` is honored **only** if it matches that exact shape for this tenant+agent; anything else (e.g. a real conversation's `tenantId:instanceId:convId`, or another agent's thread) is rejected and a fresh thread is generated. This stops a caller from reading another conversation's checkpointer history through the playground. Multi-turn memory works because the client holds the returned `threadId` across turns; Reset starts a new session.

## REST + UI

`POST /v1/agents/:id/playground { message, threadId? } → { reply, threadId, trace, sources }` (TENANT_ADMIN). The agent editor's **Playground** tab (`PlaygroundTab`) is a chat panel (Enter to send, Reset to restart) that holds the `threadId` in a ref; each agent reply is expandable into its `trace` + grounding `sources` (collapsible `<details>`). Tenant scoping is the `tenancyPlugin`; the thread fence is in the service.

## Client state & reply preservation

The chat state for one agent lives in a single hook, `usePlaygroundChat`, **lifted into the parent** `AgentEditorPage` (not inside a tab). `PlaygroundTab` (the dedicated tab) and `PlaygroundFab` (the floating panel over the config tabs) both receive the SAME instance, so they share one conversation. `turns` is parent state; switching editor tabs only unmounts the *view* (`{tab === "playground" && …}`), never the hook — so an in-flight reply lands in the parent's `turns` and is there when you switch back. Leaving the editor entirely (a route change) does unmount the hook, but the reply is still not lost: the server persists every turn to the checkpointer, and on the next mount the hook reloads the most recent session from it (`loadSession(latest.threadId)`).

The request is never aborted by the client (no `AbortController` on the playground calls) — and that is deliberate: a navigation mid-turn lets the server finish and persist the turn rather than killing it, so the checkpointer reload above can recover it. `send`/`sendRecording`/`sendFile` each reset their in-flight flag in a `finally` (so `sending`/`busy` can never stick), and any failure (including a dropped connection) appends a recoverable **error bubble** via `pushError` while leaving the user's message in place — the operator just resends.

**Dev-only caveat (HMR).** Under `bun dev`, editing a file hot-reloads the server (dropping any in-flight playground request → an error bubble) and may Fast-Refresh the client bundle (which can reset React state, clearing `turns` for that render). This looks like "the reply was lost when I switched tabs", but it is a development artifact of the restart, not the production path: production keeps the reply as described above, and a reload reconstructs the session from the checkpointer for any turn that was persisted. A turn that was still in flight when the dev server restarted was never persisted, so only that one is gone — re-send it.

## MCP (third transport)

The `agent_playground` **read** tool (`mcp:read`, `src/modules/mcp/server.ts`) mirrors the REST endpoint so an AI agent can drive the playground: `{ agent_id, message, thread_id? } → { reply, threadId, trace, sources }`, principal-bound + tenant-fenced (a `null`-tenant SUPER_ADMIN token must target a tenant). It is deliberately **read**, not `mcp:write` — but its tool description warns that the agent's HTTP/integration tools still execute for real, so it is a live test, not a pure simulation.

Read before touching `src/modules/playground/*`, `src/graph/trace.ts`, `src/lib/redact.ts`, the playground endpoint / `agent_playground` MCP tool, or `loadAgentConfig`'s `ignoreDisabled` path.
