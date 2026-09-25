// WHICH REST ROUTE HAS A TWIN IN THE MCP, AND WHY THE REST DO NOT (issue #708).
//
// `PATCH /v1/knowledge/documents/:id` existed for months with no MCP tool, and nothing said so: a
// session that only saw the MCP concluded that editing a document meant deleting and recreating it,
// which loses the id and takes the document out of search while it re-embeds. The gap was not the
// difference between the two surfaces, which is expected; it was that the difference was invisible.
//
// So every route under `src/api/v1/*.controller.ts` is named here with one of three answers, and
// `tests/modules/mcp-route-coverage.test.ts` fails when a route is added without one, when an entry
// names a route that no longer exists, or when a `tool` names nothing the server registers:
//
//   - `tool`: the MCP tool that does the same job. Not always one-to-one (`metrics_get` answers two
//     routes), and the test checks that the tool exists, not that it is equivalent.
//   - `none`: the route has no business in the MCP, and the reason says why. Shared reasons are the
//     constants below, so a new route reuses one or writes its own.
//   - `gap`: it SHOULD have a tool and does not yet. Written down so the next person who needs it
//     finds the gap here instead of in a production session, and so CI charges only the delta.
//
// Keys are `METHOD /prefix/path` exactly as the controller spells them, prefix included.

type Coverage = { tool: string } | { none: string } | { gap: string };

const BINARY =
  "a binary body (file upload, PDF, image, audio); the MCP transport carries JSON";
const CONV_AGENTS =
  "options for the console's agent filter to non-admin users; agent_list has them";
const EMBEDDING_BLOCK =
  "knowledge_reindex reports the same block on its preview";
const EXPORT =
  "a file download of data a tool already reads (audit_list, tool_get)";
const FLEET =
  "SUPER_ADMIN lifecycle kept to the console: irreversible or credential-minting, several with step-up confirmation";
const INBOUND =
  "an inbound delivery from an external system, authenticated by its route token";
const MCP_ACCESS =
  "administers MCP access itself (clients, tokens, grants); a token does not govern its own door";
const META =
  "the instance identity, already on every answer as `instance`; whoami covers the principal";
const SECRET =
  "sets or mints a secret value, which is entered or shown once in the console";
const OAUTH =
  "a browser OAuth or consent step, driven by a redirect a person follows";
const PICKER = "options for a console picker, read live to fill a form field";
const PLAYGROUND =
  "playground session plumbing for the console chat; agent_playground is the MCP turn";
const TRANSPORT = "the MCP transport itself";

