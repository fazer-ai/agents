# Hide Group Conversations From Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide WhatsApp group conversations from the web conversations page while preserving the default list behavior used by MCP and other consumers.

**Architecture:** Normalize the provider-specific `@g.us` signal into a durable `Conversation.isGroup` field at the Chatwoot mirror boundary. Add an opt-in `excludeGroups` filter to the shared list service and REST query, then have only `ConversationsPage` send that option so pagination and realtime refetches remain consistent.

**Tech Stack:** Bun, TypeScript, Elysia/Eden, React, Prisma 7, PostgreSQL, Bun Test, Testing Library.

## Global Constraints

- Group detection uses only contact phone or identifier values ending in `@g.us`, case-insensitively.
- The shared service defaults to including groups; MCP behavior must not change.
- Filtering happens in the database before ordering, cursor and limit.
- Partial webhook events must not clear a previously persisted group marker.
- RLS and `runScopedOn` remain unchanged.
- Keep network and external I/O outside scoped transactions.
- Run focused red/green tests and finish with `bun check`; record the existing baseline `TS2589` separately if it remains.

---

### Task 1: Classify and persist WhatsApp group conversations

**Files:**
- Modify: `src/modules/chatwoot/normalize.ts`
- Modify: `src/modules/chatwoot/mirror.ts`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260814000000_mark_group_conversations/migration.sql`
- Modify: `tests/modules/chatwoot-webhook.test.ts`
- Modify: `tests/modules/chatwoot-receiver.test.ts`
- Modify: `docs/chatwoot.md`

**Interfaces:**
- Produces: `isWhatsappGroupContact(contact: NormalizedChatwootContact | null | undefined): boolean | null`.
- Produces: `Conversation.isGroup: boolean`, mapped to `conversations.is_group`.
- Consumes: `NormalizedChatwootEvent.contact.phone` and `.identifier`.

- [ ] **Step 1: Write the failing classifier tests**

Add table-driven assertions to `tests/modules/chatwoot-webhook.test.ts`:

```ts
test.each([
  [{ phone: "120363000000@g.us", identifier: null }, true],
  [{ phone: null, identifier: "120363000000@G.US" }, true],
  [{ phone: "+5511999999999", identifier: null }, false],
  [null, null],
] as const)("classifies WhatsApp group contacts", (contact, expected) => {
  expect(isWhatsappGroupContact(contact && {
    id: 1,
    name: "Contact",
    email: null,
    ...contact,
  })).toBe(expected);
});
```

- [ ] **Step 2: Run the classifier test and verify RED**

Run: `bun test tests/modules/chatwoot-webhook.test.ts`

Expected: FAIL because `isWhatsappGroupContact` is not exported.

- [ ] **Step 3: Implement the minimal pure classifier**

In `normalize.ts`, return `null` when no contact metadata exists and otherwise check both fields with `value?.toLowerCase().endsWith("@g.us")`.

- [ ] **Step 4: Run the classifier test and verify GREEN**

Run: `bun test tests/modules/chatwoot-webhook.test.ts`

Expected: PASS.

- [ ] **Step 5: Write the failing mirror persistence test**

Extend `chatwoot mirror sync` to create a conversation with a group contact, assert `isGroup === true`, send a later event with `contact: null`, and assert the marker remains true.

- [ ] **Step 6: Add schema, migration and mirror writes**

Add to `Conversation`:

```prisma
isGroup Boolean @default(false) @map("is_group")
```

The migration must add the non-null defaulted column and backfill rows joined to `contacts` when `lower(phone)` or `lower(attributes->>'identifier')` ends in `@g.us`.

On create, persist `isWhatsappGroupContact(n.contact) ?? false`. On update, include `isGroup` only when classification is non-null.

- [ ] **Step 7: Generate Prisma and verify mirror GREEN**

Run: `bun run prisma:generate`

Run: `bun test tests/modules/chatwoot-receiver.test.ts`

Expected: PASS when the integration database is configured; otherwise the existing DB suite reports skipped while the classifier remains the executable guard.

- [ ] **Step 8: Document and commit Task 1**

Update `docs/chatwoot.md` to name `Conversation.isGroup` as mirrored metadata and the `@g.us` source. Commit only Task 1 files.

---

### Task 2: Add the opt-in database and REST filter

**Files:**
- Modify: `src/modules/conversations/service.ts`
- Modify: `src/api/v1/v1.controller.ts`
- Create: `tests/modules/conversation-list-filter.test.ts`
- Modify: `tests/modules/conversations.test.ts`
- Modify: `openapi.json`
- Modify: `docs/ui.md`

**Interfaces:**
- Consumes: `Conversation.isGroup` from Task 1.
- Produces: `ListConversationsFilter.excludeGroups?: boolean`.
- Produces: optional REST query parameter `excludeGroups: boolean`.

- [ ] **Step 1: Write the failing list behavior tests**

Create a no-database unit test with a transaction-capable fake that captures the `where` passed to `conversation.findMany`, returns no rows, and supports `$executeRaw`, `$extends` and `$transaction`. Assert the default call captures `{}` and the web projection captures `{ isGroup: false }`:

```ts
await listConversations(ctx, { excludeGroups: true }, fakeBase);
expect(capturedWhere).toEqual({ isGroup: false });
```

Also add a group conversation to the existing integration fixture. Assert the default call includes it, then assert:

```ts
const web = await listConversations(
  ctx(tenantA),
  { excludeGroups: true },
  appDb,
);
expect(web.items.some((item) => item.chatwootConversationId === GROUP_ID)).toBe(false);
```

Also request `limit: 1` with the newest record marked as a group and assert the returned page still contains one individual conversation, proving filtering precedes pagination.

- [ ] **Step 2: Run the conversation tests and verify RED**

Run: `bun test tests/modules/conversation-list-filter.test.ts`

Expected: FAIL because the captured query does not contain `isGroup: false`.

- [ ] **Step 3: Implement the service filter**

Add `excludeGroups?: boolean` and initialize the query where clause with:

```ts
const where: Prisma.ConversationWhereInput = excludeGroups
  ? { isGroup: false }
  : {};
