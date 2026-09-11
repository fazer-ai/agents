# Signature (the operator's, never the model's)

A closing line the operator configures once and the agent never writes: `— Gi, Guichê Web` on every reply, on every channel the agent answers on. Per agent, **off by default** (`text: ""`), configured in the Behavior tab.

It exists because asking the model for it does not work. Measured over three rounds of the same twelve real customer emails, `gpt-5.6-luna` with a prompt asking for a fixed two-line closing:

- **Glued to the last sentence** in 2 of 10 replies in the first round and 1 of 9 in the third. A prompt rewrite moved the failure without removing it.
- **Absent from every handoff**, 3 of 3. `handoff_to_human`'s schema asks for "a brief reply to the customer", and the schema wins over the system prompt. That is the worst case rather than a cosmetic one: the model's own final text is blanked when a handoff ran (#158), so the tool's `customerMessage` **is** the message the customer receives.

A signature is also the kind of text that has to be identical every time, and anything the model writes varies.

## The vocabulary is Chatwoot's, and so are the bytes

The fork already stores per-inbox signatures — `inbox_signatures` (our own PR #226), with `message_signature`, `signature_position` and `signature_separator` — and applies them in the reply box with `appendSignature`. An operator who configures both should meet the same words and the same bytes in both places, so the field names, the values and the delimiters here are copied from it.

**None of that logic could be reused, and the reasons are worth writing down** so nobody re-opens the question:

- `inbox_signatures` is `belongs_to :user` with `UNIQUE (user_id, inbox_id)`. An agent bot is not a User, so it could not be stored there without a migration.
- The application is **frontend-only**: `appendSignature()` lives in `app/javascript/dashboard/helper/editorHelper.js` and runs in the reply box at send time. Rails never appends on the message-create path — the only backend reference outside storage is Captain's reply-suggestion service, which passes the signature to the LLM as context. A bot posting through the API goes nowhere near it, so doing it there would be a **port from JS to Ruby**, in a repo we rebase onto upstream.
- **And it could not be correct there.** A split reply is N balloons, which is N independent message-create calls. Chatwoot cannot know which one is the last of a turn, so it would sign every balloon. "Once per turn, on the last message" is knowledge only this runtime has.

The defaults match too, `top` included.

## Settings

| field | values | default |
| --- | --- | --- |
| `text` | any text, multi-line, capped at 500 | `""` — both the default and the off switch |
| `position` | `top` \| `bottom` | `top` |
| `separator` | `blank` (`\n\n`) \| `--` (`\n\n--\n\n`) | `blank` |

## There is no per-channel switch, and the shape of the next version is why

The first design had a `channels` allowlist: "sign these channel classes". It was dropped before it shipped, because it answers only half of the operator's question. The other half is that **a closing written for e-mail is not the closing they want on WhatsApp** — a link and a two-line block on one, a short line on the other. The version that answers both is a signature **per channel**, which is exactly what the Chatwoot fork already does per inbox.

An allowlist is not a step toward that. It is a different field with a different meaning that would have to be migrated away, and in the meantime it lets an operator turn the feature on and see nothing, with an empty list as the second off switch next to the empty text. So the first version is **one text, on every channel**, with `text: ""` as the only off switch. If per-channel signatures are ever needed, they arrive as `signature.channels: { "Channel::Whatsapp": { text, position, separator } }` with this block as the default, and nothing configured today has to change.

## Module (`src/modules/signature/service.ts`)

- `readSignatureConfig(settings)` — the block, defaults applied, values of another shape dropped rather than carried (the bag is operator-editable through the REST API as well as the UI).
- `signatureFor(cfg, vars?)` — the signature for this turn, or null when `text` is empty, with the placeholders resolved. The playground calls the same function, because it is asking the same question.
- `alreadySigned(chunks, signature, whole?)` — the dedupe, asked of **the reply as it arose**, which the splitting caller has in hand and passes. Asking it of the chunks was a real defect twice over, and both halves came from review: a signature containing a blank line is cut by the same paragraph rule, so neither edge chunk holds all of it; and `splitReplyParts` **trims** every paragraph, so even a reassembly from the separators loses an indented line. There is nothing to reconstruct when the caller still has the original.
- `attachSignature(chunks, signature, position, separator)` — pure, and the single spelling of the rule. Takes the **already-split** array and returns it with the signature on the last chunk (or the first, with `top`).

## It attaches to a CHUNK, never to the text

This is the whole design, and it is not a detail. `splitReplyParts` cuts on `/\n{2,}/`, and **both separators contain `\n\n`**. A signature concatenated onto the reply before the cut therefore:

- with `blank`, becomes a **balloon of its own** — its own typing indicator, its own pacing delay, its own `deliveredBalloons`;
- with `--`, gives the customer a balloon whose **entire body is `--`**;
- at the `maxChunks` ceiling, is instead merged into the last paragraph, so **one configuration renders two different ways** depending on how long the reply happened to be;
- on an email inbox with split on, where each balloon is an email, produces **an email whose whole body is the signature**.

It also answers the silent turn for free. A reply of only whitespace is truthy, so it passes the runtime's `if (!reply)` gate, and the splitter trims it to **zero** chunks — nothing is sent today. Attaching to a chunk that does not exist attaches nothing, where appending to the text would have made the signature a lone message in a turn where the agent said nothing.

## Which messages are signed

The rule is **the message that closes a turn**, not "every outgoing message". There are thirteen sends in this runtime; four are signed:

| signed | where |
| --- | --- |
| the reply | `deliverText` → `deliverReply` (`src/graph/runtime.ts`) |
| the handoff's closing line, reactive path | `deliverText` (same funnel, so byte-identical to the reply) |
| the handoff's closing line, proactive path | `src/graph/nudge.ts` |
| the proactive message (follow-up / nudge) | `src/graph/nudge.ts` |

The farewell is the same sentence from the same agent to the same customer on both paths, and signing it on one and not the other is the inconsistency an operator reports as a bug.

Not signed, each for a reason:

- **the slow-tool acknowledgement** (`src/graph/prepare.ts`) — mid-turn, so signing it would put two signatures in one turn;
- **the input-guardrail template, the spend-ceiling refusal, the channel-redirect texts and the API-driven send** — all the operator's own configured sentences, where whoever wrote the sentence already controls its closing;
- **the private note** — never customer-facing;
- **an audio reply.** A spoken "— Gi, Guichê Web" is noise, and the voice note's `transcribedText` should be the words that were actually said. The TTS branch in `deliverText` returns before the text one, so this falls out of the structure rather than needing a check.

## Idempotency, and what it does not catch

The guard is Chatwoot's own rule: `findSignatureInBody` asks `trimmedBody.endsWith(cleanedSignature)`. A **tail check, not containment** — containment reads a short signature that merely appears in the prose ("Gi" in a sentence about Gi) as one already written, and silently drops it.

It is asked **across the whole reply and at both ends**, not inside the one chunk about to be touched. With `position: "top"` the signature goes on the first chunk, and a model that signed itself at the end put its copy on the last one: a check scoped to chunk zero finds nothing, prepends, and the customer reads two closings. Asking both ends leaves **one** signature, at the end the model chose — so `position` is where *we* place a signature, not a promise about where one the model wrote ends up. One in the wrong place beats two in the right one.

**What it does not catch is a paraphrase.** A model that writes its own variant of the closing still produces two, and the fix for that is emptying the prompt, which is what this feature is for. Chatwoot has the same limit.

## Write Markdown, and Chatwoot converts it per channel

**Corrected on 11/09**, because the first version of this document said the opposite and it was wrong. The claim was that nothing converts markdown and a signature written for e-mail reaches WhatsApp with its brackets showing. Chatwoot does convert, on the way out, for every channel that has a renderer.

`Message#outgoing_content` runs `Messages::MarkdownRendererService` (upstream, added by #12600 in 2025-12; present in the fork's `main` at 4.17.0), and the provider send path reads `outgoing_content`, not `content`. So the conversion applies to **anything** in the message, whoever wrote it: the model's reply, the operator's signature, a message posted through the API by an agent bot.

What the WhatsApp renderer does, from the fork's own spec (`spec/services/messages/markdown_renderer_service_spec.rb`):

| written | reaches WhatsApp |
| --- | --- |
| `**bold**` | `*bold*` (WhatsApp's own single asterisk) |
| `_italic_` | `_italic_` |
| `` `code` `` | `` `code` `` |
| `[label](url)` | `url` — **the label is dropped** |
| `- item` | `- item` |

Email and the web widget get HTML, Telegram gets its own HTML, Instagram/Facebook/Line get their own markup, SMS and Twitter get plain text. So the vocabulary an operator writes is one: **Markdown**, the same in the signature, in the reply box and in the prompt.

**The one channel with no renderer is `Channel::Api`**, which is not in `CHANNEL_RENDERERS` and therefore passes the content through untouched. A signature written with `**` on an API inbox reaches the consumer with the asterisks in it, which is correct behaviour for a channel whose consumer decides its own rendering, and worth knowing before writing one.

The remaining limit is the link. `[fazer.ai](https://fazer.ai)` keeps its label on e-mail and loses it on WhatsApp, where only the URL survives. That is upstream's decision rather than something this feature can fix, so a signature that carries a link is best written with the URL bare when the agent answers on WhatsApp.

This is what the **preview** in the Behavior tab is for. The field is a plain textarea rather than a rich editor, so `**Gi**` is what the operator types, and the preview is the only place that answers whether that lands as bold. It renders through the same `<Markdown>` the conversation view and the playground use, which is what a channel with a renderer does with it, and it resolves the variables against example values so the shape is visible before anything is sent.

## The cap is declared on the control

500 characters, `SIGNATURE_MAX`. Smaller than the other operator-prose caps on purpose: a signature repeats on every message the agent sends, where a template or a guidance note is written once and read once.

The reader clamps (`clipText`, so a cut never lands between the two halves of an astral character), and the **field says so** — `maxLength` on the control, a counter from 80% of the cap, and the over-limit sentence past it, which is the pattern `docs/ui.md` holds up as the app's best answer to a cap. It shipped without any of that, clamping in silence: `clipText` in the `onChange` dropped whatever was pasted past 500 and nothing on the page mentioned a limit. A holdout scenario found it, not the text-caps fence, because that fence only knew `<Textarea>`. It reads both controls now, and asks the highlighted one the narrower question that needs no waiver: if the block clamps, it must declare.

## The variables are the prompt's

`{{nome_agente}}`, `{{nome_empresa}}`, `{{nome_contato}}` and the rest, through `interpolatePromptVars` itself rather than a second copy of it, **with the render options the system prompt was built with** (`AgentConfig.promptOpts`): the map alone answers the context names and leaves every schedule and time name literal, which review of #599 caught reaching the customer that way. An operator who has learned the prompt's `{{var}}` has learned this one, the editor highlights a real name against a typo with the prompt's own known-token set, and a variable added to the prompt reaches here without anyone remembering to.

The preview's example values come from `buildPromptVars` itself rather than a hand-written map, so the context it renders cannot fall behind what the chips offer: written by hand it omitted `{{email_contato}}`, `{{telefone_contato}}` and `{{canal}}`, and the preview then showed three supported variables as literal text, which reads as "these do not work".

The "insert a variable" chips under the field offer the **context** vars only, not the prompt's whole list. The time and schedule names interpolate here too, because it is the same function, but a closing line that announces the current minute is not a signature, and offering it invites one that changes on every message, which is the property this feature exists to remove.

A chip whose token does not fit in what is left before the cap is **disabled**, with the reason on hover, and the insert refuses the same case on its own. Clipping an insert is not the same defect as clipping a paste: the caret is at the front and the loss is at the back, so the operator watches a variable appear where they asked while a URL loses its tail where they are not looking. A selection counts as free room, because the insert replaces it.

An unknown placeholder is **left standing**, not blanked. That is `interpolatePromptVars`'s own rule, and it is what makes a typo visible on the customer's screen instead of silently deleting the operator's text.

## The playground signs the live turn, and the reload does not

Two places sign, and they are the two the operator is watching when they ask "what would the customer get":

- the **live turn** signs the reply it returns;
- the **simulated follow-up** signs too, because production signs the proactive message, and a bare follow-up here would make the playground the one surface showing something the customer never receives.

The TTS text is not signed, for the reason production's audio branch is not: the operator would hear a spoken closing that no customer ever hears.

**A reopened session shows the model's own words, unsigned**, and that is a decision rather than a gap. It was implemented the other way first, signing at rebuild, and review found the two questions such a site has to answer and cannot: which variables resolve (`{{nome_agente}}` needs the map, `{{horario_atendimento}}` needs the schedule and the instant, and neither survives into a transcript) and which turns qualify at all (an input-guardrail refusal is the operator's own sentence and is never signed, which the rebuild can only infer).

Both are known at delivery and unknowable cheaply at rebuild, and `docs/playground.md` already says what to do when the transcript must show something the checkpointer does not hold: it gets a row, in `playground_turn_notes`. A render-time re-derivation is the thing that table exists to replace.

The reload also replays nothing else about delivery: the reply is not split into balloons, the pacing is not reproduced. Signing on reload while not splitting on reload would be arbitrary. So the rule is the plain one: **the transcript is the thread, and delivery-time transformations are shown where they are decided, on the live turn.**

## The prompt's job is the opposite one

Once this is configured, the prompt should say **nothing** about signing. A prompt that still asks for a closing produces the paraphrase the guard above cannot catch, which is two closings on the customer's screen.
