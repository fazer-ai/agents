# WhatsApp 24h service window + HSM templates

WhatsApp only allows free-form business messages within 24h of the customer's last inbound message. Outside that window, a proactive message must be an **approved template (HSM)** or it is rejected. This gates the **proactive** paths (follow-up / inbound-event nudge) — the reactive reply is always in-window (the customer just messaged). Per agent, **on by default**.

## Anchor

`Conversation.lastInboundAt` (`mirror.ts`) advances only on an **incoming** customer message (`isIncomingMessage`), under the same monotonic per-conversation lock as the rest of the mirror. NULL = no inbound ever → treated as outside the window (a business-initiated first contact needs a template).

## Decision (`src/modules/service-window/service.ts`)

`proactiveSendMode(cfg, lastInboundAt, now)` → `freeform | template | note`:

- gate disabled → `freeform` (operator opt-out / a channel with no 24h window);
- `isWithinServiceWindow` → `freeform`;
- outside → `template` if THIS occasion has a template (`resolveTemplateChoice`, below), else `note`.

`runAgentNudge` applies it right before the customer post (after the ownership re-check — for inactivity follow-ups that re-check hits the LIVE Chatwoot conversation, `requireLiveBotOwnership`): `freeform` → `sendMessage`; `template` → `buildTemplatePayload` → `client.sendTemplate` (HSM); `note` → `sendPrivateNote` with the `OUTSIDE_WINDOW_NOTE_PREFIX` header prepended (pt-BR, explains the yellow note: "não foi enviada ao cliente, configure um template") — never a free-form message WhatsApp would reject. Outcomes: `templated` for the HSM path, `noted-window` for the fallback note. For the inactivity follow-up sequence, `noted-window` **ends the sequence** (one explained note, not N — every further step would be equally undeliverable, and the conversation stays visibly unresolved for the operator). On this outcome the step's post-actions run **without the auto-resolve** (labels still apply): nothing reached the customer, so resolving would close the conversation unanswered.

`buildTemplatePayload` fills the occasion's template and keys it the way Chatwoot's `processed_params` reads it (`Whatsapp::TemplateProcessorService` in the fork): `body` and `header` by placeholder (`"1"`, `"2"`… or the names of a `NAMED` template), `buttons` by POSITION, one entry per button of the template, `{ type: "static" }` for a button that takes nothing (Chatwoot's converter needs a `type` on every entry, or it reads the whole payload as legacy body params), `{ type: "url", parameter }` for a dynamic URL button's suffix. Placeholders are the prompt's (`{{nome_contato}}`, `{{primeiro_nome}}`…, via `buildPromptVars`/`interpolatePromptVars`) plus, on an appointment reminder only, the appointment's: `{{data_agendamento}}`, `{{hora_agendamento}}`, `{{dia_semana_agendamento}}`, `{{agenda}}` (English spellings `appointment_date`, `appointment_time`, `appointment_weekday`, `calendar_name`), worded in the template's language. A start with a stated offset is read in that wall clock (it IS the calendar's, `+00:00` included), one in UTC (`Z`, or `-00:00`, ISO 8601's "unknown") in the agent's zone, an all-day one has no time. Right before the send `runAgentNudge` reads the inbox's synced templates (best-effort): with the definition, `content` is the text the customer reads (header, body with the values, footer) and a `NAMED` template is keyed by name; without it the send still goes, positional. `client.sendTemplate` posts `{ content, message_type: "outgoing", template_params: { name, category, language, processed_params } }`.

## Which template an occasion sends

Every proactive caller names its kind on the nudge (`AgentNudge.template`, never rendered to the model): `followup` (inactivity follow-up), `snoozed_followup`, `appointment_reminder` (with its offset and appointment), `inbound_event`, and `channel_redirect` (the WhatsApp link follow-up, which sends through `buildTemplatePayload` directly). `resolveTemplateChoice` picks, first match wins: the reminder's own offset in `reminderTemplates`, the kind in `templates`, then the default (`templateName` and its params). A kind with neither becomes the explained note, so an agent can send templates for reminders only and leave the rest as notes. An approved document is not a kind: it travels as an attachment, which outside the window becomes the approval's own note.

## Configuration

Per-agent `agent.settings.serviceWindow` (`readServiceWindowConfig`): `enabled` (default true), `windowHours` (default 24, clamped 1–168), the DEFAULT template: `templateName` (null → skip→note), `templateLanguage` (default `pt_BR`), `templateCategory` (default `UTILITY`), `templateParams` (body), `templateHeaderParams` (a TEXT header), `templateButtonParams` (per button, by position), `templateContent` (optional); `templates` (per kind: `{ name, language, category, params, headerParams, buttonParams, content }`, `null` = the default) and `reminderTemplates` (the same choice per reminder offset in hours, the offsets the calendar toolpack arms). Editor **Behavior** tab + REST (`PATCH /v1/agents/:id`) + MCP (`agent_settings_get`/`agent_settings_set`, the `serviceWindow` block).

**At save** (`src/modules/service-window/save.ts`, REST and MCP alike, the MCP dry run included): a key of `templates` that is not a kind, an offset that is not a whole number of hours (1–8760), or an appointment placeholder anywhere but a reminder's choice is refused. Then every choice the write SETS OR CHANGES is judged against the agent's inboxes' synced templates (read outside the row lock), in every inbox that has the template, since two accounts can hold the same name with different components: the name has to exist as an approved template, in that language, with exactly as many body and header parameters as it has placeholders, none of them blank (Chatwoot drops an empty value before it reaches WhatsApp),, a suffix for every dynamic URL button and none for the others; a media header is refused, since nothing fills it. A choice the write leaves as it was is not re-judged, so a template retired at Meta never blocks saving the window hours. When the templates cannot be read (no inbox, an instance down, an unofficial channel with none) nothing is judged and the write goes through.

**The screen.** Each choice is a picker over the synced templates, then one field per placeholder of each component, and a preview rendered by the same `buildTemplatePayload` the send uses, with a sample contact and, on a reminder, a sample appointment. Without synced templates the name, language and body params are typed by hand.

**Editor UI grouping (cosmetic).** In the Behavior tab the service window is presented as a sub-section of a single **"Proactive messages"** card, below the follow-up sub-section: follow-up is *when* to reach out, the 24h window is *how* the proactive send is delivered (in-window free-form vs out-of-window template/note). This is purely a UI grouping — the modules stay independent and the window still governs **every** nudge (not only follow-up), per `runAgentNudge`.

## Validated live

Header text params, body params and a dynamic URL button were sent through Chatwoot's `sendTemplate` against an approved template on a WhatsApp Cloud inbox (PR for #1563); the payload shape above is the one that delivered.

Read before touching `src/modules/service-window/*`, `AgentNudge.template`, `Conversation.lastInboundAt`, `client.sendTemplate`, or the proactive-send gate in `runAgentNudge`.
