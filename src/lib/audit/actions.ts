// Every action name the code can write, for the console's action filter (docs/ui.md "Audit"). It
// imports nothing, like `markers.ts`, so the browser bundle can read it across the boundary
// `tests/client/bundle-boundary.test.ts` guards. A constant rather than `SELECT DISTINCT action`,
// which would scan an ever-growing `audit_logs` with no index leading on `action`; a name missing
// here is still reachable by typing it in the combo box. The type keeps the list honest
// (`AuditEntry.action` is `AuditAction`), since a sweep of `action:` misses names passed through a
// ternary or a helper argument; `tests/modules/audit-actions.test.ts` checks the other direction,
// an entry whose producer was deleted.
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
  "conversation.reset",
  "conversation.return",
  // NOTE: written by a ternary rather than a literal (`logoKey === null ? … : …`), a shape a sweep
  // of `action:` literals cannot see.
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
  "inbox.observe",
  "inbox.reconnect",
  "inbox.remove",
  "inbox.unobserve",
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
  "knowledge_source.delete",
  "knowledge_source.set",
  "knowledge_source.sync",
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
  // NOTE: An image older than these names cannot offer them (its catalog is frozen in the image) and
  // still writes the old spelling; docs/deploy.md covers that upgrade window and its repair.
  "mcp_oauth_consent.deny",
  "mcp_oauth_consent.grant",
  "mcp_token.revoke",
  "merchant_lead.ingest",
  "merchant_order.create",
  "merchant_product.create",
  "merchant_product.delete",
  "merchant_product.update",
  "merchant_source.create",
  "merchant_source.delete",
  "merchant_source.run",
  "merchant_source.update",
  "outreach_account.create",
  "outreach_account.delete",
  "outreach_account.update",
  "outreach_job.approve",
  "outreach_job.cancel",
  "outreach_job.queue",
  "outreach_job.requeue",
  "outreach.sent",
  "tenant_settings.company_set",
  "tenant_settings.embedding_set",
  "tenant_settings.langfuse_set",
  "tenant_settings.price_overrides_set",
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

// Old spellings accepted as INPUT and redirected to the current name, so a saved filter link, script
// or export under the old name does not read as "no consent decision was ever recorded" while the
// rows sit one name over. Never in `AUDIT_ACTIONS`, never written, never on a returned row. A `Map`
// rather than an object literal because the key comes off a URL: `?action=toString` would find an
// inherited function, reach Prisma as the filter and answer a 500 instead of an empty result.
export const RENAMED_AUDIT_ACTIONS: ReadonlyMap<string, AuditAction> = new Map([
  ["mcp_oauth_consent_denied", "mcp_oauth_consent.deny"],
  ["mcp_oauth_consent_granted", "mcp_oauth_consent.grant"],
]);

export function canonicalAuditAction(action: string): string {
  return RENAMED_AUDIT_ACTIONS.get(action) ?? action;
}

// The actions whose rows ALWAYS belong to no tenant, so the RLS policy on `audit_logs` (`tenant_id =
// app.tenant_id`, which `NULL` never satisfies) makes them unreachable from a tenant's trail. The
// picker still offers them, and the page says the record belongs to no tenant rather than answering
// "no entries match". `api_key.*` and `mcp_oauth_consent.*` are absent on purpose: they write `null`
// only for a fleet-scoped key or consent, so on a tenant trail they do match.
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
