# WhatsApp → website-chat redirect (`channel-redirect`)

Use the **official WhatsApp Cloud API** only as an entry door: a lead who messages WhatsApp gets a fixed
(no-AI) auto-reply with a link to the customer's website chat (a Chatwoot **web widget**), and the AI
serves the conversation **there**, where messages have no per-message WhatsApp cost. The widget
conversation is merged onto the same contact, so it is one continuous history across both channels.

The whole feature is **per-agent** (`agent.settings.channelRedirect`) and configured from the agent
editor's **Redirect** tab. This repo provisions **nothing** on Chatwoot for it — the two inboxes are
created and wired **manually** in Chatwoot, then selected in the tab (see setup below).

## Runtime flow

```
Lead → [WhatsApp entry inbox] → webhook: redirect gate (NO AI)
   │  • sets the contact identifier (fzwa:<chatwootContactId>)
   │  • mints a single-use token on Chatwoot (carries {identifier, cloned message}, fixed 24h TTL)
   │  • replies with the fixed redirectMessage, {link} = <website_url>#cw_redirect=<token>&cw_open=1
   │  • records redirectSentAt/redirectCount (one-shot + cooldown)
   ▼
Lead clicks → customer site (website_url) → patched widget SDK reads #cw_redirect
   │  • POST /api/v1/widget/redirect_token — resolved SERVER-SIDE (single-use, burns the token):
   │      – identifies the contact (hmac_verified) → MERGE onto the WhatsApp contact
   │      – FIRST time: creates the widget conversation + injects the cloned message (agent answers it)
   │      – RE-ENTRY: resumes the contact's existing conversation, injects NOTHING
   │  • widget opens on the thread
   ▼
AI serves the conversation in the widget (no per-message cost). Re-entries always resume the same thread.
```

Key module files: `src/modules/channel-redirect/` (`service.ts` config reader, `gate.ts` the runtime
gate, `link.ts` the token link, `followup.ts` the cross-channel follow-up, `cross-link.ts` the on-merge
conversation link). The gate is called from
`src/modules/chatwoot/webhook.ts` (a sibling of the test-mode / availability gates). `runAgentNudge`
(`src/graph/nudge.ts`) is the proactive-send engine reused by the follow-up.

### Token, expiry and resends

- The link carries **only** a short single-use token in the URL **fragment** (`#cw_redirect=…`): no
  identity, no PII, no hmac. A fragment never reaches the site's server or the `Referer` header.
- The token is stored in Chatwoot's Redis with a fixed **24h TTL** (`REDIRECT_LINK_TTL_SECONDS`),
  **decoupled** from the resend cooldown: a lead often opens the WhatsApp link hours after receiving it,
  so the link's life must not shrink with a short cooldown. If a lead does hold a genuinely expired link,
  the resolve endpoint returns `404 invalid_token` and the widget falls back to a normal (anonymous /
  cookie) session — no merge, no cloned message — so re-messaging WhatsApp (or the WhatsApp follow-up)
  re-sends a fresh link (up to `maxResends`).
- Merge is by **identifier** (`fzwa:<chatwootContactId>`): the gate stamps it on the WhatsApp contact
  before minting, and the resolve endpoint marks the widget contact_inbox `hmac_verified`. That
  `hmac_verified` flag is what makes Chatwoot resume the contact's conversation across sessions/devices
  (`Api::V1::Widget::BaseController#conversations` → `conversations.last`), so re-entry never forks a new
  conversation.
- **The identifier is settled per contact, and then kept.** Before minting, the gate reads what the
  WhatsApp contact carries. If it is already `fzwa:<X>` (or a moved value, below) it is kept as is and
  nothing is written: a live token was minted for it, and links outlive the resend cooldown by design
  (24h), so re-deriving a value on each delivery would detach the one issued minutes ago.
- **A held identifier is answered by taking a different one.** `identifier` is unique per Chatwoot
  account, so if any other contact holds `fzwa:<X>` the stamp is refused with
  `422 Identifier has already been taken`, and with a fixed value every later redirect for that lead
  fails the same way, permanently and in silence. The gate stamps `fzwa:<X>:<8 random hex>` instead and
  mints the token for **that** value. The old one is abandoned where it sits: whoever holds it keeps
  it, inert, because this side never asks for it again.
  - A contact that moved keeps its value **even if the base later becomes free**, for the same reason
    it is kept at all: a token is out there carrying it.
  - Unification still happens through the normal path: the widget identifies with whatever the token
    carries, and Chatwoot merges that contact onto whoever holds it, which is the WhatsApp contact.
  - Squatting stops working, because an identifier that does not exist until it is minted cannot be
    claimed in advance.
  - The read-then-write is serialized per contact (process-local), so two deliveries arriving together
    cannot mint two different suffixes and leave one of the links pointing at a value the contact no
    longer holds.
  - Nothing about the other contact is read, trusted or written. That is deliberate: this API has no
    way to answer "who holds exactly this identifier" (`/contacts/search` matches a substring across
    four fields, 15 rows a page; `/contacts/filter` is exact but case-insensitive, paged the same way,
    and its base narrows to `contact_type: 'lead'` once `crm_v2` is on) and no conditional write, so
    any repair aimed at the holder rests on an answer that can be wrong or stale.

### Cross-conversation link (on merge)

