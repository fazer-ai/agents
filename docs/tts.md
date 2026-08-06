# TTS (audio replies) + per-contact voice preference

Optionally answer the customer with a WhatsApp voice note. Three operator-chosen modes (n8n parity), a generic provider registry, and an elegant per-contact preference stored on our own `Contact` row (not a Chatwoot custom attribute). Off by default (audio costs money and isn't always wanted).

## Decision + flow

`runLoadedTurn` (shared by the direct path and the debounce flush) generates the reply text, then:

```
shouldReplyWithAudio(mode, userSentAudio, contactVoiceReply)
   never      → text
   mirror     → audio iff the customer's turn included a voice note
   preference → Contact.voiceReply (true=audio, false=text, null → mirror)
        │ yes
        ▼
   synthesizeReply: prepareSpeechText (strip markdown/links/emoji) →
     normalizeSpeech (opt-in LLM rewrite for natural pronunciation, same language) →
     provider.synthesize (key from vault) → Ogg/Opus bytes (WhatsApp voice-note format)
        │  (null/throw → fall back to a text reply; audio is best-effort)
        ▼
   client.sendAudioMessage  (multipart voice note, bot token, is_recorded_audio,
                             attachments_metadata[file][transcribed_text] = the reply text)
```

`userSentAudio` is computed by the caller: the direct path from `firstAudioAttachment(event)`, the flush from `pending.some(audio)`. A TTS failure never drops the reply — it posts text instead.

## Generic provider abstraction (`src/modules/tts/providers.ts`)

`TtsProvider.synthesize(req) → { audio, mime, fileName }`. Adding a provider = one function + one registry entry; key from the **vault**, provider/voice/model per agent.

| Provider     | Default model        | Endpoint                          | Auth         | Notes              |
| ------------ | -------------------- | --------------------------------- | ------------ | ------------------ |
| `openai`     | `tts-1`              | `…/v1/audio/speech`               | `Bearer`     | voice default `alloy` |
| `elevenlabs` | `eleven_flash_v2_5`  | `…/v1/text-to-speech/{voice_id}`  | `xi-api-key` | voice **required**  |

`prepareSpeechText` is a no-LLM cleanup (strip markdown/links/emoji, collapse whitespace). On top of it, an **opt-in LLM normalization** (`llmNormalizeForSpeech`, `agent.settings.tts.normalize`, off by default) rewrites what a voice engine reads wrong or inconsistently (currency, numbers, percentages, dates, times, phone numbers, ordinals, abbreviations, addresses) into the way it is spoken, IN THE SAME LANGUAGE as the reply. It runs only on the audio path and only on the synth input: the Chatwoot `transcribed_text` keeps the ORIGINAL reply (no rewritten text leaks into the transcript). The runtime builds a **temp-0 model from the agent's own model config** (no extra credential) and injects it via `SynthesizeReplyParams.deps`; it is best-effort, so a slow or failing rewrite (20s timeout) falls back to the raw text and never blocks the reply. We chose the LLM over a regex pass on purpose: deterministic pt-BR rules (number-to-words, date/ordinal/abbreviation tables) are an endless edge-case treadmill (`30°C` vs an ordinal, "no" vs "nº", fractions vs dates) and lock the feature to one locale, while the LLM covers the long tail and any language.

**We send PLAIN TEXT, never SSML, by design.** SSML is fragmented and brittle: OpenAI's `/audio/speech` rejects it (it has an `instructions` steering field instead); ElevenLabs honors `<break>` only on v2 models (and only with `enable_ssml_parsing=true`) and drops it on v3 in favor of bracket *audio tags* (`[pause]`, `[excited]`), so one payload can never target a provider×model-version pair. The original "SSML por-provedor" idea was therefore **dropped, not deferred**; the LLM normalization above is the useful half of the n8n "Formatar SSML" step.

## Per-contact preference (mode "preference")

`Contact.voiceReply` (`BOOLEAN?`, RLS-scoped column — **not** a Chatwoot custom attribute, the inelegance we replaced from n8n): `true` = wants audio, `false` = wants text, `null` = unknown (falls back to mirroring). Set by the **`set_voice_preference`** native tool (`prefersAudio: boolean`) the agent calls when the customer states a preference ("me manda áudio" / "prefiro texto"). The tool is a DB write under `runScoped` (the native-tools `ToolCtx` now carries `tenantId`/`base`/`contactDbId`).

## Sending the voice note (`client.sendAudioMessage`)

`POST …/conversations/{id}/messages` multipart (bot token), confirmed against Chatwoot's `sendFile`: `attachments[]` = **Ogg/Opus** (`audio/ogg`, `reply.ogg`), `message_type=outgoing`, `is_recorded_audio=[fileName]` (WhatsApp renders a recording, not a file), `attachments_metadata[{file}][transcribed_text]` = the spoken text (so the audio carries its transcription for accessibility/search). No `content-type` header (fetch sets the multipart boundary).

**Format matters, and it follows the destination channel** (`pickTtsFormat` in `src/modules/tts/providers.ts`, fed by the inbox's `channelType` via `AgentConfig.channelType`). WhatsApp only recognizes a voice note (PTT) when the audio is Ogg/Opus — mp3/wav arrive as a plain file attachment — so every non-Instagram channel keeps Ogg/Opus (OpenAI `response_format:"opus"`; ElevenLabs `output_format=opus_48000_64`), no server-side transcode. **Meta's Instagram messaging accepts audio only as aac/m4a/wav/mp4 and refuses ogg AND mp3**: the send job fails AFTER Chatwoot shows the message as sent, so the customer silently never receives it. On `Channel::Instagram` the container becomes `aac` (OpenAI, native) or `wav` (ElevenLabs: raw `pcm_24000` wrapped in a 44-byte RIFF header by `pcmToWav` — a header write, not a transcode). openrouter only emits mp3, so on Instagram the synth is skipped (`channel_format_unsupported` on the flow log) and the reply falls back to text.

## Configuration

Per-agent, in `agent.settings.tts` (`readTtsConfig`): `mode` (`never`|`mirror`|`preference`, default `never`), `provider` (default `openai`), `model` (`""` → provider default), `voice` (`""` → provider default; required for ElevenLabs), `credentialRef` (a `vault:<id>` ref), `normalize` (`boolean`, default `false`; LLM text-for-speech normalization that reads numbers/dates/abbreviations naturally in any language, see above). Surfaced in the agent editor's **Behavior** tab and writable over REST + MCP (`agent_settings_get`/`agent_settings_set`, the `tts` block; the MCP transport translates the `vault:<id>` ref to/from the entry **name** at its boundary, never the secret). No env vars — the key is a per-tenant vault secret.

Read before touching `src/modules/tts/*`, `client.sendAudioMessage`, the `set_voice_preference` tool, or the reply-modality branch in `runLoadedTurn`.
