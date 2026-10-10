# Proactive breaker

An account-wide limit on proactive messages per rolling 24 hours. The per-conversation limit (`docs/graph.md`, "Proactive limit") stops a loop that concentrates on one contact; this one stops a bug that sends one message each to a very large number of contacts, repeatedly (a follow-up re-armed for every conversation, an integration replaying a whole contact list). Every WhatsApp message is billed by Meta, and such a bug left running over a weekend is the expensive case.

## What counts and where it is asked

- **What counts** is every proactive row of `agent_turn_deliveries` of the tenant, pending reservations included: every `runAgentNudge` caller (follow-ups, appointment reminders, inbound events, the templates they send) and the redirect ladder's fixed sends (`sendWithinProactiveLimit`). Reactive replies are never counted and never stopped, so a real demand spike cannot take service down.
- **Where**: `reserveProactiveSend` (`src/modules/proactive-limit/service.ts`) asks the breaker first, under an advisory lock on the tenant (`proactive-breaker:<tenantId>`), then the conversation's own limit under the conversation's lock, and writes the send's reservation inside both. The lock is what makes the count include every send ahead of it, so sends arriving together never pass the limit. It runs on every proactive send that has a mirrored conversation, whether or not the agent sets a per-conversation limit.
- **The decision is before the send**: the send that finds the count at the limit is refused and trips the breaker. It never goes out.

## The latch

A trip writes `proactive_breakers.tripped_at` with the count and the limit at that moment. While it is set every proactive send of the account is refused, and only a resume clears it: a rolling window that reopened on its own would let a steady bug keep sending all weekend. Changing the limit while tripped does not reopen it either; the card says so beside the Resume button. Turning the breaker off lets sends through at once and ends the trip as a resume would: an `off` breaker is never asked, so a latch left behind would keep the banner up for a guard that is not running.

A resume stamps `resumed_at`, and the count starts at the later of a day ago and the last resume. A resume is therefore a fresh allowance: an account resumed while its last 24 hours are still above the limit does not trip again on the next send. Resuming an open breaker changes nothing and writes no audit row.

## The limit

Configuration is the `proactiveBreaker` block of `tenant.settings` (`src/modules/proactive-breaker/settings.ts`): `mode` is `auto` (the default, also for a block that does not parse), `fixed` or `off`, and `limit` is the pinned number, kept while the mode is not `fixed` so switching back restores it. A fixed limit is a whole number from 1 to 10,000,000; anything else is a 422.

The automatic limit is 3x the account's largest 24h proactive volume of the last 30 days, never below 1,000. The volume is read from two records of the same sends, in a sliding 24h window starting at each row, and the larger peak wins (`computeAutoPeak`): the proactive rows of `agent_turn_deliveries`, which are exactly what the breaker counts (the redirect ladder's fixed link and goodbye included, which write no `generate` line) and which the retention sweep keeps 31 days while a reply's row goes after two; and the flow log's `generate` line for a nudge that reached the customer (`detail.outcome` `messaged` or `templated`, source `inbox`), written since before the delivery rows were, so no account starts below its own peak on upgrade. The second is bounded by the flow log's retention (`FLOWLOG_RETENTION_DAYS`, 30 by default). The peak and its window start are cached on the `proactive_breakers` row and refreshed at most daily, outside the send's lock, by the first send or status read after they go stale; a failed refresh keeps the last figure.

## What the operator sees

- **The trip** writes one `error` line at stage `proactive_breaker`, naming the count and the limit, so the alert channels deliver it, with a link to the card (`/resources/advanced?section=proactive-breaker`). Every refusal while tripped writes an `info` line saying what was not sent. The trip's line is written even when the occasion that tripped it was retired meanwhile, since it is about the account.
- **The banner** (`ProactiveBreakerBanner`, in `Layout`) shows on every console page while tripped, with Resume and Change limit for admins. Alert channels are opt-in, so the console cannot depend on them. The shell polls the status every minute and on focus.
- **The card** in Components > Advanced shows the mode, the limit in force and where an automatic one came from (3x the peak of a day, or the floor), the count toward it, and the trip with its Resume button.

## Transports

REST: `GET /v1/tenant-settings/proactive-breaker` (any member of the account, since the banner reads it), `PUT` the same path and `POST …/resume` (TENANT_ADMIN). MCP: `proactive_breaker_get`, `proactive_breaker_set` and `proactive_breaker_resume`, the writes dry-run by default. The writes are audited as `tenant_settings.proactive_breaker_set` and `proactive_breaker.resume`.