export const ROUTE_COVERAGE: Record<string, Coverage> = {
  "GET /v1/agents/": { tool: "agent_list" },
  "GET /v1/agents/:id": { tool: "agent_get" },
  "GET /v1/agents/:id/guardrails/health": {
    gap: "guardrails health of one agent",
  },
  "GET /v1/agents/:id/config-health": { tool: "agent_config_health" },
  "GET /v1/agents/:id/inboxes/out-of-office": {
    gap: "Chatwoot out-of-office replies on the agent's inboxes",
  },
  "POST /v1/agents/": { tool: "agent_create" },
  "PATCH /v1/agents/:id": { tool: "agent_update" },
  "DELETE /v1/agents/:id": { tool: "agent_delete" },
  "POST /v1/agents/:id/clone": { tool: "agent_clone" },
  "GET /v1/agents/:id/export": { tool: "agent_export" },
  "POST /v1/agents/import": { tool: "agent_import" },
  "GET /v1/agents/:id/tool-selections": { tool: "agent_tools_get" },
  "POST /v1/agents/:id/playground": { tool: "agent_playground" },
  "GET /v1/agents/:id/playground/tools": { none: PLAYGROUND },
  "POST /v1/agents/:id/playground/followup": { none: PLAYGROUND },
  "POST /v1/agents/:id/playground/audio/transcribe": { none: BINARY },
  "POST /v1/agents/:id/playground/audio": { none: BINARY },
  "POST /v1/agents/:id/playground/file/extract": { none: BINARY },
  "POST /v1/agents/:id/playground/file": { none: BINARY },
  "GET /v1/agents/:id/playground/media/:mediaId": { none: BINARY },
  "GET /v1/agents/:id/playground/sessions": { none: PLAYGROUND },
  "GET /v1/agents/:id/playground/sessions/:threadId": { none: PLAYGROUND },
  "GET /v1/agents/:id/playground/sessions/:threadId/usage": {
    none: PLAYGROUND,
  },
  "POST /v1/agents/:id/playground/threads": { none: PLAYGROUND },
  "DELETE /v1/agents/:id/playground/sessions/:threadId": { none: PLAYGROUND },
  "POST /v1/agents/models/list": { none: PICKER },
  "POST /v1/agents/tts/list": { none: PICKER },
  "PUT /v1/agents/:id/tool-selections": { tool: "agent_tools_set" },
  "GET /v1/alert-channels/stages": { tool: "alert_stage_list" },
  "GET /v1/alert-channels/": { tool: "alert_channel_list" },
  "POST /v1/alert-channels/": { tool: "alert_channel_create" },
  "PATCH /v1/alert-channels/:id": { tool: "alert_channel_update" },
  "DELETE /v1/alert-channels/:id": { tool: "alert_channel_delete" },
  "POST /v1/alert-channels/:id/test": { tool: "alert_channel_test" },
  "GET /v1/api-keys/": { tool: "api_key_list" },
  "POST /v1/api-keys/": { none: SECRET },
  "DELETE /v1/api-keys/:id": { tool: "api_key_revoke" },
  "GET /v1/api-keys/fleet": { none: FLEET },
  "POST /v1/api-keys/fleet": { none: FLEET },
  "DELETE /v1/api-keys/fleet/:id": { none: FLEET },
  "GET /v1/audit/": { tool: "audit_list" },
  "GET /v1/audit/export": { none: EXPORT },
  "GET /v1/business-hours/": { tool: "business_hours_list" },
  "GET /v1/business-hours/:id": { gap: "one business-hours profile by id" },
  "POST /v1/business-hours/": { tool: "business_hours_create" },
  "PATCH /v1/business-hours/:id": { tool: "business_hours_update" },
  "DELETE /v1/business-hours/:id": { tool: "business_hours_delete" },
  "GET /v1/chatwoot/deployment": { tool: "instance_list" },
  "POST /v1/chatwoot/deployment": { tool: "deployment_connect" },
  "PATCH /v1/chatwoot/deployment": { tool: "deployment_rotate_token" },
  "DELETE /v1/chatwoot/deployment": { none: FLEET },
  "GET /v1/chatwoot/deployment/accounts": { tool: "deployment_list_accounts" },
  "PUT /v1/chatwoot/deployment/accounts": { tool: "deployment_set_accounts" },
  "DELETE /v1/chatwoot/instances/:id": { tool: "instance_disconnect" },
  "POST /v1/chatwoot/instances/:id/reconnect": {
    gap: "reconnect a soft-disconnected account, the inverse of instance_disconnect",
  },
  "POST /v1/chatwoot/instances/:id/remove": { none: FLEET },
  "POST /v1/chatwoot/instances/:id/sync-inboxes": {
    tool: "instance_sync_inboxes",
  },
  "GET /v1/chatwoot/inboxes": { tool: "inbox_list" },
  "GET /v1/chatwoot/inboxes/bot-status": { tool: "inbox_reconcile" },
  "GET /v1/chatwoot/inboxes/:id/widget-health": {
    gap: "widget health of one inbox",
  },
  "GET /v1/chatwoot/agents-teams/:agentId": { none: PICKER },
  "GET /v1/chatwoot/service-window-templates/:agentId": { none: PICKER },
  "GET /v1/chatwoot/labels/:agentId": { none: PICKER },
  "GET /v1/chatwoot/custom-attributes/:agentId": { none: PICKER },
  "PATCH /v1/chatwoot/inboxes/:id": { tool: "inbox_bind" },
  "POST /v1/chatwoot/inboxes/:id/observers": { tool: "inbox_observe" },
  "DELETE /v1/chatwoot/inboxes/:id/observers/:agentId": {
    tool: "inbox_unobserve",
  },
  "DELETE /v1/chatwoot/inboxes/:id": { tool: "inbox_remove" },
  "POST /v1/chatwoot/inboxes/:id/reconnect": { tool: "inbox_reconnect" },
  "POST /v1/chatwoot/webhook/:routeToken": { none: INBOUND },
  "GET /v1/code-tools/": { tool: "code_tool_list" },
  "GET /v1/code-tools/:id": { tool: "code_tool_get" },
  "GET /v1/code-tools/:id/references": {
    gap: "which agents use this code tool",
  },
  "POST /v1/code-tools/": { tool: "code_tool_create" },
  "POST /v1/code-tools/test": { gap: "run a code tool against a sample input" },
  "PATCH /v1/code-tools/:id": { tool: "code_tool_update" },
  "DELETE /v1/code-tools/:id": { tool: "code_tool_delete" },
  "GET /v1/document-templates/": { tool: "document_template_list" },
  "GET /v1/document-templates/starters": { tool: "document_starters_list" },
  "POST /v1/document-templates/": { tool: "document_template_create" },
  "POST /v1/document-templates/preview": { none: BINARY },
  "GET /v1/document-templates/:id": { tool: "document_template_get" },
  "GET /v1/document-templates/:id/references": {
    gap: "which agents use this document template",
  },
  "PATCH /v1/document-templates/:id": { tool: "document_template_update" },
  "DELETE /v1/document-templates/:id": { tool: "document_template_delete" },
  "GET /v1/documents/": { tool: "issued_document_list" },
  "POST /v1/documents/": { gap: "issue a document outside a conversation" },
  "POST /v1/documents/:id/revoke": { gap: "revoke an issued document" },
  "GET /v1/documents/:id/pdf": { none: BINARY },
  "GET /v1/experiments/": { tool: "experiment_list" },
  "GET /v1/experiments/:id": { tool: "experiment_get" },
  "GET /v1/experiments/:id/results": { tool: "experiment_results" },
  "POST /v1/experiments/": { tool: "experiment_create" },
  "PATCH /v1/experiments/:id": { tool: "experiment_update" },
  "DELETE /v1/experiments/:id": { tool: "experiment_delete" },
  "GET /v1/integrations/catalog": { tool: "integration_catalog" },
  "GET /v1/integrations/google/calendars": { none: PICKER },
  "GET /v1/integrations/google/drive-folders": { none: PICKER },
  "GET /v1/integrations/instances": { tool: "integration_list" },
  "GET /v1/integrations/instances/:id": {
    gap: "one integration instance by id",
  },
  "POST /v1/integrations/instances": { tool: "integration_create" },
  "PATCH /v1/integrations/instances/:id": { tool: "integration_update" },
  "POST /v1/integrations/instances/:id/route-token": { none: SECRET },
  "DELETE /v1/integrations/instances/:id": { tool: "integration_delete" },
  "POST /v1/integrations/inbound/:routeToken": { none: INBOUND },
  "GET /v1/knowledge/bases": { tool: "knowledge_list" },
  "POST /v1/knowledge/bases": { tool: "knowledge_create" },
  "GET /v1/knowledge/bases/:id": { gap: "one knowledge base by id" },
  "PATCH /v1/knowledge/bases/:id": { tool: "knowledge_update" },
  "DELETE /v1/knowledge/bases/:id": { tool: "knowledge_delete" },
  "PUT /v1/knowledge/bases/:id/source": { tool: "knowledge_source_set" },
  "DELETE /v1/knowledge/bases/:id/source": { tool: "knowledge_source_remove" },
  "POST /v1/knowledge/bases/:id/source/sync": {
    tool: "knowledge_source_sync",
  },
  "GET /v1/knowledge/embedding-block": { none: EMBEDDING_BLOCK },
  "GET /v1/knowledge/bases/:id/documents": { tool: "knowledge_documents_list" },
  "POST /v1/knowledge/bases/:id/documents": {
    tool: "knowledge_document_create",
  },
  "POST /v1/knowledge/bases/:id/documents/upload": { none: BINARY },
  "GET /v1/knowledge/documents/:id": { tool: "knowledge_document_get" },
  "PATCH /v1/knowledge/documents/:id": { tool: "knowledge_document_update" },
  "DELETE /v1/knowledge/documents/:id": { tool: "knowledge_document_delete" },
  "POST /v1/knowledge/documents/:id/retry": {
    tool: "knowledge_document_retry",
  },
  "POST /v1/knowledge/bases/:id/reindex": { tool: "knowledge_reindex" },
  "POST /v1/knowledge/search": { tool: "knowledge_search" },
  "POST /v1/knowledge/suggestions": {
    gap: "propose a knowledge entry for approval",
  },
  "GET /v1/knowledge/approvals": { tool: "knowledge_approvals_list" },
  "PATCH /v1/knowledge/approvals/:id": { tool: "knowledge_edit" },
  "POST /v1/knowledge/approvals/:id/approve": { tool: "knowledge_approve" },
  "POST /v1/knowledge/approvals/:id/reject": { tool: "knowledge_reject" },
  "GET /v1/logs/": { tool: "logs_query" },
  "GET /v1/logs/export": { tool: "logs_export" },
  "GET /v1/mcp/admin/connection": { none: MCP_ACCESS },
  "GET /v1/mcp/admin/clients": { none: MCP_ACCESS },
  "POST /v1/mcp/admin/clients": { none: MCP_ACCESS },
  "PATCH /v1/mcp/admin/clients/:clientId": { none: MCP_ACCESS },
  "DELETE /v1/mcp/admin/clients/:clientId": { none: MCP_ACCESS },
  "GET /v1/mcp/admin/tokens": { none: MCP_ACCESS },
  "DELETE /v1/mcp/admin/tokens/:jti": { none: MCP_ACCESS },
  "GET /v1/mcp/admin/approvals": { none: MCP_ACCESS },
  "DELETE /v1/mcp/admin/approvals/:id": { none: MCP_ACCESS },
  "GET /v1/mcp-connections/": { tool: "mcp_connection_list" },
  "GET /v1/mcp-connections/:id": { gap: "one MCP connection by id" },
  "GET /v1/mcp-connections/:id/references": {
    gap: "which agents use this MCP connection",
  },
  "POST /v1/mcp-connections/": { tool: "mcp_connection_create" },
  "PATCH /v1/mcp-connections/:id": { tool: "mcp_connection_update" },
  "DELETE /v1/mcp-connections/:id": { tool: "mcp_connection_delete" },
  "POST /v1/mcp-connections/:id/discover": { tool: "mcp_connection_discover" },
  "GET /v1/mcp/me/connections": { none: MCP_ACCESS },
  "DELETE /v1/mcp/me/connections/:clientId": { none: MCP_ACCESS },
  "GET /v1/mcp/me/info": { tool: "whoami" },
  "POST /v1/mcp/oauth/register": { none: OAUTH },
  "GET /v1/mcp/oauth/authorize": { none: OAUTH },
  "GET /v1/mcp/oauth/consent/:req": { none: OAUTH },
  "POST /v1/mcp/oauth/consent/:req": { none: OAUTH },
  "POST /v1/mcp/oauth/token": { none: OAUTH },
  "POST /v1/mcp/": { none: TRANSPORT },
  "GET /v1/mcp/": { none: TRANSPORT },
  "DELETE /v1/mcp/": { none: TRANSPORT },
  "GET /v1/n8n-export/tools/:id": { none: EXPORT },
  "POST /v1/vault/:id/oauth/google/authorize": { none: OAUTH },
  "GET /v1/vault/:id/oauth/google/status": { none: OAUTH },
  "POST /v1/vault/:id/oauth/google/disconnect": { none: OAUTH },
  "GET /v1/oauth/google/callback": { none: OAUTH },
  "POST /v1/vault/:id/oauth/mcp/authorize": { none: OAUTH },
  "GET /v1/vault/:id/oauth/mcp/status": { none: OAUTH },
  "POST /v1/vault/:id/oauth/mcp/disconnect": { none: OAUTH },
  "GET /v1/oauth/mcp/callback": { none: OAUTH },
  "GET /v1/tenant-settings/": { tool: "tenant_settings_get" },
  "PUT /v1/tenant-settings/embedding": { tool: "tenant_settings_update" },
  "PUT /v1/tenant-settings/langfuse": { tool: "tenant_settings_update" },
  "GET /v1/tenant-settings/spend-ceiling/usage": { gap: "spend-ceiling usage" },
  "PUT /v1/tenant-settings/spend-ceiling": { gap: "set the spend ceiling" },
  "PUT /v1/tenant-settings/price-overrides": { tool: "tenant_settings_update" },
  "POST /v1/tenant-settings/langfuse/test": {
    gap: "probe the Langfuse credential",
  },
  "PUT /v1/tenant-settings/company": { gap: "set the company profile" },
  "POST /v1/tenant-settings/company/logo": { none: BINARY },
  "DELETE /v1/tenant-settings/company/logo": { none: BINARY },
  "GET /v1/tenant-settings/company/logo": { none: BINARY },
  "GET /v1/tools/": { tool: "tool_list" },
  "GET /v1/tools/:id": { tool: "tool_get" },
  "GET /v1/tools/:id/references": { gap: "which agents use this HTTP tool" },
  "POST /v1/tools/": { tool: "tool_create" },
  "POST /v1/tools/test": { gap: "run an HTTP tool against a sample input" },
  "PATCH /v1/tools/:id": { tool: "tool_update" },
  "DELETE /v1/tools/:id": { tool: "tool_delete" },
  "GET /v1/meta": { none: META },
  "GET /v1/tenants": { tool: "tenant_list" },
  "GET /v1/tenants/:id": { tool: "tenant_get" },
  "PATCH /v1/tenants/:id": { tool: "tenant_update" },
  "DELETE /v1/tenants/:id": { none: FLEET },
  "POST /v1/tenants": { tool: "tenant_create" },
  "GET /v1/conversations": { tool: "list_conversations" },
  "GET /v1/conversations/agents": { none: CONV_AGENTS },
  "GET /v1/conversations/:id": { tool: "conversation_get" },
  "GET /v1/conversations/:id/messages": { tool: "conversation_messages" },
  "GET /v1/conversations/:id/media": { none: BINARY },
  "POST /v1/conversations/:id/handoff": { tool: "conversation_handoff" },
  "POST /v1/conversations/:id/return": { tool: "conversation_return" },
  "POST /v1/conversations/:id/reengage": { tool: "conversation_reengage" },
  "POST /v1/conversations/:id/status": { tool: "conversation_status" },
  "GET /v1/metrics": { tool: "metrics_get" },
  "GET /v1/metrics/kpis": { tool: "metrics_get" },
  "GET /v1/metrics/timeseries": { tool: "metrics_timeseries" },
  "GET /v1/metrics/costs": { gap: "LLM cost breakdown" },
  "GET /v1/vault/": { tool: "vault_list" },
  "POST /v1/vault/": { tool: "credential_create" },
  "PUT /v1/vault/:id": { none: SECRET },
  "GET /v1/vault/:id/references": { tool: "vault_references" },
  "POST /v1/vault/test": { gap: "probe a credential before saving it" },
  "POST /v1/vault/:id/test": { gap: "probe a saved credential" },
  "DELETE /v1/vault/:id": { gap: "delete a credential" },
  "GET /v1/webhooks/events": { tool: "webhook_events_list" },
  "GET /v1/webhooks/subscriptions": { tool: "webhook_list" },
  "POST /v1/webhooks/subscriptions": { tool: "webhook_create" },
  "PATCH /v1/webhooks/subscriptions/:id": { tool: "webhook_update" },
  "DELETE /v1/webhooks/subscriptions/:id": { tool: "webhook_delete" },
  "POST /v1/webhooks/subscriptions/:id/test": { tool: "webhook_test" },
  "GET /v1/webhooks/deliveries": { tool: "webhook_delivery_list" },
  "GET /v1/webhooks/deliveries/:id": { tool: "webhook_delivery_get" },
  "POST /v1/webhooks/deliveries/:id/requeue": {
    tool: "webhook_delivery_requeue",
  },
};