The two conversations of one redirected contact (WhatsApp entry + website chat) are linked the first
time the widget conversation receives an inbound after the merge (`cross-link.ts`, watermarked by
`Conversation.redirectLinkedAt` so it runs exactly once). Wired in the webhook BEFORE the test-mode
gate, it:

- **Propagates test-mode activation** from the WhatsApp sibling: a `/teste` given on the WhatsApp side
  carries over to the widget conversation, so an operator testing the flow does not re-activate in the
  chat. Only in test mode; production is unaffected.
- **Posts cross-link private notes** on both sides (operator-only), each pointing at the other
  conversation's dashboard deep link (`<base>/app/accounts/<acct>/conversations/<display_id>`), so
  whoever picks up either channel sees the continuous history. Best-effort; the watermark is set
  regardless, so a transient failure never re-spams.

## Manual setup (once per instance)

### 1. Chatwoot — create the website-chat (web widget) inbox

1. **Inboxes → Add Inbox → Website.** Set the **Website URL** to the exact page where the widget is
   embedded (this is where the redirect link lands — it must be a real, reachable page).
2. Recommended: enable **HMAC** (`hmac_mandatory`) on the inbox for defence in depth. The token resolve
   does not depend on it, but it blocks other unauthenticated identify attempts.
3. **Remove the "We are away" state.** The widget shows *"We are away at the moment"* whenever no human
   agent is online (a bot inbox has none). Enable **Business Hours** on the inbox and mark it open (24/7,
   or your real schedule): `isAvailable = isOnline || (workingHoursEnabled && isInWorkingHours)`, so 24/7
   hours make it always available and the away banner disappears.
4. Embed the widget's script snippet on the customer's site (Chatwoot gives it under the inbox's
   *Configuration → Installation*). The site must run the **patched SDK** (the fazer.ai Chatwoot fork:
   the widget reads `#cw_redirect` and resolves it) — the stock Chatwoot SDK ignores the token.

### 2. Chatwoot — the WhatsApp entry inbox

Use the existing **official WhatsApp Cloud API** inbox (`Channel::Whatsapp`, provider `whatsapp_cloud`).
Bind it to the agent under the agent editor's **Channels** tab (the persona bot must answer it so the
webhook reaches the gate).

### 3. fazer.ai agents — sync + configure the agent

1. Under **Channels**, sync the instance's inboxes so both inboxes appear.
2. Open the agent → **Redirect** tab → enable it, then:
   - **Entry (WhatsApp):** pick the official WhatsApp inbox (the paid one).
   - **Website chat:** pick the web-widget inbox you created in step 1.
   - **Redirect message:** the fixed WhatsApp auto-reply; it **must** contain `{link}` (the per-lead link
     is interpolated there).
   - **Resend interval / max resends:** a value + unit picker (the re-send cooldown only; the link itself has a fixed 24h TTL).
   - **Follow-up:** the cross-channel chase (chat → WhatsApp → closing), on by default with a short
     cadence (15 min in the chat, 60 min on WhatsApp) and a value + unit picker per stage.

The redirect only fires for the selected entry inbox, and only if the feature is enabled. While it is
enabled, the **generic inactivity follow-up** (`agent.settings.followUp`) is suppressed for both the entry
and widget inboxes — the redirect owns the re-engagement for those conversations, so the two never
double up (enforced in the followups sweep + handler).

That suppression is surfaced to the operator, so the follow-up config never reads as active where it does
not run: the agent editor's Behavior tab shows a callout in the Follow-up section when Redirect is on (the
config stays editable, since it still applies to the agent's *other* inboxes), and a redirect-managed
conversation's detail (`getConversationDetail` → `followUp.managedByRedirect`) replaces the never-firing
generic estimate with a redirect indicator: the pending `REDIRECT_FOLLOWUP` on the widget side
(`followUp.redirectNext = { stage, runAt }`), or a "handled by Redirect" note on the entry side.

## Transports

`agent.settings.channelRedirect` is an opaque settings block: REST v1 (`PUT /agents/:id`) and MCP
(`agent_settings_set`) accept it as-is; the editor's Redirect tab is the primary UI. The config reader
(`readChannelRedirectConfig`) is the single source of defaults + clamping.

## Chatwoot fork side

The widget patch and the two endpoints live in the fazer.ai Chatwoot fork (not this repo):

- `POST /api/v1/accounts/:id/redirect_tokens` (admin) — mints the token, returns `{ token, expires_in,
  website_url }`.
- `POST /api/v1/widget/redirect_token` (widget) — resolves + burns the token, does the identify + merge +
  resume-or-create, injects the cloned message only on create.
- Widget SDK reads `#cw_redirect` from the fragment, strips it from the URL, and asks the widget to
  resolve it on load.

## Caveats

- The **WhatsApp entry inbox is not hard-checked** to be `whatsapp_cloud` at runtime — the gate keys only
  on the selected inbox id + `enabled`. The editor warns when the selected entry channel has no
  per-message cost (redirecting it saves nothing).
- If the widget inbox has **no Website URL** set in Chatwoot, the gate cannot build the link and falls
  through (`misconfigured` → the lead is served on WhatsApp as a fallback rather than dead-ended).
- The `Inbox.webWidget` column and `writeWebWidgetBlob` are legacy from the removed provisioning path and
  are no longer read; `website_url` now comes back from the mint call.
