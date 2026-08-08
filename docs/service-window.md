# WhatsApp 24h service window + HSM templates

WhatsApp only allows free-form business messages within 24h of the customer's last inbound message. Outside that window, a proactive message must be an **approved template (HSM)** or it is rejected. This gates the **proactive** paths (follow-up / inbound-event nudge) — the reactive reply is always in-window (the customer just messaged). Per agent, **on by default**.

## Anchor

`Conversation.lastInboundAt` (`mirror.ts`) advances only on an **incoming** customer message (`isIncomingMessage`), under the same monotonic per-conversation lock as the rest of the mirror. NULL = no inbound ever → treated as outside the window (a business-initiated first contact needs a template).

## Decision (`src/modules/service-window/service.ts`)

`proactiveSendMode(cfg, lastInboundAt, now)` → `freeform | template | note`:

- gate disabled → `freeform` (operator opt-out / a channel with no 24h window);
- `isWithinServiceWindow` → `freeform`;
- outside → `template` if `templateName` configured, else `note`.

`runAgentNudge` applies it right before the customer post (after the ownership re-check — for inactivity follow-ups that re-check hits the LIVE Chatwoot conversation, `requireLiveBotOwnership`): `freeform` → `sendMessage`; `template` → `buildTemplatePayload` → `client.sendTemplate` (HSM); `note` → `sendPrivateNote` with the `OUTSIDE_WINDOW_NOTE_PREFIX` header prepended (pt-BR, explains the yellow note: "não foi enviada ao cliente, configure um template") — never a free-form message WhatsApp would reject. Outcomes: `templated` for the HSM path, `noted-window` for the fallback note. For the inactivity follow-up sequence, `noted-window` **ends the sequence** (one explained note, not N — every further step would be equally undeliverable, and the conversation stays visibly unresolved for the operator). On this outcome the step's post-actions run **without the auto-resolve** (labels still apply): nothing reached the customer, so resolving would close the conversation unanswered.

`buildTemplatePayload` (body-only) interpolates `{{nome_contato}}`/`{{primeiro_nome}}` (via the shared `buildPromptVars`/`interpolatePromptVars`) into the positional body params → `processed_params.body = { "1": …, "2": … }`, with `content` for the dashboard. `client.sendTemplate` posts `{ content, message_type: "outgoing", template_params: { name, category, language, processed_params } }` (shape confirmed against Chatwoot's `sendTemplate`).

## Configuration

Per-agent `agent.settings.serviceWindow` (`readServiceWindowConfig`): `enabled` (default true), `windowHours` (default 24, clamped 1–168), `templateName` (null → skip→note), `templateLanguage` (default `pt_BR`), `templateCategory` (default `UTILITY`), `templateParams` (string[], placeholders allowed), `templateContent` (optional). Editor **Behavior** tab + REST (`PATCH /v1/agents/:id`) + MCP (`agent_settings_get`/`agent_settings_set`, the `serviceWindow` block).

**Editor UI grouping (cosmetic).** In the Behavior tab the service window is presented as a sub-section of a single **"Proactive messages"** card, below the follow-up sub-section: follow-up is *when* to reach out, the 24h window is *how* the proactive send is delivered (in-window free-form vs out-of-window template/note). This is purely a UI grouping — the modules stay independent and the window still governs **every** nudge (not only follow-up), per `runAgentNudge`.

## Open validations (HSM is the genuinely provider-specific part)

- `processed_params` is **BODY-only** here; header/button params and the exact shape for a given WhatsApp provider must be confirmed against a live approved template.
- The `sendTemplate` bot-token path (vs admin) and that the template name/language match an approved template synced into the inbox need a live check. Until then, prefer leaving `templateName` blank (outside-window → safe private note) on instances without a verified template.

Read before touching `src/modules/service-window/*`, `Conversation.lastInboundAt`, `client.sendTemplate`, or the proactive-send gate in `runAgentNudge`.