```

Thread the option into `buildConversationsWhere` before `findMany` so status/search compose with it.

- [ ] **Step 4: Expose the REST option without changing defaults**

Add `excludeGroups: t.Optional(t.Boolean(...))` to the route schema and pass `query.excludeGroups` to `listConversations`. Update the endpoint description to state that the option is intended for projections that hide non-actionable group traffic.

- [ ] **Step 5: Verify GREEN and regenerate OpenAPI**

Run: `bun test tests/modules/conversation-list-filter.test.ts tests/modules/conversations.test.ts`

Run: `bun run openapi:generate`

Expected: focused test PASS or existing DB skips, and `openapi.json` contains the optional boolean query parameter.

- [ ] **Step 6: Document and commit Task 2**

Update `docs/ui.md` to state that the web projection opts out of groups while MCP remains complete. Commit only Task 2 files.

---

### Task 3: Make only the web page request group exclusion

**Files:**
- Modify: `src/client/pages/ConversationsPage.tsx`
- Create: `tests/client/pages/ConversationsPage.test.tsx`

**Interfaces:**
- Consumes: REST query `excludeGroups: boolean` from Task 2.
- Produces: all web list requests send `{ excludeGroups: true }`.

- [ ] **Step 1: Write the failing initial-load client test**

Mock only the API boundary and realtime hook, render the real `ConversationsPage` in a `MemoryRouter`, wait for the request, and assert the first request query contains the literal `excludeGroups: true`.

- [ ] **Step 2: Run the client test and verify RED**

Run: `bun test tests/client/pages/ConversationsPage.test.tsx`

Expected: FAIL because the initial request omits `excludeGroups`.

- [ ] **Step 3: Add the option to initial load**

Set `excludeGroups: true` in the query object in `fetchConversations`.

- [ ] **Step 4: Run the client test and verify GREEN**

Run: `bun test tests/client/pages/ConversationsPage.test.tsx`

Expected: PASS.

- [ ] **Step 5: Write the failing pagination test**

Return one item plus `nextCursor` from the first mocked request, click `Load more`, and assert the second request contains both `cursor` and `excludeGroups: true`.

- [ ] **Step 6: Add the option to pagination and verify GREEN**

Set `excludeGroups: true` in the `loadMore` query object.

Run: `bun test tests/client/pages/ConversationsPage.test.tsx`

Expected: PASS.

- [ ] **Step 7: Run focused regression tests and full verification**

Run: `bun test tests/modules/chatwoot-webhook.test.ts tests/modules/chatwoot-receiver.test.ts tests/modules/conversations.test.ts tests/client/pages/ConversationsPage.test.tsx`

Run: `bun check`

Compare any full-check failure against the baseline `TS2589`; no new failure is acceptable.

- [ ] **Step 8: Review the complete diff and commit Task 3**

Verify the default MCP call in `src/modules/mcp/server.ts` does not pass `excludeGroups`. Commit the page and its test, then request code review against `origin/main` before push and PR creation.
