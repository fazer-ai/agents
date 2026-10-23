# Occurrences

An account-wide monitor of why customers get in touch, grouped across conversations: any reason of contact, a request, a question or a failure, is grouped into a theme with the conversations that share it. A theme is flagged when it runs out of the usual, which is not the same as something going wrong: a new kind of request is flagged as well. No single conversation shows that, and the categories an observer applies per conversation are too broad to. Issue #314 describes the whole design; this document describes what is built.

## What is built so far

- **Readings.** The account declares the fields the monitor reads off each conversation and the inboxes it reads. Every round, the monitor reads the conversations of those inboxes that have new customer messages, by itself, and stores what it read in `conversation_readings`, one row per conversation and field. No agent is created, granted or pointed at it.
- **Canonical references.** When the account reads a reference, a model fits its free spellings to canonical names, and an alias dictionary remembers each decision.
- **Themes.** The model assigns each new reason sentence to an open theme or proposes a new one. Periodically, it merges, splits and renames the open themes.
- **Flags.** Every round counts each open theme exactly and flags it as new, above its usual, or concentrated on one reference.
- **Rounds.** Every few minutes a round runs those steps and leaves an `occurrence_runs` row with what it read, how long it took, how many model calls it made and what they cost.
- **Configuration**, through the console, REST and MCP. The monitor is off by default.
- **Dashboards.** A panel's `occurrences` source shows the open themes now (an "occurrences now" panel, flagged first, on a TV as well) or the period's conversations by canonical reference (docs/dashboards.md).

## Configuration

