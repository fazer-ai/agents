# Contact authorization gate

Some agents may only serve contacts that a system **outside** the console knows about: the customers
of a platform, the policyholders of an insurer, the patients of a clinic. Writing "only help
registered customers" into the prompt is not a gate: the model can be talked around, and every
attempt still costs a turn. This feature is the deterministic version: **before** the turn, the
runtime asks an operator-configured endpoint whether the contact may be served, and only a positive
answer lets the model run. Everything else (an explicit denial, an endpoint failure, a contact with
no identifiers) ends in **no turn** (fail-closed), with the operator told why.

**Every incoming message is re-checked.** No verdict is cached: the endpoint owns the answer, so a
revocation on the operator's side takes effect on the contact's very next message, and an unlock
(below) is honored the moment it happens. The flip side is sizing: the endpoint receives **one
request per incoming message** on gated inboxes (plus one per proactive follow-up), and must be
provisioned for that rate. Concurrent deliveries for one contact are single-flighted into one
request; sequential messages are not.

**An allowed verdict is re-fenced against the conversation's owner.** Every caller checks
attribution before asking (a conversation a human owns costs no authorization call), and the ask is
a round-trip to somebody else's endpoint with a ceiling of `timeoutMs`. A human taking the
conversation inside that window would otherwise find the turn running on it: the runtime re-checks
ownership only after the model has answered, which withholds the reply and nothing else, long after
the tools have written their labels, cards, attributes and outbound calls. So each of the four
callers asks again, its own way, the moment the verdict comes back allowed — the webhook and the
debounce flush against the mirror, the re-engage against the mirror (reporting `gate-closed`, the
same as the early check), the nudge through its own live probe. The turn's build-and-invoke is slow
too and this does not pretend to fence that: it is the runtime's window, the same one every agent
has. What the fence does is refuse to WIDEN it by the length of an operator's network call.

Two callers narrow what the turn may contain, for the same reason. The **debounce flush** re-reads
the handled watermark at the point the burst is chosen, and the **manual re-engage** filters its
tail by it — a message that arrived and was REFUSED during the authorization call has already had
the watermark advanced past it by its own delivery, and the re-engage tail is chosen from the last
OUTGOING message, which a refusal never writes. The floor is blunt: the watermark is aggregate, so
on re-engage it also covers an older unanswered tail and the button comes back "nothing new to
answer". That is the fail-closed side of the trade, and it is why the floor applies only with the
gate ON: everywhere else re-engage keeps its full reach.

**The nudge asks only when it could reach the contact.** On a conversation a human already owns, an
event nudge cannot message the customer — it ends as a private note for the operator
(`docs/integrations.md`), which is signal FOR the human rather than an approach to the customer. No
verdict is requested there, and none is acted on: doing so would spend a call on somebody else's
endpoint to decide about a message that never goes out, and would turn that documented note into
silence. The takeover fence above is about a conversation CHANGING hands during the call, not about
one that was never the bot's.

**A verdict describes the instant the endpoint evaluated it, and nothing after.** The guarantee is
per message, not a global order: two checks that overlap in time (a nudge against an incoming
message, or two messages under `includeMessageText`) are independent requests, and they can settle
out of order, so a positive answer that was already in flight can land after a refusal. Ordering
them would not close that window, only move it — the operator can revoke a millisecond after the
endpoint replies, and no amount of local bookkeeping sees that. What ordering them WOULD cost is
real: a per-contact order puts a slow check in front of the next message, including the unlock one.
So the runtime does not serialise, and the fences sit where an out-of-order verdict can still do
damage — the customer copy and the handoff both re-check that the conversation is still the bot's
(`stillOurs`), and the notices are claimed per conversation.

Lives in `src/modules/contact-auth/` (`settings.ts` the config reader, `check.ts` the request +
decision table, `state.ts` the single-flight + notice cooldown, `service.ts` the orchestration both
callers share).

## Configuration (`agent.settings.contactAuth`)

Per agent, on the shared behavior surface (editor Behavior tab → "Contact authorization", REST
`PATCH /v1/agents/:id`, MCP `agent_settings_set`). Defaults in parentheses; every field clamps on
read, so a malformed bag can never break the webhook.

