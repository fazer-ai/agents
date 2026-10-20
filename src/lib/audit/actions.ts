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
  // NOTE: the `*_by_upgrade` and `*_renamed_tool` names are written from SQL by migrations, and the
  // vocabulary test reads them there.
  "agent.disabled_by_upgrade",
  "agent.import",
  "agent.prompt_names_renamed_tool",
  "agent.prompt_set",
  "agent.settings_set",
  "agent.settings_text_renamed_tool",
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
  "client_app.create",
  "client_app.delete",
  "client_app.secret_revoke",
  "client_app.secret_rotate",
  "client_app.update",
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
  "document_approval.approve",
  "document_approval.reject",
  "document_approval.request_again",
  "document_template.create",
  "document_template.delete",
  "document_template.update",
  "experiment.create",
  "experiment.delete",
  "experiment.update",
  "inbox.bind",
  "inbox.bind_voice",
  "inbox.observe",
  "inbox.reconnect",
  "inbox.remove",
  "inbox.unobserve",
  "instance.connect",
  "instance.disconnect",
  "instance.reconnect",
  "instance.remove",
  "instance.sync_inboxes",
  "instance_alert_channel.create",
  "instance_alert_channel.delete",
  "instance_alert_channel.update",
  "instance_alert_threshold.reset",
  "instance_alert_threshold.set",
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
  "tenant_settings.approval_link_set",
  "tenant_settings.company_set",
  "tenant_settings.embedding_set",
  "tenant_settings.langfuse_set",
  "tenant_settings.price_overrides_set",
  "tenant_settings.spend_ceiling_set",
  "tenant_settings.proactive_breaker_set",
  // An admin reopening the proactive breaker after a trip.
  "proactive_breaker.resume",
  "tool.create",
  "tool.delete",
  "tool.renamed_by_upgrade",
  "tool.text_renamed_tool",
  "tool.update",
  "user.delete",
  "user.merged_by_upgrade",
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
  "instance_alert_channel.create",
  "instance_alert_channel.delete",
  "instance_alert_channel.update",
  "instance_alert_threshold.reset",
  "instance_alert_threshold.set",
  "mcp_approval.revoke",
  "mcp_client.create",
  "mcp_client.delete",
  "mcp_client.update",
  "mcp_token.revoke",
];

export function isFleetLevelAction(action: string): boolean {
  return (FLEET_LEVEL_ACTIONS as readonly string[]).includes(action);
}