The `occurrences` block of `tenant.settings` (`src/modules/occurrences/settings.ts`), one per account. Several monitors per account are a follow-up (agents-master#363); the tables this monitor writes take a monitor column then, defaulting to this one.

- `enabled`: off by default, and also off for a block that no longer parses, so a damaged block never starts spending a model. A block that parses but can no longer run (one saved before the monitor named its inboxes and model, with `agentId`, or one still under the names the 20261022120000 migration renamed) reads as an off draft that keeps its fields.
- `inboxIds`: the inboxes whose conversations the monitor reads and counts, up to 50 (`Inbox` row ids as strings); `inboxIds` replaces the list on write. An inbox a write adds must be this account's and received by the product: a responder bound to it, or an observer watching it. The refusal names the inbox. One already on the list that loses its agent later stays and does not block the next save; it simply produces no readings, and the console says so. Readings of any other inbox stay stored and count nowhere (see "The monitored inboxes").
- `fields`: the account's own fields, at most 10. Each has:
  - `key`: lowercase letters, digits and `_`, up to 64 characters, and never a name every object already has (`__proto__`, `constructor`);
  - `name` and `description` (what the monitor's reading is told to write), both without what the database refuses (a NUL or half of a character);
  - `attribute`: whether the value is also written to the conversation's Chatwoot custom attribute of the same key, so folders can filter by it.

  Nothing in the code or the console names a field. `fields` replaces the whole list on write. The console never asks for a key: a new field takes its key from its name (lowercase, accents dropped, anything else an underscore, a number added when another field holds it), and a saved field keeps its key when it is renamed, since its readings are stored under it. The key is shown only where it is the Chatwoot attribute's name, under a field written to the conversation.
- `reasonField`: the key of a declared field, required to switch the monitor on. The reason is why the customer got in touch, in one short sentence, of any kind; it is what themes are made of. A conversation whose reason is empty joins no theme.
- `referenceField`: optional, the key of another declared field, never the reason's. The reference is what the reason refers to, whatever the account deals with, and is what the canonical names and the concentration flag count by. Without it the monitor works the same, except that the concentration flag is never raised; the console says so where that threshold is.
- `cadenceMinutes`: minutes between rounds, 5 to 1440 (default 15).
- `consolidationMinutes`: minutes between consolidations, 15 to 10,080 (default 60).
- The flags' thresholds (see "Flags"):
  - `newMinConversations` (N): 1 to 10,000, default 5;
  - `windowMinutes`: the recent window, 15 to 1440, default 60;
  - `previousDays`: 1 to 30, default 7;
  - `aboveUsualRatio` (X): 1.1 to 100, default 3;
  - `concentrationShare`: 0.1 to 1, default 0.6.
- `model`: the one model every step runs on, `{ provider, model, credentialRef, baseURL }` or null, required to switch the monitor on. `credentialRef` is a `vault:<id>` of this account of a kind that holds an API key (the agent's model key's rule), required for every provider but `openai-compatible`, which needs a model id and an endpoint instead (its own `baseURL`, or the credential's: a model with neither, or on a credential with no base URL, is refused on save). With no credential it sends the placeholder key `no-key`, since the OpenAI SDK refuses an empty one before any request; a keyless server ignores it. `baseURL` is refused on a provider whose adapter drops it (`PROVIDERS_HONORING_BASE_URL`: only `openai-compatible` and `openrouter` take one), since the conversations would go to the vendor instead of the proxy; the same holds for an endpoint the model would inherit from its credential, and a model saved with either before does not run. A null or blank `model.model` is the provider's default. A write replaces `model` whole; one that leaves it out keeps it. The console lays it out as the agent's Model card (provider and model on one row, the API key below, the base URL for the two providers that take one), drops the base URL when the provider changes, so a new provider's key never goes to the old server, and sends the model only when it changed, so a monitor whose saved model can no longer run can still be switched off. The credential shows in the vault's references as the occurrence monitor. The audit trail keeps the endpoint as its scheme and host only, since a URL can carry a key. Per-step models were dropped: the 20261022120000 migration keeps the reading's as the one model.
- `businessContext`: optional, up to 2,000 characters, without what the database refuses. Every step's prompt gets it after its fixed instructions, inside a `<business>` block, as context about the business; empty sends nothing. The fixed prompts are not editable through any transport.

Switching the monitor on requires `inboxIds`, `model` and `reasonField`. A block that is off may be incomplete, so a draft saves. Any other invalid value is a 422, and so is a key the block does not have (in the block, in a field or in the model), which is refused rather than dropped; the block is left as it was. The names the block had before, `subjectField`, `problemField` and `models`, are such keys: REST and MCP refuse them.

**The migration** `20261022120000_occurrence_reason_reference_one_model` rewrites every stored block: `subjectField` becomes `referenceField`, `problemField` becomes `reasonField`, and `models.reading` becomes `model`; a value already under the new name wins, and the old keys are removed. It also renames the dashboard source view `subjects` to `references` on stored panels. It only touches blocks that still hold an old key, so applying it twice changes nothing. The column `occurrence_themes.flag_subject_id` keeps its name; the code calls it `flagReferenceId`.

## Readings

The reading is the round's first step (`src/modules/occurrences/reading.ts`). There is no tool for it: an earlier version had agents write readings through a native `record_reading` tool, which made what the monitor counted a side effect of which agent had the grant. It was removed before release; an allowlist that still names it gets nothing.

Which conversations a round reads:

- conversations of the monitored inboxes whose customer wrote after their last reading (`conversations.last_inbound_at` against `occurrence_conversation_reads.read_inbound_at`, and the newest customer message's Chatwoot id against `read_inbound_message_id` where the mirror has one, since two messages in the same second share a time);
- a conversation never read only when its newest customer message is inside the recent window (`windowMinutes`) of the round, so switching the monitor on reads what is happening now, never the whole history. Admitting it writes its row in `occurrence_conversation_reads`, so a conversation the per-round cap, the budget or the spend ceiling left for later stays due after the window moves past it;
- at most **200 per round** (`READINGS_PER_ROUND`), the ones waiting longest first; the rest wait for the next round, and the round's `detail.reading.pending` says how many;
- with at most half of the round's model budget: past it, no new read starts, a read still waiting for a permit or for its model is cut there, and what is left waits too, so the themes and the flags keep the other half.

What the model reads: the conversation's newest **30 messages** (`READING_MESSAGES`), customer and team, private notes, reactions and activity lines excluded, rendered as the observer renders them and capped at 20,000 characters from the newest back. As the observer, it overlays the transcriptions and image descriptions only this process holds (an upstream Chatwoot drops the attachment-meta write-back) and leaves out everything before the conversation's last `/reset`, before any quote is resolved, so the episode the reset ended is never read back. What the reading does with each customer message's media is one decision (`occurrences/media.ts`, `settleMedia`), and the reading never waits for it. A message's media is complete when every voice note has its words (or was transcribed to nothing) and its files have their content: the arrival pass's result held in this process (written once, when every file is through, including an email's inline images and a count of files it could not read), or a description or text on every file's own attachment. A message whose media is not complete and that is younger than **10 minutes** (`READING_MEDIA_GRACE_MS`, by the message's own time) leaves the conversation due for the next round, with no failure counted; older, or with no time, it is read with the renderer's marker (a voice note never transcribed, a file never described, or either gone from this process's memory on upstream Chatwoot, below). A customer message that arrives during the read is not part of it and keeps the conversation due; and the account's fields, each as `key (name): description`. The prompt carries **no list of values written before**. In the prototype, listing the recent values in the extraction prompt lowered folder precision from 96% to 91-93%, because the model forces a conversation into a name it was shown. The model extracts free text here, and similarity is judged later. It answers one JSON string per field; a conversation with no public message is read as saying nothing.

**Voice notes and images on upstream Chatwoot.** On the fazer.ai Chatwoot, a voice note's transcription and an image's description are saved on the attachment, and the monitor reads them at any age. On upstream Chatwoot they are not saved anywhere: this process holds them in memory for about 15 minutes. A voice note or an image older than that when the round reads the conversation reaches the monitor without its content, and the conversation is marked read, so what the customer said only in that audio or image is not counted until they write again. Recovering it at reading time (transcribing or describing again with the inbox agent's configuration, opt-in, on its own cost line) is agents-master#373.

The transcript goes to the model escaped inside `<conversation>`, so a customer's own tag cannot close the block. A read that fails (Chatwoot could not be read, including a page it answered with a body or rows that do not parse, the provider erred, or the answer was unreadable) is counted against the customer message it was for, by its time and, where the mirror has one, its Chatwoot id (`failed_inbound_at` and `failed_inbound_message_id`), so a second message in the same second starts with no failures; after 3 (`READ_FAILURES_MAX`), that message is given up on until the customer writes again. A read the spend ceiling, the round's budget or the reading's share of it (also when it ran out while the call was out or waiting for a permit) or a step model that does not resolve refused is not a failure: the step stops there and the conversations stay pending. Four reads run at once, each as background work through the instance's model limit.

How a call is stored:

- Each value is trimmed, collapsed to single spaces and capped at 500 characters.
- An empty string is a value of its own: the conversation was read and said nothing. An empty reference is the no-reference bucket.
- A field the call did not name keeps whatever was stored for it.
- A call that names no field records nothing.

The Chatwoot write happens first, with the admin token. Only `attribute` fields with a non-empty value are written. If the round's budget ends inside the client's queue, or while the reading's write waits for a connection or a statement (which rolls it back), nothing is stored. Any other failure of that write is logged, and the reading is stored anyway: the reading is what the monitor counts, and the attribute is a copy for folders. Everything is fenced on the `/reset` mark that governed the transcript: a reset after it, while the model reads or by the time the copy's fence asks, means the values are the erased episode's, so the copy is called off and nothing is stored, and the conversation stays due for the new episode. A reset landing after that last check is caught under the conversation's row lock when the reading is stored, which leaves the reading with its canonical copy withdrawn.

`conversation_readings` keeps `first_read_at` from the first reading of that conversation and field, and moves `last_read_at` on every later one. `first_read_at` is what "conversations in the window" counts. `agent_id` is null on what the monitor reads; rows written by an agent before the change keep theirs.

## The monitored inboxes

Only conversations of `inboxIds` are read, fitted, assigned, flagged, copied to Chatwoot and counted on a dashboard. A theme member whose conversation is in another inbox (read before the monitor named its inboxes, or an inbox taken off the list) leaves its theme at the start of the next assignment, like a conversation whose reason was cleared; its readings stay, and it is placed again if its inbox comes back. Until then every read path (REST, MCP, the console and the dashboard source) filters a theme's conversations by the list saved now, so taking an inbox off takes its conversations off the counts, the first and last seen (and the list's order by them) and the theme's detail at once, and the save counts the flags and their reference again over the new list. The flags step always counts over the block saved at that moment, read under a share lock on the account's row, so a round that started with the old list cannot write back flags from an inbox already taken off. A theme with no member left is not listed.

The reading step asks, every round, which of the listed inboxes an agent receives right now (bound or observing): an inbox whose agent was unbound since it was listed is read no more from that round on, as the console says, and the round says so once in `detail.skipped` (`reading: no agent receives the inbox "<name>"`).

## Model

Every step runs on the provider, credential and model `model` names. No agent lends its key, its prompt or its reasoning effort. The model is resolved once per round; a credential deleted or of the wrong kind skips every step with one line each in `detail.skipped`.

Each call:

- asks the spend ceiling first, and a refusal skips that step for the round, leaving its input for the next;
- is billed to the account in `llm_usage`, with no agent, under the step's own node (`occurrence_reading`, `occurrence_canonical`, `occurrence_assignment` or `occurrence_consolidation`), with its model, cost and latency; a reading is tied to its conversation and inbox. The cost dashboard's split by call type shows the four as lines of their own ("Occurrences: reading", "Occurrences: reference names", "Occurrences: theme assignment" and "Occurrences: theme consolidation"), never under "Observer";
- is traced to the account's Langfuse when it has one;
- answers JSON, and an unreadable answer skips the step the same way.

The round sums its own calls into `model_calls` and `cost_usd`. The steps say why they skipped in `detail.skipped`.

## Canonical references

When the account reads a reference, every round each reference reading without a canonical is fitted:

1. The exact spelling is looked up in `occurrence_aliases`. A spelling decided before is never sent again.
2. Every spelling the dictionary has not seen goes to the model, in batches of 100, with the existing canonical names. The model answers an existing name or a new one. There is no case or accent folding: a spelling one letter away from a known one is still the model's decision.

An empty reference is the no-reference bucket. It is never sent and never becomes a canonical.

The dictionary and the canonical names belong to the reference field they were decided for (`field` on both tables): switching `referenceField` starts a new dictionary, so another field's values are never fitted with the old one's decisions. A name the model writes is stored as a reading is, without what a `text` column refuses.

When the reference field has `attribute: true`, the canonical name replaces the raw spelling in the conversation's Chatwoot attribute, so a folder filters by the canonical. The copy is written with the admin token, even when the canonical is the spelling itself, up to 200 per round, newest readings first, as the round's last step, so a slow Chatwoot spends only what the analytical steps left. A copy whose check could not read the reading or Chatwoot is not written and is tried next round. A `/reset` withdraws the conversation's pending copies before it clears the attributes, so a copy, one already queued included, never writes the reference back over the cleanup; an observation whose attribute write the fence admitted before the reset moved its mark stores its reading with the copy already withdrawn, since the reset's withdrawal may have run before that reading existed; the next reading of the conversation, in the new episode, makes it pending again. A copy that failed waits behind the ones never tried (`copy_tried_at`), so a conversation whose Chatwoot keeps refusing cannot take the whole batch, and a reading that changed between the check and the write keeps the name just posted among the leftovers it accepts, also when Chatwoot's answer to that write was lost (only a write its fence called off was surely not sent). `conversation_readings.canonical_written` says whether Chatwoot holds it: every write of the reading clears it, since the reading has just written its own spelling there, so a reading of the same spelling gets the canonical back next round, and a copy Chatwoot refused or the round had no budget for is tried again. The copy writes the name the conversation was given before when there is one (`written_name`, kept across merges, so a folder on an absorbed name keeps the conversation), and the survivor's otherwise. It asks, inside the conversation's write queue, whether the reading is still the one it chose and whether Chatwoot holds that spelling, nothing, the canonical, or what it may still hold from before this spelling (`remote_before`: the copy's last name, or every spelling since it, up to 5, leftovers of reading writes that failed), so a newer reading's write keeps its value even before its reading is stored. A write that slips between that read and the copy's own is rewritten by the next round, since the reading clears `canonical_written`.

