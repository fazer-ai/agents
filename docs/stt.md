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
        │  AND in the in-process annotation store (chatwoot/annotations.ts) for the flush
        ▼
   arm debounce / direct turn  (the flush re-fetch reads transcribed_text back, overlaying the store)
```

STT runs **before** arming/answering so the debounce re-fetch (and the direct path) get text instead of an empty audio message. The transcription lives only in Chatwoot (attachment meta) plus a TTL-bound in-process cache, never in our DB — consistent with the anti-PII no-body-mirror rule. Best-effort: any STT failure leaves the audio to render as a "please send text" marker and never strands the delivery.

**The meta write-back is a fork route, not a requirement.** `updateAttachmentMeta` PATCHes a route that only exists on the fazer.ai Chatwoot fork; on upstream Chatwoot it 404s (logged as an `stt`/`vision` warn line, `detail.step = "write_back"`). The transcription still reaches the agent on both paths: the direct turn uses the returned value, and the debounce flush overlays the in-process annotation store (`src/modules/chatwoot/annotations.ts`, stash-at-transcription + overlay-at-re-fetch, 15-minute TTL) over whatever the attachment meta is missing. What the fork ADDS is persistence and visibility: human agents see the transcription in the Chatwoot UI, and it survives an app restart within the debounce window. The same contract covers the vision write-back (`image_description` / `extracted_text`).

**A transient vision failure is asked again, inside the budget one call used to have.** A 503 from the provider used to end the attachment permanently: `extract` was called once, and the "couldn't extract" marker is what entered the conversation history, so no later turn could recover the content (issue #319 — measured at 12 failures in 45 extractions on one tenant, nine of them 503, with the next turn succeeding 16s later on the same credential and model). `src/modules/vision/retry.ts` owns both halves of the answer: **which** failures are worth repeating (`408/429/500/502/503/504/529` and a timeout — never a 4xx about what we sent, and never a connection that would not open, which is as often a base URL that will never resolve), and **how long** each attempt may take. Two attempts with a jittered 500ms backoff, all of it inside `VISION_TOTAL_BUDGET_MS` (60s, the value the single call already carried), so no turn can get slower than it already could. **A ceiling only applies where a measurement backs it.** A non-final attempt on an image at the vendor's own endpoint is capped at 20s (measured live at 2.0-4.4s through gpt-4o, including a 3000x3000 one), which is what funds a second attempt inside the same total. The two unmeasured cases keep the whole budget instead: a **document** (up to 25MB and ~100 pages of provider work) and a **custom `baseURL`** (the operator pointed us at their own hardware — a self-hosted Qwen-VL, a proxy, a regional gateway — which our numbers say nothing about; the provider name does not answer this, since `openai` with a `baseURL` is not the endpoint that was measured). Both still gain a retry whenever the failure leaves room, which an overload usually does. The **last** attempt is never capped by the ceiling either: the ceiling exists to leave room for a next attempt, and after the last one there is none. That is also why there are two attempts and not three — a third would come out of the same total, and what it costs is the length of the last one. Measured live: with the vendor endpoint, a first attempt aborted at 20s and the second answered at 23.4s; with a `baseURL` set, the single attempt kept the full 60s exactly as before this change. `stt` has the same gap and is NOT covered by this: no retry of a provider call exists anywhere else in the codebase.

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
- **image/document with a vision extraction** → `<imagem>{description}</imagem>` / `<documento>{text}</documento>` (from `image_description` / `extracted_text`, meta or in-process overlay).
- **image without an extraction** (vision off/failed) → marker asking the customer to send text/audio.
- **location** (a WhatsApp pin) → `<localização latitude="…" longitude="…" titulo="…">` — coordinates + place title from the attachment (`coordinates_lat`/`coordinates_long`/`fallback_title`); the model forwards them as ordinary tool args. `(0,0)` is the column default, treated as "no coordinates"; a pin with neither coordinates nor title falls back to the generic marker.
- **other file** → `<usuário enviou um arquivo do tipo '{type}'>`.
- **quoted/replied-to** (`content_attributes.in_reply_to`) → prefixed with the referenced snippet, resolved from the re-fetched page (flush) — omitted on the direct path (no page).

The flush's `pendingIncoming` now includes voice notes (empty content + an attachment), not just text. `parseChatwootMessages` reads `attachments[].meta.transcribed_text` (REST list) so the re-fetch surfaces the write-back; `overlayMediaAnnotations` then fills anything the meta is missing from the in-process store (upstream Chatwoot, where the write-back route does not exist).

## Configuration

Per-agent, in `agent.settings.stt` (free-form bag, validated by `readSttConfig`): `enabled` (default `true`), `provider` (default `openai`), `model` (`""` → provider default), `language` (ISO, default `pt`), `credentialRef` (a `vault:<id>` ref), `baseURL` (openai-compatible). Surfaced in the agent editor's **Behavior** tab and writable over REST (`PATCH /v1/agents/:id`) + MCP (`agent_settings_get`/`agent_settings_set`, the `stt` block; the MCP transport translates the `vault:<id>` ref to/from the entry **name** at its boundary — agent-friendly — never the secret). No env vars — the credential is a per-tenant vault secret.

## Known limits

- Images/documents without a vision extraction (vision off or failed) become a "send text/audio" marker; the eager vision pass, when enabled, fills `image_description`/`extracted_text` under the same write-back + overlay contract as STT.
- Attachment download follows storage redirects (S3) without re-validating the redirect target (TOCTOU); the data_url comes from the HMAC-authenticated webhook of the tenant's own Chatwoot.
- If STT is slower than the debounce window a CONCURRENT delivery's flush may re-fetch before this message's transcription completes (nothing to overlay yet); the re-arm/supersede recovers on the next message. Whisper/Scribe are fast; rare.
- The in-process annotation store is per-process memory: an app restart inside the debounce window loses the overlay on upstream Chatwoot (the fork's meta write-back survives restarts). Bounded by the single-replica deploy invariant (`docs/deploy.md`). Expiry is **active**, not lazy: a rescheduled (unref'd) sweeper deletes annotations past the TTL even when no new voice note arrives, so an idle process does not keep customer speech in memory until restart; a size cap bounds bursts as a second limit.

Read before touching `src/modules/stt/*`, `chatwoot/render.ts`, the message parser, or the eager-STT seam in the webhook.
