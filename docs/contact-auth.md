# Contact authorization gate

Some agents may only serve contacts that a system **outside** the console knows about: the customers
of a platform, the policyholders of an insurer, the patients of a clinic. Writing "only help
registered customers" into the prompt is not a gate: the model can be talked around, and every
attempt still costs a turn. This feature is the deterministic version: **before** the turn, the
runtime asks an operator-configured endpoint whether the contact may be served, caches the verdict,
and only a positive answer lets the model run. Everything else (an explicit denial, an endpoint
failure, a contact with no phone) ends in **no turn** (fail-closed), with the operator told why.

Lives in `src/modules/contact-auth/` (`settings.ts` the config reader, `check.ts` the request +
decision table, `cache.ts` the verdict cache, `service.ts` the orchestration both callers share).

## Configuration (`agent.settings.contactAuth`)

Per agent, on the shared behavior surface (editor Behavior tab → "Contact authorization", REST
`PATCH /v1/agents/:id`, MCP `agent_settings_set`). Defaults in parentheses; every field clamps on
read, so a malformed bag can never break the webhook.

| Field             | Default | Meaning                                                                   |
| ----------------- | ------- | ------------------------------------------------------------------------- |
| `enabled`         | `false` | The gate as a whole. Strict boolean: anything else reads as off.          |
| `url`             | `null`  | The endpoint. Fixed origin, no placeholders; http(s) only, and a URL carrying `user:pass@` is refused whole (credentials belong in the vault). |
| `method`          | `GET`   | `GET` or `POST` (the two request shapes below).                           |
| `credentialRef`   | `null`  | Optional `vault:<id>`, injected per the entry's kind (bearer / header / query; managed-OAuth kinds send a fresh access token). |
| `timeoutMs`       | `5000`  | Clamped 1000-10000. Past it the check counts as an error.                 |
| `cacheTtlSeconds` | `300`   | Clamped 0-86400; how long a verdict (allowed AND denied) is reused for the same contact. 0 = ask on every message. |
| `denyMessage`     | `null`  | Fixed copy the CUSTOMER receives on a denial (≤ `TEMPLATE_MESSAGE_MAX`). `null` = say nothing. |
| `handoffEnabled`  | `true`  | Open a refused conversation for humans (the `handoff_to_human` mechanics: bot-token `toggle_status open`). |
| `handoffTeamId`   | `null`  | Chatwoot team assigned after the open (bot-token `assignments`). `null` = inbox routing. Flat beside `handoffEnabled` for the mergeBehaviorSettings one-level-merge reason the tts block documents. |

## Request / response contract

The identity is **always trusted context**, the phone Chatwoot mirrored for the contact
(`Contact.phone`), never an argument the model chose and never anything the customer typed.

- **GET**: `phone=<E.164>` and `contact_id=<Chatwoot contact id>` are appended to the configured
  URL's query string (an existing query survives; `contact_id` is omitted on the rare mirror row
  that never learned it).
- **POST**: JSON body `{ "phone", "contactId", "conversationId", "inboxId" }`
  (`content-type: application/json`).
- **Answer**: a 2xx with JSON `{ "authorized": boolean, "reason"?: string }`. A 2xx without the
  boolean is an **error**, not a pass. `401`/`403`/`404` read as **denied** (so an endpoint may
  answer REST-style without a body). Any other status, a timeout, a network failure, a redirect
  (`redirect: "error"`), a blocked URL (SSRF guard on the final URL; https-only in production, http
  where `SSRF_ALLOW_PRIVATE_TARGETS` applies, like HTTP tools), an unresolvable/pending credential,
  or a body over 64 KB is an **error**.
- `reason` must be a short **code** (`/^[a-z0-9][a-z0-9._-]{0,63}$/i`). Prose is dropped before it
  reaches the log, the cache or the operator note, because free text from the endpoint could quote
  the customer.

## Where the gate runs

**Webhook** (`maybeConsumeCommandOrGate` in `src/modules/chatwoot/webhook.ts`): the last of the
pre-turn gates, in this order: redirect cross-link → test-mode (`/teste`, `/reset`) → WhatsApp→chat
redirect → availability → **contact auth**. Last on purpose: a conversation an earlier gate already
silenced costs no authorization call. It runs only for a new incoming message on an enabled,
agent-bound inbox. Consuming outcomes advance the handled watermark and the message is folded into
the memory thread like any other unanswered one.

- **allowed** → the delivery proceeds (debounce / turn).
- **denied** → the `denyMessage` (when set) goes to the customer under the same `stillOurs` fence and
  persona token every gate message uses; the conversation is opened for humans (+ team) when
  `handoffEnabled`; a pt-BR private note tells the operator, with the `reason` code when one came.
- **error** → nothing to the customer, no handoff (it is transient by contract, see the cache), a
  private note + a `warn` flow line. The next message after the short error TTL retries.
- **no_identity** (contact with no phone) → nothing to the customer (the deny copy would mislead an
  unidentified web visitor), but the conversation IS opened for humans when `handoffEnabled`: a
  contact the gate can never authorize would otherwise stay pending and unanswered forever.

Customer message, handoff and note fire only on a **fresh** verdict; while a verdict is cached the
message is consumed silently. So a customer writing in a burst is told once, and `cacheTtlSeconds`
also bounds how often they are told again.

**Proactive nudge** (`runAgentNudge` in `src/graph/nudge.ts`): the same check before any tool or
model work: a follow-up is a turn the agent starts, and a contact the reactive gate would refuse
must not be reached out to either. Denied/error/no-identity all end as the `silent` outcome (no
note downgrade: the nudge's text was written FOR the customer), with the same flow line.

**Playground**: the gate does not run; there is no Chatwoot contact to ask about, and the
playground exists to test the agent's own behavior.

## Cache

In-memory, per process (single-replica invariant), keyed `${tenantId}:${agentId}:${contactDbId}` →
verdict + expiry. Allowed, denied and no-identity verdicts live `cacheTtlSeconds`; an **error**
lives 30 s whatever the TTL says, so an endpoint outage never silences a contact for the whole
window. Concurrent checks for one contact are single-flighted (one request, followers share the
verdict). Expiry is active: a rescheduled, unref'd sweep wakes at the earliest expiry
(`sweepContactAuthCache` / `nextSweepDelayMs`, exported for tests). The cache stores ids and
verdicts only, never the phone.

## Observability

One `contact_auth` flow line per evaluation (`src/modules/flowlog/stages.ts`), `detail` =
`{ outcome: "allowed"|"denied"|"error"|"no_identity", cached, status?, reason? }`: enums, a
boolean, a status and a slug; no PII (covered by `tests/modules/flowlog-detail-pii.test.ts`).
Denied is `info` (ordinary operation); error and no-identity are `warn`, so alert channels page on
inbox traffic. Errors deliberately do **not** stamp `Conversation.lastError`: the re-engage button
that field offers replays the turn *without* re-running this gate, which is not the right retry for
a refused contact; the retry here is the next message, after the error TTL.

## What this is NOT

- **Not per-contact credentials for tools.** The gate answers "may this contact be served at all";
  it does not exchange the contact's identity for a token, vary HTTP-tool credentials per contact,
  or forward anything to the toolset. Tools keep their own credential model.
- **Not an identity verification.** The phone is whatever WhatsApp/Chatwoot attributed to the
  contact; the gate trusts the channel's identity, it does not prove it.
- **Not a spend firewall for media.** Eager STT/vision run before the gate (they feed the memory
  thread even for silenced messages), so a denied contact's voice note still gets transcribed.
  Known, accepted: the LLM turn is the cost the gate exists to stop.