A reading whose value changes loses its canonical, so a corrected reference is fitted again and a cleared one falls in the no-reference bucket. A spelling that changed while its fit was in flight is neither bound nor written to Chatwoot; it waits for the next round.

At each consolidation, the model may merge a canonical into another one that exists. The absorbed name's aliases and readings follow the survivor, and its redirect always points at the final survivor. A canonical is never renamed, since a folder may filter by it. Conversations already written to Chatwoot keep the name they have, so a folder built on the absorbed name keeps its conversations.

## Themes

`occurrence_themes`, with each conversation in at most one theme (`occurrence_theme_members`) and its own reason sentence kept verbatim.

**Assignment, every round.** The assignment model gets:

- the reason sentences no theme holds yet with that sentence, up to 100 per call and 5 calls per round;
- the open themes, up to 200, each with its title and up to 3 of its newest distinct sentences, taken from its 100 newest members.

It answers an open theme or a new title for each sentence. A conversation read again with the same sentence is not sent again, so it is never counted twice. A conversation whose sentence changed is assigned again and moves. A conversation whose reason was cleared, or that has no reading of the reason field since that field was switched, leaves its theme; the same words read for a new field are placed again with their own time. One changed or cleared while the model ran is not placed: it is the next round's. A call's answer is written in a handful of statements, whatever the number of sentences, so a full batch stays inside its transaction's budget.

