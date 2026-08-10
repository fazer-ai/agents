# STT (voice-note transcription) + inbound message rendering

WhatsApp customers send voice notes constantly. STT transcribes them so the agent can read and answer; the same pass also shapes every inbound message (audio/image/file markers, quoted-message context) into the text the agent sees, mirroring the n8n "Extrair mensagem" node. On by default per agent (effective only once a provider credential is configured).

## Flow (eager, at message arrival)

```
incoming message with an audio attachment (gate=act)
        │  webhook (processChatwootDelivery)
        ▼
   resolveSttConfig → enabled?  ── no ─→ audio renders as "<…não audível; peça texto>" marker
        │ yes
        ▼
   transcribeInboundAudio:
     download data_url (client.downloadAttachment, anti-SSRF, 404-retry) →
     provider.transcribe (key from vault) →
     cleanTranscription (drop Whisper's Amara.org silence hallucination) →
     client.updateAttachmentMeta { transcribed_text }   ← write-back (no body mirrored in OUR DB)
        │  also stashed on the in-memory event (n.message.transcribedText) for the direct path
        ▼
   arm debounce / direct turn  (the flush re-fetch reads transcribed_text back)
```

STT runs **before** arming/answering so the debounce re-fetch (and the direct path) get text instead of an empty audio message. The transcription lives only in Chatwoot (attachment meta), never in our DB — consistent with the anti-PII no-body-mirror rule. Best-effort: any STT failure leaves the audio to render as a "please send text" marker and never strands the delivery.

**The download races Chatwoot's own storage write.** `message_created` carries the attachment's `data_url` but is dispatched *before* ActiveStorage finishes writing the file, so the eager download (it fires ~70ms after the webhook) can hit the storage service ahead of the bytes and get a **404** — the voice note then goes untranscribed and the customer is asked to "send text" for an audio that is perfectly fine. `downloadAttachment` therefore takes `retryOnMissing`, retrying **404 only** on a bounded backoff (250/750/1500ms, ~3 extra seconds worst case, inside a typical debounce window); every other status still fails immediately. The eager STT/vision path opts in; the interactive media proxy (`getConversationMedia`) does **not**, because there a 404 means the file is genuinely gone and the operator must not wait out the backoff. A download failure now also emits its own `stt`/`vision` line (warn + `status: error`, `detail.step = "download"`): it sits outside the `withFlowStage` span, so before this it left **no** trace on the Logs page at all.

## Generic provider abstraction (`src/modules/stt/providers.ts`)

The OpenAI `/audio/transcriptions` multipart shape is a de-facto standard, so `openai` and `openai-compatible` (Groq, self-hosted faster-whisper, …) share one adapter (baseURL switch). Gemini (inline base64 → `generateContent`, key in `x-goog-api-key`) and ElevenLabs (`/speech-to-text`, `xi-api-key` + `model_id`) get thin adapters. **Adding a provider = one function + one registry entry**; a future generic/declarative provider slots behind the same `SttProvider` interface without touching callers. `SttError` never captures the response body (PII). Provider is selectable per agent; the API key is a **vault** entry referenced by a stable `vault:<id>` ref (renaming the secret never breaks the agent).

| Provider            | Default model       | Endpoint                                   | Auth             |
| ------------------- | ------------------- | ------------------------------------------ | ---------------- |
| `openai`            | `whisper-1`         | `…/v1/audio/transcriptions`                | `Bearer`         |
| `openai-compatible` | (set yours)         | `{baseURL}/audio/transcriptions`           | `Bearer`         |
| `gemini`            | `gemini-2.0-flash`  | `…/models/{model}:generateContent`         | `x-goog-api-key` |
| `elevenlabs`        | `scribe_v1`         | `…/v1/speech-to-text`                       | `xi-api-key`     |

## Inbound rendering (`src/modules/chatwoot/render.ts`)

`renderInboundMessage` turns one message into agent-facing text, shared by the direct path (`runAgentTurn`) and the debounce flush so both behave identically:

- **text** → as-is.
- **audio** → `<mensagem-de-audio>{transcription}</mensagem-de-audio>`, or a "não audível; peça texto" marker when transcription is empty/failed.
- **image** → marker asking the customer to send text/audio (no vision yet).
- **location** (a WhatsApp pin) → `<localização latitude="…" longitude="…" titulo="…">` — coordinates + place title from the attachment (`coordinates_lat`/`coordinates_long`/`fallback_title`); the model forwards them as ordinary tool args. `(0,0)` is the column default, treated as "no coordinates"; a pin with neither coordinates nor title falls back to the generic marker.
- **other file** → `<usuário enviou um arquivo do tipo '{type}'>`.
- **quoted/replied-to** (`content_attributes.in_reply_to`) → prefixed with the referenced snippet, resolved from the re-fetched page (flush) — omitted on the direct path (no page).

The flush's `pendingIncoming` now includes voice notes (empty content + an attachment), not just text. `parseChatwootMessages` reads `attachments[].meta.transcribed_text` (REST list) so the re-fetch surfaces the write-back.

## Configuration

Per-agent, in `agent.settings.stt` (free-form bag, validated by `readSttConfig`): `enabled` (default `true`), `provider` (default `openai`), `model` (`""` → provider default), `language` (ISO, default `pt`), `credentialRef` (a `vault:<id>` ref), `baseURL` (openai-compatible). Surfaced in the agent editor's **Behavior** tab and writable over REST (`PATCH /v1/agents/:id`) + MCP (`agent_settings_get`/`agent_settings_set`, the `stt` block; the MCP transport translates the `vault:<id>` ref to/from the entry **name** at its boundary — agent-friendly — never the secret). No env vars — the credential is a per-tenant vault secret.

## Known limits

- Vision is not implemented: images become a "send text/audio" marker (n8n parity — it was a placeholder there too).
- Attachment download follows storage redirects (S3) without re-validating the redirect target (TOCTOU); the data_url comes from the HMAC-authenticated webhook of the tenant's own Chatwoot.
- If STT is slower than the debounce window the flush may re-fetch before write-back lands; the re-arm/supersede recovers on the next message. Whisper/Scribe are fast; rare.

Read before touching `src/modules/stt/*`, `chatwoot/render.ts`, the message parser, or the eager-STT seam in the webhook.