| Field                   | Default | Meaning                                                             |
| ----------------------- | ------- | ------------------------------------------------------------------- |
| `enabled`               | `false` | The gate as a whole. Strict boolean: anything else reads as off.    |
| `url`                   | `null`  | The endpoint. Fixed origin, no placeholders; http(s) only, and a URL carrying `user:pass@` is refused whole (credentials belong in the vault). |
| `credentialRef`         | `null`  | Optional `vault:<id>`, injected per the entry's kind (bearer / header / query; managed-OAuth kinds send a fresh access token). A kind the vault marks as never-injected (`mcp_env`, `langfuse`) is refused as an error rather than falling back to a Bearer, which would hand an unrelated secret to the endpoint. |
| `timeoutMs`             | `5000`  | Clamped 1000-10000. Past it the check counts as an error. Covers every step that waits, and the clock starts at the FIRST of them: resolving the credential (a managed-OAuth entry refreshes its token there, over the network, under a ceiling of its own), the SSRF/DNS check on the final URL, the request, and the body. One budget for the lot — timed from the request instead, a gate set to one second could hold the webhook turn behind it for eleven. |
| `noticeCooldownSeconds` | `60`    | Clamped 0-3600. Cooldown on the NOTICES for a refused message (the customer copy and the operator note, per conversation), never on the verdict: the endpoint is asked on every message regardless. 0 = notify on every refused message. |
| `includeMessageText`    | `false` | Forward the triggering message's text as `message.text`, so the endpoint can accept an unlock code the customer sends. Under its own key, never inside `contact`. |
| `denyMessage`           | `null`  | Fixed copy the CUSTOMER receives on a denial (≤ `TEMPLATE_MESSAGE_MAX`). `null` = say nothing, which is a real choice: with the handoff on, a human takes the conversation and may not want an automated refusal ahead of them, and towards an unknown number a reply confirms the channel exists. Null AND the handoff off means a refused customer gets nothing at all, so the editor raises `contactAuthSilentRefusal` for that pair. |
| `handoffEnabled`        | `true`  | Open a refused conversation for humans (the `handoff_to_human` mechanics: bot-token `toggle_status open`). |
| `handoffTeamId`         | `null`  | Chatwoot team assigned after the open (bot-token `assignments`). `null` = inbox routing. Flat beside `handoffEnabled` for the mergeBehaviorSettings one-level-merge reason the tts block documents. |
| `handoffTeamInstanceId` | `null`  | Our ChatwootInstance id the team above was picked from, recorded with it: a team id belongs to one account, and the team is assigned only in that account. `null` = a value stored before this field existed (falls back to the multi-account check). |

## Request / response contract

The request separates two kinds of data, and the separation IS the contract:

- **`contact` is trusted context**: what Chatwoot mirrored for the contact (never an argument the
  model chose). `phone` is the number the channel attributed; `email` and `name` are the mirrored
  columns; `identifier` is the Chatwoot contact `identifier`, i.e. **the operator's own id for this
  customer**, the strongest key an endpoint can receive; `chatwootContactId` is Chatwoot's row id
  (context only, it says nothing to the operator's system).
- **`message` is what the customer typed.** It is the one field the customer controls. An endpoint
  must never read identity out of it; its use is an **unlock**: "send your access code to be
  served", where the endpoint validates the code against its own records.

The request is always a **POST**: there is no GET shape and no `method` setting. A query string
lands in the endpoint's access logs, cannot carry the customer's text at all, and reserves four
parameter names that a query-injected credential would then silently overwrite. One shape also means
one thing to document, one thing to test, and one place for the identity to be.

Shapes:

- **Request** (`content-type: application/json`). The operator's own query string, if the configured
  URL has one, is left untouched: nothing about the contact is appended to the URL.

  ```jsonc
  {
    "contact": {
      "phone": "+55...",            // or null
      "name": "...",                // or null
      "email": "...",               // or null
      "identifier": "client-4821",  // or null: the operator's own id
      "chatwootContactId": 1234     // or null
    },
    "conversation": { "id": 987, "inboxId": 12, "channel": "whatsapp" },
    "message": { "text": "..." }    // only with includeMessageText, capped at 4000 chars
                                    // absent when the opt-in is off, the text is empty,
                                    // or the check came from a nudge or a re-engage
  }
  ```

  `conversation.channel` is the inbox's channel as a slug (`whatsapp`, `web_widget`, `api`, ...).
- **Answer**: a 2xx with JSON `{ "authorized": boolean, "reason"?: string }`. A 2xx without the
  boolean is an **error**, not a pass. `401`/`403`/`404` read as **denied** (so an endpoint may
  answer REST-style without a body), and they are read that way BEFORE the body: only a 2xx has to
  carry its verdict, so only a 2xx needs a body small enough to read. A 403 behind a proxy that
  serves a large HTML error page is still a refusal, not a transient failure. Any other status, a timeout, a network failure, a redirect
  (`redirect: "error"`), a blocked URL (SSRF guard on the final URL; https-only in production, http
  where `SSRF_ALLOW_PRIVATE_TARGETS` applies, like HTTP tools), an unresolvable/pending credential,
  or a body over 64 KB is an **error**.
- `reason` must be a short **code** (`/^[a-z0-9][a-z0-9._-]{0,63}$/i`). Prose is dropped before it
  reaches the log or the operator note, because free text from the endpoint could quote the
  customer.

A contact whose mirror holds **no phone, no email and no identifier** is `no_identity`: there is
nothing to ask the endpoint about, and fail-closed means nobody unidentified is served.
`chatwootContactId` alone does not count as identity.

Every identity field follows one rule in the mirror: a payload that does not CARRY the field leaves
what is stored (a degraded payload must not wipe identity), and one that carries it is written as
Chatwoot says, cleared included — a phone kept after it was removed asks the endpoint about whoever
used to have it. Each field carries its OWN source watermark (`contacts.name_at`, `email_at`,
`phone_at`, `attributes_at`), because a payload states a subset of them: one row-wide position would
be moved by an event that never spoke about the field it then protects, and a name-only event would
reject a phone clear arriving behind it.

`last_activity_at` has one-second resolution, so two events inside one second cannot be ordered by
it at all, and a tie is settled per FIELD against the value already STORED: a stated value that
matches changes nothing (a re-delivery is two payloads that agree), and a stated value that differs
clears the field. That covers a clear losing to a stale value and two different values landing in
the same second alike — in both, keeping either is a coin toss about who this customer is, and
clearing is the side the gate can live with: it ends up asking about less, or about nobody, instead
of asking the operator's endpoint about an identity that is not theirs. Per field, because an older
snapshot that happens to carry an unrelated cleared field must not ride that in to rewrite the rest
of what it holds.

**On upgrade**, the watermarks are seeded from the newest event that touched each contact and the
identity is KEPT. Seeding is what stops a Chatwoot retry already in flight, whose snapshot predates
what is stored, from being accepted against a null position. What it does not settle is whether the
stored value belongs to that position: the old mirror wrote identity before the conversation's stale
check, so these columns hold what the last event to ARRIVE said, not the newest to have happened.
That value is pinned under a newer position until the contact's next event corrects it.

Clearing the identity instead would swap that residual doubt for a certain outage. These values are
live — `{{nome_contato}}` and `{{contact_phone}}` in prompts and HTTP tools, `{contact_name}` in an
HSM template, the name in the console's conversation list — and emptying them for every contact of
every tenant to protect a gate that ships **disabled on every agent** costs everyone something real
to prevent nothing: on upgrade day no contact is being authorized at all. Nor does the gate inherit
the doubt when it is switched on later, because the reactive check runs AFTER the mirror wrote the
very message that triggered it (`mirrorChatwootEvent`, then the gate), so it decides on identity
that message just refreshed. The one caller that asks with no incoming message is the proactive
nudge, and there the exposure is a contact whose stored identity was already stale before the
upgrade — the state every deployment is in today.

A contact that two Chatwoot accounts had collapsed into one row (the reason `chatwoot_instance_id`
exists) is cleared harder: the losing account's conversations are unlinked, and the retained row
loses its custom attributes and their watermark, and its audio preference, alongside the identity.
Those are per-contact state the collision could have written from either account, and the custom
attributes are read into the system prompt as facts about whoever is on the other end. The audio
preference is written by the agent and never mirrored back from Chatwoot, so nothing else would ever
correct it; null is a state it already has.

The mirrored contact is scoped by **Chatwoot instance**, which this feature is what made necessary:
a Chatwoot contact id is unique inside one account, not across a tenant, so two accounts under the
same tenant used to collapse contact 42 into one row and the mirror's last-writer-wins left one
person's name over another's phone. That was wrong for the prompt already; here it is the identity
sent to the endpoint. The stored `identifier` follows Chatwoot exactly, cleared included: keeping a
stale one after an unlink means asking about a customer this contact is no longer linked to.

## Where the gate runs

**Webhook** (`maybeConsumeCommandOrGate` in `src/modules/chatwoot/webhook.ts`): the last of the
pre-turn gates, in this order: redirect cross-link → test-mode (`/teste`, `/reset`) → WhatsApp→chat
redirect → availability → **contact auth**. Last on purpose: a conversation an earlier gate already
silenced costs no authorization call. It runs only for a new incoming message on an enabled,
agent-bound inbox that the bot still owns (the attribution gate runs first, so a conversation in
human hands never triggers a check). Consuming outcomes advance the handled watermark and the
message is folded into the memory thread like any other unanswered one.

- **allowed** → the delivery proceeds (debounce / turn).
- **denied** → the `denyMessage` (when set) goes to the customer under the same `stillOurs` fence and
  persona token every gate message uses; the conversation is opened for humans (+ team) when
  `handoffEnabled`; a pt-BR private note tells the operator, with the `reason` code when one came.
- **error** → nothing to the customer, no handoff (transient by contract: the next message retries),
  a private note + a `warn` flow line.
- **no_identity** (no phone, email or identifier) → nothing to the customer (the deny copy would
  mislead an unidentified web visitor), but the conversation IS opened for humans when
  `handoffEnabled`: a contact the gate can never authorize would otherwise stay pending and
  unanswered forever.

A Chatwoot team id belongs to ONE account, so `handoffTeamInstanceId` records the account the team
was picked in and the runtime assigns the team only in that one. The editor stops offering a target
while the agent serves several accounts, but that check cannot see the case it matters most in: an
agent MOVED to another account has one account again, and the stored number belongs to the old one.
A value with no recorded account (stored before this field existed, or written through REST, MCP or
an import) falls back to the older question — is more than one account served? Either way a target
that cannot be vouched for is skipped and the refused conversation falls back to Chatwoot's own
inbox routing; the open still happens.

The verdict is per message; the **notices** are not. The customer copy and the private note sit
behind `noticeCooldownSeconds` (per conversation, in process memory), so a refused burst is voiced
once per window instead of once per message. A window is claimed BEFORE the delivery (two settled
deliveries racing must not both speak) and given back when the delivery fails, so a message Chatwoot
refused does not silence the next refusal for the rest of the window. A release only ever gives back
its own claim: with a cooldown shorter than a slow send, a lapsed one may already have been replaced. Each notice holds its OWN window: an endpoint error
writes a note and speaks to nobody, and one shared window let it spend the customer's, silencing the
denial that came right after it — the copy that usually carries the unlock instructions, with the
handoff after it ending the bot's attribution and leaving no later message to carry them. The handoff is NOT behind the cooldown: it is
idempotent, and a first attempt that failed must be retried. With handoff on the cooldown rarely
matters (the open ends the bot's attribution and the gate stops running); with handoff off it is
what keeps five messages from drawing five identical replies. Losing the cooldown on a restart
merely repeats a notice.

**The unlock flow** (`includeMessageText`): a denied customer is told, via `denyMessage`,
how to unlock (for example "send the access code from your invoice"). Their next message arrives,
the gate runs again (nothing was cached), and the endpoint now sees `message.text` carrying the
code: it validates the code against its own records, links the contact, answers
`{ "authorized": true }`, and the turn runs. No special case in the runtime: it is just the next
check.

**It needs the handoff OFF** (`handoffEnabled: false`), and that is the one thing about it worth
saying twice. The handoff opens the conversation and assigns it, and an open conversation is no
longer the bot's: `shouldBotHandle` refuses it before the gate is reached, so the code the customer
sends next never gets asked about. With the default (`handoffEnabled: true`) the first refusal is
also the last one, and a `denyMessage` asking for a code is asking for something nothing will read.
Neither switch is wrong on its own — one wants the customer to prove who they are, the other wants a
human to take it from here — so the runtime does not resolve the contradiction: the agent editor
raises a configuration warning (`contactAuthUnlockHandoff`) when both are on.

**Proactive nudge** (`runAgentNudge` in `src/graph/nudge.ts`): the same check before any tool or
model work: a follow-up is a turn the agent starts, and a contact the reactive gate would refuse
must not be reached out to either. Denied/error/no-identity all end as the `silent` outcome (no
note downgrade: the nudge's text was written FOR the customer), with the same flow line. A nudge
has no triggering message, so it never carries `message` — and for the same reason it never shares
a single-flight with an incoming one. A refused nudge still applies the follow-up's deterministic
post-actions (the step fired and the sequence advances either way, so the operator's labels would
otherwise be lost), minus the resolve: nothing reached the customer. Ownership is re-probed first —
the check is a round-trip with a ten-second ceiling, and stamping labels on a conversation a human
took during it would be writing on theirs.

**Debounce flush** (`flushDebounceJob` in `src/modules/debounce/handler.ts`): checked again, after
the assignee gate and before the model, and the burst is selected against the handled watermark as
it stands AFTER that check: the check is a round-trip to somebody else's endpoint, and a message
that arrived and was refused during it has already had the watermark advanced past it by its own
delivery. The webhook checks every incoming message, but a turn is not
a message: with debounce on, one allowed message arms a flush that a later refused message rides
into (the refused delivery arms nothing, but the pending flush re-fetches everything past the
watermark), and a verdict revoked inside the coalescing window is the same hole from the other side.
A refusal ends the flush the way a human takeover does: the burst counts as handled, the watermark
advances off the payload's own last id, nothing is posted. No customer copy and no handoff — those
answer a message the customer just sent, and the webhook path already gave them to the delivery it
refused. The flow line is what tells the operator the burst was dropped.

**Manual re-engage** (`reengageConversation` in `src/modules/conversations/reengage.ts`, behind the
console button, `POST /v1/conversations/:id/reengage` and the MCP write action): the same check,
after the assignee gate and before the model. Re-engage answers the unanswered tail, which may be
unanswered precisely BECAUSE the contact was refused when it arrived, and the operator pressing the
button is not the authorization — the endpoint is. A refusal ends as the `not-authorized` outcome,
reported to whoever pressed it (a toast in the console, the outcome in the API/MCP result) and
written to the flowlog; nothing is sent to the customer and there is no handoff, because both exist
to answer a message the customer just sent and here there is none. Like a nudge it carries no
`message` and never shares a single-flight with an incoming one.

**Playground**: the gate does not run; there is no Chatwoot contact to ask about, and the
playground exists to test the agent's own behavior.

## In-process state (`state.ts`)

Not a cache. Two things live here, both in memory (single-replica invariant), both harmless to
lose on a restart:

- **Single-flight** per `${tenantId}:${agentId}:${contactDbId}:${request}`: concurrent deliveries of
  the SAME asking coalesce into one request; the leader acts on the verdict, followers are consumed
  silently. `request` is the message id under an unlock flow and the source otherwise, so a nudge
  (which carries no text) and an incoming message (which may carry the code) are never answered by
  each other's verdict — the follower is told `shared`, and `shared` is what withholds its own copy,
  handoff and note. Dedupe of work in flight; nothing outlives the promise.

  Coalescing the QUESTION is not coalescing its consequences: the copy, the handoff and the note
  belong to a CONVERSATION, and one contact can have two open ones, so every affected conversation
  runs them. What stops two deliveries of the same conversation from both speaking is the notice
  claim, which is per conversation and synchronous.
- **Notice cooldown** per `${tenantId}:${agentId}:${conversationRowId}:${notice}`, where `notice` is
  the customer copy or the operator note: when a refusal was last voiced. Swept actively (a rescheduled, unref'd timer wakes at the earliest lapse) and capped in
  size. Stores ids and timestamps only.

## Observability

What the ENDPOINT calls a refusal reaches the operator note and nothing else. The slug guard on that
value checks its SHAPE, and `5511999999999` and `customer_4821` are both slug-shaped, so publishing it
would put a phone number in a `detail` that alert channels are promised to be PII-free. The note sits
in the operator's own Chatwoot, on the conversation it describes.

One `contact_auth` flow line per evaluation (`src/modules/flowlog/stages.ts`), `detail` =
`{ outcome: "allowed"|"denied"|"error"|"no_identity", shared, status?, reason? }` (`reason` is OUR
own failure code, from a fixed list in this repository): enums, a
boolean (`shared` = this call was coalesced into another's request), a status and a slug; no PII
(covered by `tests/modules/flowlog-detail-pii.test.ts`), and never the message text. Denied is
`info` (ordinary operation); error and no-identity are `warn`, so alert channels page on inbox
traffic. Errors deliberately do **not** stamp `Conversation.lastError`: the re-engage button that
field offers replays the turn *without* re-running this gate, which is not the right retry for a
refused contact; the retry here is simply the contact's next message.

## What this is NOT

- **Not per-contact credentials for tools.** The gate answers "may this contact be served at all";
  it does not exchange the contact's identity for a token, vary HTTP-tool credentials per contact,
  or forward anything to the toolset. Tools keep their own credential model.
- **Not an identity verification.** The phone is whatever WhatsApp/Chatwoot attributed to the
  contact; the gate trusts the channel's identity, it does not prove it. `message.text` in
  particular is customer-typed and must only ever be validated against the endpoint's own records
  (an unlock code), never believed as identity.
- **Not a spend firewall for media.** Eager STT/vision run before the gate (they feed the memory
  thread even for silenced messages), so a denied contact's voice note still gets transcribed.
  Known, accepted: the LLM turn is the cost the gate exists to stop.