**Consolidation, every `consolidationMinutes`.** The consolidation model gets the open themes with title, count and up to 5 sample sentences, never every conversation. It answers merges, splits and renames:

- A **merge** moves the absorbed theme's conversations to the survivor and redirects the absorbed theme to it. Every older redirect to the absorbed theme moves to the survivor too, so a redirect is never a chain. The merge is recorded in `occurrence_theme_events`, naming absorbed and survivor.
- A **split** names one part per concrete reason the theme mixes, as many as there are, and never cuts one reason across two parts; a theme whose sentences are all one reason is renamed, not split. The three calls (assignment, consolidation, partition) share the same definition of a theme, `THEME_IS` in `themes.ts`. A second call places each of the theme's sentences, up to 300, in one of them, with sentences that state the same reason in the same part. A sentence the answer leaves out goes to the first part, so no conversation is dropped. The split theme ends with status `split`.
- A **rename** changes the title and is recorded with the old and the new one.

## Flags

Counted exactly at the end of every round, from the members of each open theme. A conversation counts at the instant it was first read.

- Every flag needs at least N conversations in the recent window.
- **new**: none in the `previousDays` before the window.
- **above_usual**: the window's rate is X times the theme's own rate over the time the monitor actually covered before the window. Covered time is the previous days, or less when the readings start later. Dividing by days nobody read would make every theme look unusual on the monitor's first day.
- **concentrated**: at least `concentrationShare` of the window's conversations share one canonical reference. Conversations with no reference count in the window but never as the concentrated reference. A monitor with no `referenceField` never raises it.

