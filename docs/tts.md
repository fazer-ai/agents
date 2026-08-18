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

`prepareSpeechText` is a no-LLM cleanup (strip markdown/links/emoji, collapse whitespace).

## The speech rewrite (`normalize`, ON by default)

On top of that cleanup, a **second model call** (`llmNormalizeForSpeech`, `agent.settings.tts.normalize`) rewrites the reply the way it would be SPOKEN, in the same language: currency, numbers, dates, times, phone numbers, ordinals and abbreviations in words. It runs only on the audio path, only on the synth input, and only AFTER every check that could still abort the synthesis (credential, voice, channel format), so an agent whose TTS is misconfigured never pays for a rewrite it will not use: the Chatwoot `transcribed_text` keeps the ORIGINAL reply, and so does the checkpointer thread, so nothing rewritten ever re-enters the agent's memory. Best-effort, with a 20s timeout: a failure falls back to the raw text and never blocks the reply. We chose an LLM over a regex pass on purpose: deterministic pt-BR rules (number-to-words, date/ordinal/abbreviation tables) are an endless edge-case treadmill (`30°C` vs an ordinal, "no" vs "nº", fractions vs dates) and lock the feature to one locale, while the model covers the long tail and any language.

**The main agent is told nothing about any of this.** The alternative (a "this reply will be spoken" section appended to the agent's prompt) was measured and dropped: the modality is decided by `shouldReplyWithAudio(mode, userSentAudio, contactVoiceReply)`, three inputs, and a prompt section can only be gated before the reply exists, on one of them. Two DB-backed turns showed both error directions (a `mode: never` agent told it would be spoken and replying in text; a `preference` agent replying in audio never told). Rewriting afterwards has no such gate: it runs exactly when synthesis runs.

**The prompt was measured, not composed.** The wording it replaces ("changing ONLY what a TTS would read wrong" + "preserve the wording") forbade the restructuring the reported reply needed, and measuring showed a worse problem than style: rewriting `"08:00, 08:30 e 09:00"` item by item FUSES the last two into `"oito e trinta e nove horas"`, which a listener hears as **08:39, a time that was never offered**. Rate on that exact reply, n=24 per arm, temperature 0, old wording → current one:

| model | fused | fact lost |
| --- | --- | --- |
| `gpt-5.4-mini` | 17/24 → **1/24** | 0/24 → 0/24 |
| `gpt-4o-mini` | 5/24 → **0/24** | 0/24 → 0/24 |
| `gpt-5.4` | 10/24 → **0/24** | 17/24 → **0/24** |

Two other fixtures (a 14h/14h30/15h offer, a three-price list) score zero on both arms. Every line of the prompt bought something in that measurement, which is the bar for adding another: `keep every fact` is what buys the freedom to restructure (it REPLACES "preserve the wording"), the enumeration line breaks the fusion, and the date line exists because `gpt-5.4` read `18/08` as "dezoito do zero oito" in 17/24 runs and the enumeration rule alone made that *more* consistent (24/24), not less. A longer variant that also spelled the fusion rule out measured identically (16/96 either way) and was dropped.

**Its own model** (`buildSpeechNormalizer` + `resolveNormalizeModel`). Four flat overrides on the block — `normalizeProvider` / `normalizeModel` / `normalizeCredentialRef` / `normalizeBaseURL` — answered by ONE function: which model runs, on whose key, at which endpoint, and whether it runs at all. Those are one question, because every wrong answer is the same failure, something arriving somewhere it was never issued for. The reasoning behind each rule lives in that file's header; the contract is here.

**Inherit whole, or name what you override.** With all four unset the rewrite runs the agent's model, on the agent's key, at the agent's endpoint — so an install that touches nothing behaves exactly as before. Set any of them and the rewrite must name its provider, even when it is the agent's own: a model id and an API key belong to the vendor they were picked from, and nothing else in the bag records which one. A dedicated key also brings its own endpoint (the vendor's default, one stored on the credential, or a typed one), never the agent's — that one is a field on another tab, and it moves.

Nothing here throws. Every refusal skips the rewrite and lets the audio go out from the raw text. The ones the resolver decides from the stored bag alone are also surfaced by `computeConfigIssues`, which is what REST and MCP callers get instead of a validation error; the last row is decided at runtime and shows up as a `warn` line on the `normalize` flow stage instead (a credential ref whose entry is gone is not flagged by the health panel for any field, see #114):

| refusal | when |
| --- | --- |
| `override_without_provider` | a model id or a credential set while the provider stays inherited |
| `credential_required` | a destination the agent's key does not cover, with no key of its own |
| `endpoint_unusable` | no endpoint the rewrite can be sent to: absent where the provider has no address of its own, or one it brought itself that is not a dialable URL |
| `endpoint_unsupported` | an endpoint set for a provider whose adapter drops it — only `openai-compatible` and `openrouter` send one (`PROVIDERS_HONORING_BASE_URL`, probed against the built instances so it cannot drift) |
| `provider_unknown` | a provider name we do not support |
| `credential_not_found`, `model_not_runnable` | the vault entry is gone, or the factory refused the configuration |

An endpoint INHERITED from the agent is never judged that way: honored or dropped, the rewrite lands wherever the agent's own model lands. An unset model on a switched provider resolves to that provider's default (the #94 lesson: an empty name travels verbatim and the call is refused). Temperature is pinned to 0 and the agent's `reasoningEffort` dropped. The editor projects this same resolver rather than re-deriving it, and clears what was picked for the old vendor when the rewrite's provider changes (`ttsFormState.ts`).

`normalizeCredentialRef` is a full citizen of the credential plumbing: the MCP name↔ref translation, the agent export/import remapping, and the vault's "is this key in use?" reverse index all read the ONE list of (block, field) pairs that hold a ref (`SETTINGS_CREDENTIAL_PATHS`, `src/modules/agents/credential-paths.ts`), and a test walks the behavior readers to keep that list equal to what they produce. Consolidating the three private copies is what surfaced `guardrails.credentialRef` missing from all of them: exporting an agent whose guardrails ran on their own key failed with 500 until then.

**It is billed and traced like the turn itself**, which it was not before: one `LlmUsage` row with `node = "tts_normalize"` (so the dashboard's per-call split and the `llm.usage` webhook both see it), a nested Langfuse generation under the turn's trace (`updateRoot: false` — with the default `true` a second top-level call would overwrite the root trace's input/output with its own rewrite), and its own `normalize` flow stage carrying provider/model/duration plus `inChars`/`outChars`/`rewritten`. Never any excerpt of the text: the rewritten string IS the customer's message.

**Default.** ON since the migration `20260817210000_tts_normalize_default_on`, which DELETES a stored `tts.normalize` key rather than writing over it — a stored value always wins over the default, and every editor/MCP save wrote the key out explicitly, so flipping the constant alone would have reached only agents created afterwards. An operator who had deliberately turned it off gets it back on; that is the one thing about this change that can be called a regression, and it is in the release notes.

## Voice delivery (`voice_settings`)

Five optional per-agent knobs control HOW the words come out, as opposed to which words the model picked: `stability` (0-1; low = expressive, high = monotone — the usual cause of a "robotic" voice note), `similarityBoost` (0-1), `style` (0-1; costs latency and destabilizes high), `speed` (0.25-4, the band the REST endpoint accepts; the narrower 0.7-1.2 their docs also quote is the Agents Platform's, and clamping to it turned a deliberate 1.5 into 1.2 with no error) and `speakerBoost`. They live **flat** on `agent.settings.tts`, not in a nested object, because `mergeBehaviorSettings` merges a block shallowly — nesting them would make a patch of one knob null out the rest and break the partial-patch contract the REST/MCP transports promise. `voiceSettingsOf` regroups them at the provider boundary and returns **null when the operator set none**, so the adapter omits `voice_settings` entirely and the request body of an untouched agent stays byte-identical to what it was before this existed (ElevenLabs then falls back to the settings saved on the voice itself). `readTtsConfig` **clamps** out-of-range values rather than rejecting the write — an overshot slider is not a reason to fail a settings save. Only ElevenLabs consumes them; OpenAI's `/audio/speech` has no equivalent bag and the mapper ignores what it cannot express.

**We send PLAIN TEXT, never SSML, by design.** SSML is fragmented and brittle: OpenAI's `/audio/speech` rejects it (it has an `instructions` steering field instead); ElevenLabs honors `<break>` only on v2 models (and only with `enable_ssml_parsing=true`) and drops it on v3 in favor of bracket *audio tags* (`[pause]`, `[excited]`), so one payload can never target a provider×model-version pair. The original "SSML por-provedor" idea was therefore **dropped, not deferred**; the LLM normalization above is the useful half of the n8n "Formatar SSML" step.

## Per-contact preference (mode "preference")

`Contact.voiceReply` (`BOOLEAN?`, RLS-scoped column — **not** a Chatwoot custom attribute, the inelegance we replaced from n8n): `true` = wants audio, `false` = wants text, `null` = unknown (falls back to mirroring). Set by the **`set_voice_preference`** native tool (`prefersAudio: boolean`) the agent calls when the customer states a preference ("me manda áudio" / "prefiro texto"). The tool is a DB write under `runScoped` (the native-tools `ToolCtx` now carries `tenantId`/`base`/`contactDbId`).

## Sending the voice note (`client.sendAudioMessage`)

`POST …/conversations/{id}/messages` multipart (bot token), confirmed against Chatwoot's `sendFile`: `attachments[]` = **Ogg/Opus** (`audio/ogg`, `reply.ogg`), `message_type=outgoing`, `is_recorded_audio=[fileName]` (WhatsApp renders a recording, not a file), `attachments_metadata[{file}][transcribed_text]` = the spoken text (so the audio carries its transcription for accessibility/search). No `content-type` header (fetch sets the multipart boundary).

**Format matters, and it follows the destination channel** (`pickTtsFormat` in `src/modules/tts/providers.ts`, fed by the inbox's `channelType` via `AgentConfig.channelType`). WhatsApp only recognizes a voice note (PTT) when the audio is Ogg/Opus — mp3/wav arrive as a plain file attachment — so every non-Instagram channel keeps Ogg/Opus (OpenAI `response_format:"opus"`; ElevenLabs `output_format=opus_48000_64`), no server-side transcode. **Meta's Instagram messaging accepts audio only as aac/m4a/wav/mp4 and refuses ogg AND mp3**: the send job fails AFTER Chatwoot shows the message as sent, so the customer silently never receives it. On `Channel::Instagram` the container becomes `aac` (OpenAI, native) or `wav` (ElevenLabs: raw `pcm_24000` wrapped in a 44-byte RIFF header by `pcmToWav` — a header write, not a transcode). openrouter only emits mp3, so on Instagram the synth is skipped (`channel_format_unsupported` on the flow log) and the reply falls back to text.

**The `tts` flow-log line names both formats, and the provider's error code.** `ogg_opus`/`aac`/`wav`/`mp3` are our INTERNAL container names, never wire values, so a failing line that showed only `format: "ogg_opus"` next to a bare `failed with 400` reads like the parameter we sent (it was reported as one, and never was: the URL always carried `output_format=opus_48000_64`). Every provider therefore exposes `providerFormat(container)`, which the adapters build their own request from and the log records as `detail.providerFormat` next to `detail.format` — one source, no drift. On a non-2xx, `readProviderErrorCode` keeps the provider's machine-readable status (ElevenLabs `detail.status`, OpenAI/OpenRouter `error.code`/`error.type`) and nothing else: the body's free-text message carries account/billing detail and echoed credentials, and a "code" field holding prose is dropped by the slug guard rather than logged. So the operator sees `TTS elevenlabs failed with 400 (voice_not_found)` instead of an opaque status.

## Configuration

Per-agent, in `agent.settings.tts` (`readTtsConfig`): `mode` (`never`|`mirror`|`preference`, default `never`), `provider` (default `openai`), `model` (`""` → provider default), `voice` (`""` → provider default; required for ElevenLabs), `credentialRef` (a `vault:<id>` ref), `normalize` (`boolean`, default `false`; LLM text-for-speech normalization that reads numbers/dates/abbreviations naturally in any language, see above). Surfaced in the agent editor's **Behavior** tab and writable over REST + MCP (`agent_settings_get`/`agent_settings_set`, the `tts` block; the MCP transport translates the `vault:<id>` ref to/from the entry **name** at its boundary, never the secret). No env vars — the key is a per-tenant vault secret.

Read before touching `src/modules/tts/*`, `client.sendAudioMessage`, the `set_voice_preference` tool, or the reply-modality branch in `runLoadedTurn`.
