# Snoozed follow-up (a person waiting on the customer)

The ordinary follow-up (`followUp`) chases a customer who went quiet on the BOT: it only acts on a conversation the bot holds (`pending`, no person assigned). Nothing chased the other half: a person on the team asks the customer for something (an order number, a document), snoozes the conversation in Chatwoot "until next reply", and the customer never answers. Chatwoot only unsnoozes on an incoming message, so the conversation sits snoozed forever and nobody reminds the customer or closes it. `snoozedFollowUp` (issue #1184) is that ladder: a reminder on the person's behalf, then another, then a close.

Off by default, configured per agent through MCP `agent_settings_set` or REST. There is no console section yet.

## Configuration (`settings.snoozedFollowUp`)

```json
{
  "enabled": true,
  "signature": false,
  "cadences": [
    { "label": null, "steps": [
      { "delayValue": 24, "delayUnit": "hours", "instructions": "..." },
      { "delayValue": 24, "delayUnit": "hours", "instructions": "..." },
      { "delayValue": 24, "delayUnit": "hours", "resolve": true, "assignLabels": ["sem-retorno"] }
    ] },
    { "label": "adiar-rapido", "steps": [ ... ] },
    { "label": "adiar-lento", "steps": [ ... ] }
  ]
}
```

- **Steps** are the `followUp.steps` shape, read by the same reader (`readFollowUpStep`), so a step means the same thing in both ladders: delay, instructions, `assignLabels`, and `resolve` honored on the last step only. A step with no instructions that labels or resolves closes without a model call.
- **Cadences** pick the pace per conversation: the first cadence, in list order, whose `label` the conversation carries; otherwise the one with `label: null`; with neither, the conversation is not chased. Labels compare ignoring case. The intended use is a Chatwoot macro that snoozes and adds the label in one click ("Snooze, fast" / "Snooze, slow"). Up to 10 cadences, one per label (a duplicate could never be picked and is dropped), and a cadence with no steps is dropped.
- **Signature** is off by default: the reminder speaks for the person who asked, so the bot's sign-off is usually wrong there.

## What is chased

A conversation is this ladder's only while all of these hold, checked LIVE against Chatwoot (the mirror has no snooze end date):

- status `snoozed` with **no end date** (`snoozed_until` null). A snooze until a date is the person saying when they will look again.
- assigned to a **person** (`assignee_type` `User`). The bot's own conversations belong to `followUp`.
- the newest public message from a person (the **anchor**) has no customer message after it. A message the platform posted under an admin token (`platformSent`, such as a cross-inbox case opening) is a user row no person wrote, and is neither an anchor nor a person answering.
- the anchor is newer than the moment the ladder was switched on for the agent (`agents.snoozed_follow_up_armed_at`, stamped on the off-to-on transition, on create and on promotion to production). Turning the ladder on does not remind the whole snoozed backlog at once.

Step 1 is due `delay` after the anchor (not after the snooze, which can come later); each later step is due `delay` after the previous one ran. A new message from the person is a new anchor and starts the ladder over at step 1. The customer answering unsnoozes the conversation in Chatwoot, and the ladder ends there. Business hours (`followUpHoursId`, else `businessHoursId`) hold a due step to the next opening, as in `followUp`.

## How it runs

- **Sweep** (`sweepSnoozedFollowUps`, `src/modules/followups/snoozed.ts`), inside the per-tenant `FOLLOWUP_SWEEP` pass: nominates snoozed, person-held conversations on an inbox of an agent with the ladder on and armed (monitoring agents never; test agents only in `/teste`-activated conversations), arming one `SNOOZED_FOLLOWUP` job per conversation (`snoozed-followup:<thread>`). A job is left alone unless the conversation had an event after its last run STARTED (`claimed_at`, else the arming): the run reads Chatwoot after its claim, so an event during a run that then completed is one no run has seen. A claimed one is never touched.
- **Handler** (`snoozedFollowUpHandler`): reads the conversation and up to 3 message pages with the admin token, decides the anchor, the cadence and the step, reschedules until due, then calls `runAgentNudge` with `holder: "snoozed-human"`.
- **State** per conversation: `snoozed_follow_up_anchor_id`, `snoozed_follow_up_step`, `snoozed_follow_up_at`. The ladder's position is "step N spent on anchor M"; a different anchor resets it.

## The snoozed holder in `runAgentNudge`

The nudge was built around "the bot owns the conversation". Under `holder: "snoozed-human"`:

- the live ownership probe asks `isSnoozedForAPerson` instead of `shouldBotHandle`, before the model and again before the send, and the mirror check asks status and holder the same way. Without `requireLiveBotOwnership` the holder is refused as a caller error, because the mirror cannot see the end date.
- **no tools are bound.** The reminder is one message on a person's behalf; every tool would act over that person (transfer, close, labels, a case in another inbox). Silence stays possible through the follow-up's own token.
- every `stillWanted` ask, strict or not, reads the messages after the newest one the handler saw: a person or the customer writing while the model ran stops the reminder and the post-actions. An unreadable answer is a no.
- no hand-back note is written to the thread: a reminder over a person's snooze is not the conversation coming back to the bot.
- an output guardrail that would **hand over** drops the reminder instead (no transfer, no hand-over line: the conversation is the person's) and the step ends as a silent one.
- the conversation is left as it was: still snoozed, still the person's. Only the last step's `resolve` and labels change it.

## Not covered

- No console UI for the block.
- The anchor search reads 3 pages of messages; a person's message older than that is not found and the conversation is not chased.
- A snooze by a person on a conversation whose inbox has no agent is not chased: the ladder needs an agent's model and settings.