The theme keeps the reference most of its window conversations share (`flag_subject_id`, `flagReferenceId` in the code), and `flagged_at` while it stays flagged.

## Rounds

`OCCURRENCE_ROUND` is one perpetual scheduler row per account (`src/modules/occurrences/arm.ts`):

- it is armed when the block is saved on, and at boot for every account whose monitor is on;
- it is cancelled when the block is saved off;
- each save's reconcile runs alone per account and reads the block only once it holds the lock, so the last one reads the last save and an older save never cancels the round a newer one armed. It writes the job in that same transaction, so it never waits on a second connection from the pool.

When it runs:

- A round on a monitor that has been switched off returns done and is not rearmed.
- A round whose configuration cannot be read retries in a minute.
- Every other round reschedules itself `cadenceMinutes` later.

A round runs, in order:

1. the reading of the monitored inboxes' conversations;
2. the canonical references, when the account reads one, so this round's flags already count by canonical;
3. the assignment of new sentences;
4. when no round consolidated within `consolidationMinutes`, the consolidation of themes and of canonicals;
5. the flags.

A round stops calling models a minute before the scheduler's deadline for the run, or as soon as the run is called off; each call is also capped at two minutes. Its calls go through the instance's model limit as background work, so they yield their permits to customers' turns, and the round's deadline holds across the wait for a permit, the call and a retry. What was skipped waits for the next round. A consolidation counts only when both passes completed, so one cut short, refused by the spend ceiling, answered unreadably or with a split it could not partition is tried again next round instead of a whole interval later.

