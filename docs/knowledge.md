# Knowledge suggestions: the approval queue and its reviewer

An agent with the `suggest_kb_entry` tool (in a conversation, an observer tick or the playground) proposes entries for a knowledge base. Nothing enters a base without a person approving it in the approval queue (`approval_queue_items`). This doc covers what happens between the proposal and the person: the duplicate floor, the suggestion reviewer, and what approving, rejecting and requeueing do.

Code: `src/modules/rag/service.ts` (create, list, approve, reject, requeue), `src/modules/rag/suggestion-review.ts` (the reviewer job), `src/modules/rag/review-settings.ts` (the per-agent override). Transports: REST `src/api/v1/knowledge.controller.ts`, MCP `knowledge_approvals_list` / `knowledge_approve` / `knowledge_reject` / `knowledge_requeue`, UI `src/client/pages/resources/KnowledgeApprovals.tsx`.

## Statuses

| status | visible to a person | how it gets there |
| --- | --- | --- |
| `SCREENING` | no | a proposal that carries an agent, while its review job runs |
| `PENDING` | pending list | REST proposal; reviewer said `new` or `replace`; any review failure; requeue |
| `EDITED` | pending list | a person rewrote the text |
| `DISCARDED` | Discarded tab | reviewer said `duplicate` |
| `APPROVED` / `REJECTED` | no (audit) | a person decided |

## The floor: a normalized hash, before any model

`normalizedSuggestionHash` applies NFC and lowercases, turns ordinary punctuation into spaces, collapses whitespace, trims, and hashes. What can change a number is kept: a sign (`-`, `−`) before a digit, `.` or `,` between digits, `%` or `‰` after a digit, and every Unicode symbol (`°`, `$`, `±`, `<`), so "-10 °C" and "+10 °C" are two entries while "Prazo: 7 dias." and "prazo 7 dias" are one. Accents are kept: they change meaning in Portuguese. The unique key is `(tenant_id, knowledge_base_id, normalized_hash)`, across conversations and against an item in **any** status, so a text a person already rejected is not queued again, and a rewording that only changes punctuation or case lands on the existing row.

A floor hit creates nothing and calls no model. The tool tells the model the entry is already with a human, so it stops proposing it. The insert is `createManyAndReturn` with `skipDuplicates` followed by a lookup on the key: catching `P2002` inside a scoped transaction would abort the transaction.

## The reviewer

A proposal from an agent enters `SCREENING`, and a `SUGGESTION_REVIEW` job is armed in the same transaction (deduped by item id). The job:

1. embeds the proposal with the base's embedding model and stores the vector on the item;
2. gathers candidates: the closest chunks of the base, grouped to at most 5 documents, and the 5 closest items of the same base in `PENDING`, `EDITED` or `REJECTED` (with the rejection reason when one was given);
3. with no candidate, moves the item to `PENDING` with a fixed comment and calls no model;
4. otherwise checks the spend ceiling and asks the model for one JSON verdict: `new`, `duplicate` (naming the matched item or document) or `replace` (naming the document).

`duplicate` goes to `DISCARDED` with the match recorded; `new` and `replace` go to `PENDING` with the reviewer's comment, and `replace` also records `replacesDocumentId`. A replace naming a synced document (one with an `externalId`) or a document outside the candidates is downgraded to `new`; a duplicate naming nothing valid is treated as a failure. Every move is an `updateMany` guarded on `status = SCREENING`, so a review that lands after a person acted changes nothing.

**Every failure releases the item to `PENDING` with no comment**: no agent, unreadable agent config, override not runnable or missing its key, model or embedding error, unreadable verdict, spend ceiling over, and the job's dead letter. Losing a suggestion is worse than a person seeing a duplicate.

The prompt tells the model that a repeat of a rejected item is a duplicate only when it repeats what was refused, so a corrected fact after a "wrong number" rejection still reaches a person.

Items written before the reviewer existed have no embedding and are never candidates. There is no backfill.

### Which model

The agent's own model by default. The agent editor's Knowledge tab ("Suggestion reviewer") sets an override with the same shape as the memory compaction override: provider, model, credential, base URL, stored at `settings.knowledge.suggestionReview`. A broken override is a config-health issue (`suggestionReviewModel`), and the review releases instead of running on it.

The call is the billed ledger node `suggestion_review`, gated by the spend ceiling (`inbox` source, or `playground` for a playground thread) and not counted as an agent turn.

## REST proposals skip the reviewer

`POST /v1/knowledge/suggestions` (no agent behind it) gets the floor only and lands in `PENDING`. A person or an integration posting there already decided to propose it.

## What a person can do

- **Approve.** When the item carries `replacesDocumentId`, approving updates that document in place (`updateDocument`, reindexed). If the document is gone, moved to another base or became synced, the call returns `replace-unavailable` without claiming the item. The listing reports this as `replaceUnavailable`, the screen then offers only "Approve as a new document", and the MCP `knowledge_approve` refuses in both preview and apply until `as_new` is passed. `asNew` (REST `{asNew: true}`, MCP `as_new`) skips the replacement and creates a new document.
- **Reject**, with an optional reason (at most 1000 characters). The reason is stored on the item and shown to the reviewer for later proposals; it is never written to the audit row.
- **Requeue** a discarded item: `DISCARDED` to `PENDING`, no audit row.
