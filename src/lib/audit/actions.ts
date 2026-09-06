// Every action name the code can write, for the console's action filter.
//
// It lives HERE, beside `markers.ts` and for the same reason: a module that imports nothing, so the
// browser bundle can read it without dragging a `src/modules` file across the boundary
// `tests/client/bundle-boundary.test.ts` guards.
//
// WHY A CONSTANT AND NOT `SELECT DISTINCT action`. The distinct query answers a better question —
// what this deployment has actually recorded — and pays for it with a scan: `audit_logs` only grows,
// its only index leads with `tenant_id, created_at`, and nothing leads with `action`. The filter
// would get slower exactly on the trails long enough to need filtering. A constant costs nothing and
// is wrong only in one direction, which the filter answers on its own: the combo box accepts free
// text, so a name this list does not carry is still reachable by typing it.
//
// WHAT KEEPS THE LIST HONEST IS THE TYPE, not the sweep. `AuditEntry.action` is `AuditAction` rather
// than `string`, so an action absent from here does not compile — the same argument the file already
// makes one field over for `actorType`. That matters because the sweep in
// `tests/modules/audit-actions.test.ts` reads what is written after `action:`, and an action reaches
// `recordAudit` by other roads: a ternary picking between two names (`company_logo.*`), and a local
// helper taking the name as an argument (`auditConsentDecision`, which the first version of that
// sweep missed entirely, leaving two live actions off the picker). A regex can be taught each shape
// after it is found; the type has no shapes.
//
// The sweep still earns its place on the OTHER direction, which no type can check: an entry here
// whose producer was deleted is a value the operator can pick that will never match a row.
export const AUDIT_ACTIONS = [
  "agent.clone",
  "agent.create",
  "agent.delete",
  "agent.import",
  "agent.prompt_set",
  "agent.settings_set",
  "agent.tools_set",
  "agent.update",
  "alert_channel.create",
  "alert_channel.delete",
  "alert_channel.update",
  "api_key.create",
  "api_key.revoke",
  "business_hours.create",
  "business_hours.delete",
  "business_hours.update",
  "code_tool.create",
  "code_tool.delete",
  "code_tool.update",
  "conversation.handoff",
  "conversation.reengage",
  "conversation.reply",
  "conversation.reset",
  "conversation.return",
  // Written by a ternary rather than a literal (`logoKey === null ? … : …`), which is the shape
  // the first version of the sweep could not see.
  "company_logo.clear",
  "company_logo.set",
  "conversation.status",
  "credential.create",
  "credential.delete",
  "credential.update",
  "deployment.connect",
  "deployment.disconnect",
  "deployment.rotate_token",
  "deployment.set_accounts",
  "document_template.create",
  "document_template.delete",
  "document_template.update",
  "experiment.create",
  "experiment.delete",
  "experiment.update",
  "inbox.bind",
  "inbox.reconnect",
  "inbox.remove",
  "instance.connect",
  "instance.disconnect",
  "instance.reconnect",
  "instance.remove",
  "instance.sync_inboxes",
  "integration.create",
  "integration.delete",
  "integration.rotate_token",
  "integration.update",
  "invitation.create",
  "invitation.revoke",
  "knowledge_document.create",
  "knowledge_document.delete",
  "knowledge_document.retry",
  "knowledge_document.update",
  "knowledge.approve",
  "knowledge.create",
  "knowledge.delete",
  "knowledge.edit",
  "knowledge.reindex",
  "knowledge.reject",
  "knowledge.update",
  "langfuse.connect",
  "mcp_approval.revoke",
  "mcp_client.create",
  "mcp_client.delete",
  "mcp_client.disconnect",
  "mcp_client.update",
  "mcp_connection.create",
  "mcp_connection.delete",
  "mcp_connection.update",
  "mcp_oauth_consent.deny",
  "mcp_oauth_consent.grant",
  // THE TWO OLD SPELLINGS, AND EVERY ROW RECORDED SO FAR IS UNDER THEM. Nothing in this release
  // writes them any more — the two above replaced them — and no row has moved, which is the whole
  // shape of this release rather than an omission.
  //
  // The rename and the backfill cannot ship together, and the reason is the deploy rather than the
  // code. The rollout overlaps: the incoming container runs `prisma migrate deploy` while the
  // outgoing one is still serving, and that one's catalog is FROZEN with only these two names. Move
  // the rows in the same release and its picker offers two values that now match nothing, so the
  // consent family reads as empty on the old container for the length of the upgrade — and
  // indefinitely after a rollback, which is a thing operators do when a release misbehaves.
  //
  // So this release only teaches every reader both spellings, and the backfill is the next one,
  // where the oldest live catalog already has all four. Both of these leave with it.
  "mcp_oauth_consent_denied",
  "mcp_oauth_consent_granted",
  "mcp_token.revoke",
  "tenant_settings.company_set",
  "tenant_settings.embedding_set",
  "tenant_settings.langfuse_set",
  "tenant_settings.spend_ceiling_set",
  "tool.create",
  "tool.delete",
  "tool.update",
  "user.delete",
  "user.role_set",
  "webhook_delivery.requeue",
  "webhook.create",
  "webhook.delete",
  "webhook.update",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// The actions whose rows belong to NO TENANT, and therefore never appear on a tenant's trail.
//
// `tenant_id` answers to the record that changed, not to the principal that changed it, and these
// families change something the whole deployment shares. The RLS policy on `audit_logs` is
// `tenant_id = current_setting('app.tenant_id')`, and `NULL` satisfies no comparison, so the rows
// are not filtered out of the tenant read — they are unreachable through it.
//
// The picker still offers them, because the picker is the write vocabulary and hiding a family is
// how an operator concludes it does not exist. What must not happen is the page answering an empty
// list to a question it cannot ask: "no MCP client was ever created" and "this trail is not where
// that is recorded" are different sentences, and only one of them is true. A fleet READ is #520.
//
// A member here writes `null` as the tenant, always — not sometimes. `api_key.*` and
// `mcp_oauth_consent.*` are deliberately absent: they write `null` for a fleet-scoped key or a
// fleet-scoped consent and the tenant's id otherwise, so on a tenant trail they can and do match.
export const FLEET_LEVEL_ACTIONS: readonly AuditAction[] = [
  "mcp_approval.revoke",
  "mcp_client.create",
  "mcp_client.delete",
  "mcp_client.update",
  "mcp_token.revoke",
];

export function isFleetLevelAction(action: string): boolean {
  return (FLEET_LEVEL_ACTIONS as readonly string[]).includes(action);
}