Every round writes an `occurrence_runs` row before it reads anything, then closes it with:

- `status`: `ok` or `failed`;
- `finished_at` and `duration_ms`;
- `readings`: how many conversations this round's reading step read, the same number as `detail.reading.read`. A reading written outside a round is not counted. `counted_until`, which the earlier windowed count wrote, is no longer written;
- `model_calls` and `cost_usd`, the sum of the round's own ledger rows, with `unpriced_calls` for the calls with no price: `cost_usd` sums the priced ones, and is null when none had one, which the console shows as "No price" rather than a zero. The rounds are read from the ledger rows of the round's thread (`occurrences:<tenant>:<run>`), so a call an adapter finished after the round gave up on it, whose row lands after the totals were saved, is still counted; the saved totals answer for a run with no rows;
- `consolidated`, when the round ran the consolidation;
- `detail`: what each step did (`reading`: read, failed, withdrawn, pending; `canonical.asked` and `assignment.sent` count only what a call that reached the model carried, so a step that could not run, or a call the round's deadline ended while it waited for a permit, sent nothing), the steps it skipped and why (a provider's error sanitized, since it can echo the key; the same line said by many reads folded into one with its count, at most 20 lines), and `error` when the round failed, with the message sanitized.

A process that dies mid-round leaves the row at `running`.

Every table of the monitor is under FORCE row-level security, with the tenant policy and the fleet super-admin policy.

## Transports

- **Console:** Components > Occurrences (`OccurrencesPanel.tsx`), in three tabs kept in the page URL (`?tab=config|themes|rounds`; an unknown value opens the configuration, Back returns to the previous tab, and every tab stays mounted so an unsaved edit survives a look at another):
  - **Configuration** (`OccurrenceSettings.tsx`), in sections, each with a line saying what it is for: the inboxes by name (the ones no agent receives shown as unavailable), with the round's caps stated (200 conversations, the newest 30 messages of each); what to read from each conversation: the reason and the reference as two fixed fields, each with an editable name and description and a default for both, the reference behind a switch (off, its card says only the concentration flag is off, and so does that threshold's box), and any other field in a collapsed "Additional fields" section, with no select assigning a role; when a theme is flagged, each input in plain words with its default and, under them, one sentence saying what the flags step does with the values as they are typed ("Flags a theme as out of the usual when it has at least 5 conversations in the last hour and, on top of that, is new (no conversation in the 7 days before), or runs at 3 times its usual, or has 60% of those conversations with the same reference."), without the last clause when there is no reference; the one model, in the agent Model card's order; the business context with its count; and how often the rounds and the consolidation run. Theme, consolidation and "usual" each have a help popover. Under the switch, once the monitor is saved on, one status line says whether it is working: when the last round ran and whether it finished, the first step that did not complete and why in plain words (and how many more did), and when the next round is expected (one cadence after the last one ended), with a link to the Rounds tab. The flags section links to Dashboards, where a panel with the Occurrences source and "Flagged themes only" shows the flagged themes; the panel editor has no preset to open, so the link names what to add.
  - **First run**: a monitor with no reason field starts with the two fixed fields filled with their defaults (Reason: why the customer got in touch, in one short sentence; Reference: what the reason refers to, as the customer names it), which do not count as an edit until the admin changes something. There is no template to apply.
  - **Themes** (`OccurrenceThemes.tsx`): the open themes flagged first, 20 per page, each with its count, its main reference labelled (left out when it says the same as the title) and when it was last seen in relative words (the exact first and last times on hover, once when they are equal), each opening to its conversations, their sentences and links to Chatwoot. The list is read once (up to 500, with the total said past that) and paged on screen, so a round that reorders the themes while the operator pages never repeats or skips one; Refresh and opening the tab read it again.
  - **Rounds** (`OccurrenceRounds.tsx`): the monitor's cost over the last 7 and the last 30 days, then the rounds newest first, 20 per page, each with when it started, how long it took, how many conversations it read and how many were still waiting, model calls, cost and result; opening one says what each step did, in words: each step's main count always (read, new names, placed), its secondary counts only when not zero, and what a count means, when it is not obvious, in a popover. A step that did not complete says why in the screen's language, from the reason code; the provider's or the round's own error text is behind a details popover, never the sentence. Pages are keyed on the last round shown, so a round that starts meanwhile shifts nothing. While the monitor is on and no round has finished yet (or the newest is running), the first page is read every 5 seconds, so the first round shows up without a reload; otherwise every minute while the tab is open. A save reads it at once.
  - Every count is said in the singular and the plural of each language (pt-BR's zero included).
- **REST:**
  - `GET /v1/occurrences/config` and `PUT /v1/occurrences/config`, where a field the body leaves out keeps its value; the body takes `reasonField`, `referenceField` and `model` (see Configuration);
  - `GET /v1/occurrences/runs?limit=&before=`, 1 to 200, default 20, newest first, with `total` (every round of the account) and `nextBefore`, the id to pass as `before` for the next page (null on the last). Each round carries `steps`: what each step did (`reading`, `canonical`, `assignment`, `consolidation`, `flags`, null for a step the round did not reach) and `skipped`, each line as `{ step, reason, message, inbox, count }`. `reason` is a code: the monitor's own reasons (`no_model`, `spend_ceiling`, `round_budget`, `unreadable_answer`, `credential_unresolved`, `credential_not_key`, `endpoint_missing`, `endpoint_not_taken`, `inbox_unreceived` with the inbox's name in `inbox`), a provider's error by its most likely meaning (`credential_refused` for HTTP 401 or 403, `model_refused` for HTTP 404, `rate_limited` for HTTP 429, `timeout`, and `endpoint_unreachable` when the client could not open the connection, which the round names before the provider boundary reduces the error to "provider error"), or `error` when none matched. `message` keeps the stored text, sanitized, for every reason the monitor does not write in a fixed phrase. A `before` that is not an id is a 422;
  - `GET /v1/occurrences/cost`: what the monitor's calls cost over the last 7 and 30 days, from the ledger rows of its four lines (`occurrence_reading`, `occurrence_canonical`, `occurrence_assignment`, `occurrence_consolidation`), each `{ costUsd, calls, unpricedCalls }`;
  - `GET /v1/occurrences/themes?flagged=&limit=`, with `total` past the limit, and `GET /v1/occurrences/themes/:id`. An absorbed theme answers as its survivor.

  All of them require TENANT_ADMIN.
- **MCP:**
  - `occurrences_get`, `occurrence_runs_list` (the REST page, `before` included, plus the cost over 7 and 30 days) and `occurrence_themes_list` (with `total`) (`mcp:read`);
  - `occurrences_set` (`mcp:write`), with the same keys as the REST body, which previews unless `dry_run` is false and refuses an argument the block does not have.
- **Audit:** every save writes `tenant_settings.occurrences_set` with the whole block before and after. The field descriptions and the business context are the account's instructions to the monitor, not a customer's words, and the trail is where an admin reads who changed them.
