import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getGlobalBranding } from "@/api/features/branding/branding.service";
import config from "@/config";
import { AppError } from "@/lib/errors";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import type { TenantContext } from "@/lib/tenancy";
import {
  BEHAVIOR_PATCH_SHAPE,
  type BehaviorPatchArgs,
} from "@/modules/agents/settings-schema";
import { exportAgent } from "@/modules/agents/transfer";
import { listConversations } from "@/modules/conversations/service";
import { FLOW_LEVELS, FLOW_STAGES } from "@/modules/flowlog/stages";
import {
  runPlaygroundAudioTurn,
  runPlaygroundFileTurn,
  runPlaygroundTurn,
} from "@/modules/playground/service";
import { OUTBOUND_DELIVERY_STATUSES } from "@/modules/webhooks/outbound/deliveries";
import { hasScope, type VerifiedToken } from "./oauth/tokens";
import {
  agentGet,
  agentToolsGet,
  alertChannelList,
  alertStageList,
  apiKeyList,
  auditList,
  businessHoursList,
  conversationGet,
  conversationMessages,
  documentStarterList,
  documentTemplateGet,
  documentTemplateList,
  documentTemplateSchema,
  experimentGet,
  experimentList,
  experimentResultsGet,
  inboxList,
  instanceGet,
  instanceList,
  integrationCatalog,
  integrationList,
  issuedDocumentList,
  knowledgeApprovalsList,
  knowledgeDocumentsList,
  knowledgeList,
  knowledgeSearch,
  logsExport,
  logsQuery,
  mcpConnectionList,
  metricsGet,
  metricsTimeseries,
  tenantSettingsGet,
  toolGet,
  toolList,
  vaultList,
  vaultReferencesGet,
  webhookDeliveryGet,
  webhookDeliveryList,
  webhookEventsList,
  webhookList,
} from "./read";
import {
  resolveEffectivePrincipal,
  tenantSelectorField,
} from "./tenant-target";
import {
  agentList,
  agentSettingsGet,
  agentSettingsSet,
  brandingAssetSet,
  brandingSet,
  credentialCreate,
  parseMcpId,
  promptSet,
  tenantUpdate,
  type WriteResult,
} from "./write";
import {
  agentClone,
  agentCreate,
  agentDelete,
  agentImport,
  agentToolsSet,
  agentUpdate,
  mcpConnectionCreate,
  mcpConnectionDelete,
  mcpConnectionDiscover,
  mcpConnectionUpdate,
  toolCreate,
  toolDelete,
  toolUpdate,
} from "./write-agents";
import {
  deploymentConnect,
  deploymentListAccounts,
  deploymentRotateToken,
  deploymentSetAccounts,
  inboxBind,
  inboxReconcile,
  inboxReconnect,
  inboxRemove,
  instanceDisconnect,
  instanceListAccounts,
  instanceSyncInboxes,
} from "./write-channels";
import {
  conversationHandoff,
  conversationReengage,
  conversationReply,
  conversationReturn,
  conversationStatus,
} from "./write-conversations";
import {
  type DocumentTemplateWriteArgs,
  documentTemplateCreate,
  documentTemplateDelete,
  documentTemplateUpdate,
} from "./write-documents";
import { tenantCreate, tenantGet, tenantList } from "./write-fleet";
import {
  knowledgeApprove,
  knowledgeCreate,
  knowledgeDelete,
  knowledgeDocumentCreate,
  knowledgeDocumentDelete,
  knowledgeDocumentRetry,
  knowledgeEdit,
  knowledgeReindex,
  knowledgeReject,
  knowledgeUpdate,
} from "./write-knowledge";
import {
  apiKeyRevoke,
  businessHoursCreate,
  businessHoursDelete,
  businessHoursUpdate,
  experimentCreate,
  experimentDelete,
  experimentUpdate,
  langfuseConnect,
  tenantSettingsUpdate,
} from "./write-settings";
import {
  alertChannelCreate,
  alertChannelDelete,
  alertChannelUpdate,
  integrationCreate,
  integrationDelete,
  integrationUpdate,
  webhookCreate,
  webhookDelete,
  webhookDeliveryRequeue,
  webhookTest,
  webhookUpdate,
} from "./write-webhooks";

// The MCP server is the THIRD transport: it projects the same tenant-scoped services the REST API
// and UI use. A server is built PER REQUEST, bound to the verified principal — every tool is
// fenced to the principal's tenant (the {tenant} in any URI never overrides the token's tenant,
// anti-IDOR) and gated by the token's scopes. Write tools (mcp:write) additionally enforce a
// tenant target, a dry-run-by-default preview, and an audit row on apply (see ./write.ts).

// Maps a write tool's result to MCP content (errors become isError text, never a thrown 500).
function writeContent(r: WriteResult) {
  if (!r.ok) {
    return {
      content: [{ type: "text" as const, text: r.error }],
      isError: true,
    };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(r.data) }] };
}

function principalCtx(principal: VerifiedToken): TenantContext {
  return {
    tenantId: principal.tenantId,
    userId: principal.userId,
    role: principal.role,
  };
}

// Registers a PER-TENANT tool. The tenant target is explicit-per-call for a fleet-level SUPER_ADMIN
// token (the input schema gains a required `tenant` selector) and implicit/transparent for a
// tenant-scoped token (the field is omitted). Before the handler runs, the principal is resolved to
// an "effective principal" whose tenantId is set — so the handler, every gate, and every service
// below it see one tenant, identical in shape to an ordinary tenant token (the anti-IDOR fence is
// unchanged). A missing/unknown `tenant` (SUPER_ADMIN only) short-circuits with an isError result,
// never a thrown 500. See ./tenant-target.ts. Fleet/global tools (whoami, branding_*, tenant_*) are
// NOT registered through this — they have no tenant target and stay on server.registerTool.
function registerTenantTool(
  server: McpServer,
  principal: VerifiedToken,
  name: string,
  def: { description: string; inputSchema: z.ZodRawShape },
  handler: (
    // biome-ignore lint/suspicious/noExplicitAny: each call site narrows `args` to its own tool shape; `any` lets those narrower handler signatures bind without a per-tool generic.
    args: any,
    eff: VerifiedToken,
  ) => CallToolResult | Promise<CallToolResult>,
): void {
  const inputSchema =
    principal.role === "SUPER_ADMIN"
      ? { ...def.inputSchema, tenant: tenantSelectorField }
      : def.inputSchema;
  server.registerTool(
    name,
    { description: def.description, inputSchema },
    async (args: Record<string, unknown>) => {
      const resolved = await resolveEffectivePrincipal(principal, args);
      if (!resolved.ok) {
        return {
          content: [{ type: "text" as const, text: resolved.error }],
          isError: true,
        };
      }
      return handler(args, resolved.eff);
    },
  );
}

// Matches the playground service's own audio/file upload caps so the MCP path rejects oversized
// media before any provider call.
const MAX_MCP_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface McpPlaygroundAttachment {
  mime: string;
  data_base64?: string;
  url?: string;
  filename?: string;
}

// Builds a File from an MCP playground attachment so it can flow through the SAME audio/file turn
// the UI uses. The model supplies bytes inline (`data_base64`, also accepts a full `data:` URL) or a
// remote `url` (anti-SSRF + https-only, no redirects). The explicit `mime` is honored verbatim
// (we construct the File directly, so unlike the multipart path Bun does not re-derive it from the
// filename). NEVER carries a secret — media only.
export async function mcpAttachmentToFile(
  att: McpPlaygroundAttachment,
): Promise<File> {
  let bytes: Uint8Array<ArrayBuffer>;
  if (att.data_base64) {
    // Tolerate a full data URL (`data:<mime>;base64,<payload>`) by keeping only the payload.
    const comma = att.data_base64.indexOf(",");
    const payload =
      att.data_base64.startsWith("data:") && comma !== -1
        ? att.data_base64.slice(comma + 1)
        : att.data_base64;
    const buf = Buffer.from(payload, "base64");
    if (buf.byteLength === 0) {
      throw new AppError(
        "attachment.data_base64 is empty or not valid base64",
        400,
      );
    }
    // Copy into a standalone ArrayBuffer-backed view (a BlobPart the File constructor accepts).
    bytes = new Uint8Array(buf.byteLength);
    bytes.set(buf);
  } else if (att.url) {
    const safe = await assertSafeOutboundUrl(att.url);
    const res = await fetch(safe, { redirect: "error" });
    if (!res.ok) {
      throw new AppError(
        `attachment.url fetch failed with status ${res.status}`,
        400,
      );
    }
    bytes = new Uint8Array(await res.arrayBuffer());
  } else {
    throw new AppError("attachment requires either data_base64 or url", 400);
  }
  if (bytes.byteLength > MAX_MCP_ATTACHMENT_BYTES) {
    throw new AppError("attachment too large (max 25MB)", 413);
  }
  const name = att.filename?.trim() || defaultAttachmentName(att.mime);
  return new File([bytes], name, { type: att.mime });
}

// A sensible filename (extension drives nothing downstream — the explicit File `type` does — but a
// real name keeps the persisted-media replay and the audio-turn title readable).
function defaultAttachmentName(mime: string): string {
  if (mime.startsWith("audio/") || mime === "video/webm") return "voice-note";
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "document.pdf";
  return "attachment";
}

export function isAudioMime(mime: string): boolean {
  return mime.startsWith("audio/") || mime === "video/webm";
}

// The per-turn options every playground branch passes on, mapped once. They were read inline in
// each of the three (text / audio / file), which is how the guardrail toggle reached one of them
// and not the others. Exported because the forwarding is the whole contract with the third
// transport, and there is no way to prove it end to end without a real provider call.
export function playgroundTurnOptions(args: {
  reply_with_audio?: boolean;
  guardrails?: boolean;
}): { forceAudio: boolean | undefined; guardrails: boolean | undefined } {
  return { forceAudio: args.reply_with_audio, guardrails: args.guardrails };
}

export function buildMcpServer(principal: VerifiedToken): McpServer {
  const server = new McpServer(
    {
      name: config.packageInfo.name,
      version: config.packageInfo.version,
    },
    {
      // Server-level scope hint (MCP `initialize` result). Clients SHOULD surface this to the model so
      // it understands what this server operates on before calling any tool (see docs/mcp.md).
      instructions:
        "This server administers a fazer.ai agents workspace (tenant): its AI " +
        "customer-service agents and their system prompts, behavior settings, granted tools and " +
        "knowledge bases; the Chatwoot channels (instances/inboxes) they answer on; live " +
        "conversations (read, reply, hand off, re-engage); plus integrations, A/B experiments, " +
        "business hours, branding, vault credentials (referenced by name/id — secrets are never " +
        "returned), API keys, webhooks, alert channels, and audit/metrics/logs.\n\n" +
        "Access is scoped by the caller's granted scopes: mcp:read for reads, mcp:write for " +
        "changes, mcp:admin for tenant management. Write tools preview a diff and apply NOTHING " +
        "unless dry_run is false (omitting dry_run previews) — run once to preview, then again with " +
        "dry_run:false to commit. All ids are tenant-scoped. Call whoami first to see the " +
        "authenticated tenant, role and scopes.\n\n" +
        "Tenant targeting: an ordinary tenant token operates on its own tenant implicitly (no tenant " +
        "argument). A fleet-level SUPER_ADMIN token (whoami shows tenantId null) instead picks the " +
        "target per call: every per-tenant tool then takes a required `tenant` argument (a slug or id " +
        "— run tenant_list to discover them), so one session can drive many tenants. There is no need " +
        "to create a tenant to target one; do not call tenant_create unless provisioning a brand-new " +
        "workspace.",
    },
  );

  server.registerTool(
    "whoami",
    {
      description:
        "Return the authenticated MCP principal: tenant, role, and granted scopes.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            tenantId: principal.tenantId?.toString() ?? null,
            role: principal.role,
            scopes: principal.scopes,
          }),
        },
      ],
    }),
  );

  if (hasScope(principal, "mcp:read")) {
    registerTenantTool(
      server,
      principal,
      "list_conversations",
      {
        description:
          "List recent conversations for the tenant (metadata only; no message bodies).",
        inputSchema: {
          status: z.enum(["open", "pending", "resolved", "snoozed"]).optional(),
          limit: z
            .number()
            .int()
            .optional()
            .describe("Max conversations to return (1-100, default 50)."),
        },
      },
      async (args: { status?: string; limit?: number }, eff) => {
        const list = await listConversations(principalCtx(eff), {
          status: args.status,
          limit: args.limit,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(list) }],
        };
      },
    );

    server.registerTool(
      "branding_get",
      {
        description:
          "Get the GLOBAL app identity/branding: brand name, color mode, brand color, per-theme tokens, and which logo/favicon variants exist.",
        inputSchema: {},
      },
      async () => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(await getGlobalBranding()),
          },
        ],
      }),
    );

    registerTenantTool(
      server,
      principal,
      "agent_list",
      {
        description:
          "List the tenant's agents (id, name, enabled) so you can discover the agent_id the settings tools target.",
        inputSchema: {},
      },
      async (_args, eff) => writeContent(await agentList(eff)),
    );

    registerTenantTool(
      server,
      principal,
      "agent_settings_get",
      {
        description:
          "Get an agent's normalized BEHAVIOR config (debounce, stt, tts, split, serviceWindow, grounding, limits). credentialRef values are returned as vault entry names (never secrets); use vault:<id> when setting a credential whose name is shared by multiple types.",
        inputSchema: {
          agent_id: z.string(),
        },
      },
      async (args: { agent_id: string }, eff) =>
        writeContent(await agentSettingsGet(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "agent_playground",
      {
        description:
          "Chat with one of the tenant's agents in an isolated PLAYGROUND thread (no Chatwoot, no real customer). Runs the SAME model + system prompt + knowledge/HTTP/MCP/integration tools as production, MINUS the native conversation tools (handoff/resolve/…). Send a text `message`, OR an `attachment` (voice note / image / document) exactly like the console playground does: audio is transcribed (STT) and image/document content is extracted (vision) with the agent's configured providers, then the agent answers what it would in production (the response adds `transcription` for audio or `kind`+`extracted` for files). Returns { reply, threadId, trace, sources, … }: pass threadId back to continue the session with memory; `trace` is the sanitized execution trace (tool calls/args, results, errors — never secrets); `sources` are the KB passages the answer was grounded on. Set `reply_with_audio` to force a spoken (TTS) reply for this turn, and `guardrails: false` to skip the moderation pass (it runs by default, exactly as in the console). CAUTION: the agent's HTTP/integration tools still execute for real (a write tool will write), so treat this as a live test, not a pure simulation.",
        inputSchema: {
          agent_id: z.string(),
          message: z
            .string()
            .optional()
            .describe("The text message. Omit when sending an attachment."),
          thread_id: z.string().optional(),
          attachment: z
            .object({
              mime: z
                .string()
                .describe(
                  'Content type, e.g. "audio/ogg", "image/png", "application/pdf". Audio-like types (audio/* or video/webm) run the voice-note path (STT); everything else runs the image/document path (vision).',
                ),
              data_base64: z
                .string()
                .optional()
                .describe(
                  "The media bytes as base64 (a full data: URL is also accepted). Use this OR url.",
                ),
              url: z
                .string()
                .optional()
                .describe(
                  "A https URL to fetch the media from (anti-SSRF; no redirects). Use this OR data_base64.",
                ),
              filename: z.string().optional(),
            })
            .optional()
            .describe(
              "A voice note, image, or document to send instead of text — mirrors uploading a file in the console playground.",
            ),
          reply_with_audio: z
            .boolean()
            .optional()
            .describe(
              "Force an audio (TTS) reply for this turn regardless of the agent's saved reply mode.",
            ),
          guardrails: z
            .boolean()
            .optional()
            .describe(
              "Run the agent's guardrails over this turn (default true, matching the console). False skips the screening model call entirely, which is up to two paid calls on an output turn.",
            ),
        },
      },
      async (
        args: {
          agent_id: string;
          message?: string;
          thread_id?: string;
          attachment?: McpPlaygroundAttachment;
          reply_with_audio?: boolean;
          guardrails?: boolean;
        },
        eff,
      ) => {
        try {
          // The principal's OWN context, not an id rebuilt from it. A fleet token resolved its
          // `tenant` selector on the way in (tenant-target.ts) and keeps SUPER_ADMIN, so the scoped
          // boundary verifies the target once more and a tenant deleted between the two answers a
          // refusal rather than an empty playground. Issue #268.
          const ctx = principalCtx(eff);
          // Same parser as every other id: a padded or empty agent_id must not resolve to some
          // other agent's row.
          const parsedAgent = parseMcpId(args.agent_id, "agent_id");
          if (typeof parsedAgent !== "bigint") {
            return {
              content: [
                { type: "text" as const, text: JSON.stringify(parsedAgent) },
              ],
              isError: true,
            };
          }
          const agentId = parsedAgent;
          const threadId = args.thread_id;
          const { forceAudio, guardrails } = playgroundTurnOptions(args);
          let res: unknown;
          if (args.attachment) {
            const file = await mcpAttachmentToFile(args.attachment);
            res = isAudioMime(file.type)
              ? await runPlaygroundAudioTurn({
                  ctx,
                  agentId,
                  file,
                  threadId,
                  forceAudio,
                  guardrails,
                })
              : await runPlaygroundFileTurn({
                  ctx,
                  agentId,
                  file,
                  threadId,
                  forceAudio,
                  guardrails,
                });
          } else if (args.message?.trim()) {
            res = await runPlaygroundTurn({
              ctx,
              agentId,
              message: args.message,
              threadId,
              forceAudio,
              guardrails,
            });
          } else {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Provide a non-empty message or an attachment.",
                },
              ],
              isError: true,
            };
          }
          return {
            content: [{ type: "text" as const, text: JSON.stringify(res) }],
          };
        } catch (e) {
          return {
            content: [
              {
                type: "text" as const,
                text: e instanceof Error ? e.message : String(e),
              },
            ],
            isError: true,
          };
        }
      },
    );

    registerTenantTool(
      server,
      principal,
      "agent_export",
      {
        description:
          "Export an agent's full configuration as a portable, secret-free JSON: system prompt, model config, behavior settings, and tool grants — all referencing credentials/tools/KBs BY NAME (never a secret value). Use it to share or back up a configuration; import is via REST/UI.",
        inputSchema: { agent_id: z.string() },
      },
      async (args: { agent_id: string }, eff) => {
        try {
          const parsedAgent = parseMcpId(args.agent_id, "agent_id");
          if (typeof parsedAgent !== "bigint") {
            return {
              content: [
                { type: "text" as const, text: JSON.stringify(parsedAgent) },
              ],
              isError: true,
            };
          }
          const data = await exportAgent(principalCtx(eff), parsedAgent);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(data) }],
          };
        } catch (e) {
          return {
            content: [
              {
                type: "text" as const,
                text: e instanceof Error ? e.message : String(e),
              },
            ],
            isError: true,
          };
        }
      },
    );

    // ── expanded read coverage (mcp:read) ──
    // Each tool projects a tenant-scoped service; secret-bearing fields are redacted by the service
    // (Chatwoot adminToken → hasAdminToken, alert URL → urlMasked, API key → prefix) and credentialRef
    // values are returned as vault entry NAMES, never secret values.

    registerTenantTool(
      server,
      principal,
      "agent_get",
      {
        description:
          "Get one agent's FULL configuration: name, enabled, systemPrompt, modelConfig, businessHoursId/followUpHoursId, transferWithSummary, and the normalized behavior settings bag.",
        inputSchema: { agent_id: z.string() },
      },
      async (args: { agent_id: string }, eff) =>
        writeContent(await agentGet(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "agent_tools_get",
      {
        description:
          "Get an agent's tool GRANTS (the selected set) plus the full tenant CATALOG of selectable tools (native, RAG knowledge bases, HTTP tool definitions, MCP connections, integration instances). Use this to discover ids before agent_tools_set.",
        inputSchema: { agent_id: z.string() },
      },
      async (args: { agent_id: string }, eff) =>
        writeContent(await agentToolsGet(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "tool_list",
      {
        description:
          "List the tenant's HTTP tool definitions (id, name, method, urlTemplate, enabled, credentialRef as a vault NAME). No secrets.",
        inputSchema: {},
      },
      async (_args, eff) => writeContent(await toolList(eff)),
    );

    registerTenantTool(
      server,
      principal,
      "tool_get",
      {
        description:
          "Get one HTTP tool definition in full (schemas, headers, body, allowedHosts, credentialRef as a vault NAME). No secrets.",
        inputSchema: { tool_id: z.string() },
      },
      async (args: { tool_id: string }, eff) =>
        writeContent(await toolGet(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "mcp_connection_list",
      {
        description:
          "List the tenant's outbound MCP server connections (id, name, transport, url/command, enabled, credentialRef as a vault NAME). No secrets.",
        inputSchema: {},
      },
      async (_args, eff) => writeContent(await mcpConnectionList(eff)),
    );

    registerTenantTool(
      server,
      principal,
      "integration_list",
      {
        description:
          "List the tenant's integration instances (id, catalogType, name, enabled, config, credentialRef/inboundSecretRef as vault NAMES, inboundAuthStrategy). No secrets, no route tokens.",
        inputSchema: {},
      },
      async (_args, eff) => writeContent(await integrationList(eff)),
    );

    registerTenantTool(
      server,
      principal,
      "integration_catalog",
      {
        description:
          "List the available integration CATALOG entries (catalogType, label, kind TOOLPACK/MCP/NATIVE, description, supportsInbound) the tenant can instantiate.",
        inputSchema: {},
      },
      async (_args, eff) => writeContent(await integrationCatalog(eff)),
    );

    registerTenantTool(
      server,
      principal,
      "knowledge_list",
      {
        description:
          "List the tenant's knowledge bases (id, name, description, embeddingModel, chunkSize/chunkOverlap, documentCount).",
        inputSchema: {},
      },
      async (_args, eff) => writeContent(await knowledgeList(eff)),
    );

    registerTenantTool(
      server,
      principal,
      "knowledge_search",
      {
        description:
          "Semantic search across the tenant's knowledge bases. Returns ranked chunks (content, source document, distance). knowledge_base_ids optionally restricts the search.",
        inputSchema: {
          query: z.string(),
          knowledge_base_ids: z
            .array(z.string())
            .optional()
            .describe(
              "Restrict the search to these knowledge base ids (from knowledge_list); omit to search every base.",
            ),
          limit: z
            .number()
            .int()
            .optional()
            .describe("Number of chunks to return (default 5)."),
        },
      },
      async (
        args: {
          query: string;
          knowledge_base_ids?: string[];
          limit?: number;
        },
        eff,
      ) => writeContent(await knowledgeSearch(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "knowledge_documents_list",
      {
        description:
          "List the documents in one knowledge base (id, title, sourceType, status, chunkCount, contentChars, error).",
        inputSchema: { knowledge_base_id: z.string() },
      },
      async (args: { knowledge_base_id: string }, eff) =>
        writeContent(await knowledgeDocumentsList(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "knowledge_approvals_list",
      {
        description:
          "List the tenant's PENDING knowledge-suggestion approvals (proposed title/content, rationale, source conversation/playground).",
        inputSchema: {},
      },
      async (_args, eff) => writeContent(await knowledgeApprovalsList(eff)),
    );

    registerTenantTool(
      server,
      principal,
      "instance_list",
      {
        description:
          "List the tenant's Chatwoot deployment (baseUrl, hasAdminToken) and its accounts (id, accountId, accountName, disconnectedAt). The admin token is NEVER returned.",
        inputSchema: {},
      },
      async (_args, eff) => writeContent(await instanceList(eff)),
    );

    registerTenantTool(
      server,
      principal,
      "instance_get",
      {
        description:
          "Get one Chatwoot account (id, accountId, accountName, disconnectedAt). The shared admin token lives on the deployment and is NEVER returned.",
        inputSchema: { instance_id: z.string() },
      },
      async (args: { instance_id: string }, eff) =>
        writeContent(await instanceGet(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "inbox_list",
      {
        description:
          "List the tenant's Chatwoot inboxes (id, chatwootInstanceId, chatwootInboxId, name, channelType, agentId). agentId is the bound agent (null = unbound). This lists the LOCAL MIRROR, which can lag behind Chatwoot; if an inbox you expect is missing and you have mcp:write, call instance_sync_inboxes with instance_id=chatwootInstanceId and dry_run:false, then list again.",
        inputSchema: {},
      },
      async (_args, eff) => writeContent(await inboxList(eff)),
    );

    registerTenantTool(
      server,
      principal,
      "webhook_list",
      {
        description:
          "List the tenant's outbound webhook subscriptions (id, url, events, enabled, secretRef as a vault NAME). The signing secret itself is never returned.",
        inputSchema: {},
      },
      async (_args, eff) => writeContent(await webhookList(eff)),
    );

    registerTenantTool(
      server,
      principal,
      "webhook_events_list",
      {
        description:
          "List the catalog of outbound event types a webhook subscription can subscribe to.",
        inputSchema: {},
      },
      async (_args, eff) => writeContent(await webhookEventsList(eff)),
    );

    registerTenantTool(
      server,
      principal,
      "webhook_delivery_list",
      {
        description:
          "List outbound webhook DELIVERIES (id, subscriptionId, subscriptionEnabled, event, status, attempts, nextAttemptAt, deliveredAt, lastError), newest first. status=DEAD is the dead-letter view: what the worker gave up on. The payload is never returned. Keyset paginated via cursor; limit max 200. Requeue a dead one with webhook_delivery_requeue.",
        inputSchema: {
          // NOTE: derived from the module's vocabulary, never hand-listed — the enum on the model
          // also carries FAILED, which only the inbound side writes, and a hand copy is how a
          // filter ends up advertising a value that can never match.
          status: z.enum(OUTBOUND_DELIVERY_STATUSES).optional(),
          subscription_id: z.string().optional(),
          event: z.string().optional(),
          since: z
            .string()
            .optional()
            .describe("ISO date, lower bound on enqueue time."),
          until: z
            .string()
            .optional()
            .describe("ISO date, upper bound on enqueue time."),
          limit: z.number().int().optional(),
          cursor: z.string().optional(),
        },
      },
      async (
        args: {
          status?: string;
          subscription_id?: string;
          event?: string;
          since?: string;
          until?: string;
          limit?: number;
          cursor?: string;
        },
        eff,
      ) => writeContent(await webhookDeliveryList(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "webhook_delivery_get",
      {
        description:
          "Get one outbound webhook delivery by id. Same fields as webhook_delivery_list; the payload is never returned.",
        inputSchema: { delivery_id: z.string() },
      },
      async (args: { delivery_id: string }, eff) =>
        writeContent(await webhookDeliveryGet(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "alert_channel_list",
      {
        description:
          "List the tenant's flow-log alert channels (id, name, type, urlMasked, minLevel, stages, enabled, hasSecret). The full URL/token is never returned (urlMasked only).",
        inputSchema: {},
      },
      async (_args, eff) => writeContent(await alertChannelList(eff)),
    );

    registerTenantTool(
      server,
      principal,
      "alert_stage_list",
      {
        description:
          "List the execution-flow stage and level vocabularies an alert channel can filter on.",
        inputSchema: {},
      },
      async (_args, eff) => writeContent(await alertStageList(eff)),
    );

    registerTenantTool(
      server,
      principal,
      "business_hours_list",
      {
        description:
          "List the tenant's business-hours profiles (id, name, timezone, windows).",
        inputSchema: {},
      },
      async (_args, eff) => writeContent(await businessHoursList(eff)),
    );

    registerTenantTool(
      server,
      principal,
      "experiment_list",
      {
        description:
          "List the tenant's A/B prompt experiments (id, name, agentId, variants, enabled).",
        inputSchema: {},
      },
      async (_args, eff) => writeContent(await experimentList(eff)),
    );

    registerTenantTool(
      server,
      principal,
      "experiment_get",
      {
        description: "Get one A/B prompt experiment in full.",
        inputSchema: { experiment_id: z.string() },
      },
      async (args: { experiment_id: string }, eff) =>
        writeContent(await experimentGet(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "experiment_results",
      {
        description:
          "Get an experiment's results: per-variant assigned/converted counts and conversion rate, plus total assigned.",
        inputSchema: { experiment_id: z.string() },
      },
      async (args: { experiment_id: string }, eff) =>
        writeContent(await experimentResultsGet(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "tenant_settings_get",
      {
        description:
          "Get the tenant's embedding (RAG) and Langfuse observability settings. credentialRef values are returned as vault entry NAMES, never secrets.",
        inputSchema: {},
      },
      async (_args, eff) => writeContent(await tenantSettingsGet(eff)),
    );

    registerTenantTool(
      server,
      principal,
      "vault_list",
      {
        description:
          "List the tenant's vault entries by NAME, kind, baseUrl and paramName. The secret VALUE is never returned. Use these names as the credentialRef/secretRef for the write tools.",
        inputSchema: {},
      },
      async (_args, eff) => writeContent(await vaultList(eff)),
    );

    registerTenantTool(
      server,
      principal,
      "vault_references",
      {
        description:
          "List which entities (tools, MCP connections, integrations, webhooks, agents, tenant settings) reference a vault entry — check before assuming a credential is unused.",
        inputSchema: { vault_id: z.string() },
      },
      async (args: { vault_id: string }, eff) =>
        writeContent(await vaultReferencesGet(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "api_key_list",
      {
        description:
          "List the tenant's API keys (id, displayName, keyPrefix, role, lastUsedAt, revokedAt). The token itself is never returned (prefix only).",
        inputSchema: {},
      },
      async (_args, eff) => writeContent(await apiKeyList(eff)),
    );

    registerTenantTool(
      server,
      principal,
      "audit_list",
      {
        description:
          "Read the tenant's audit log (most recent first). before/after were allowlist-sanitized at write time (never secrets). Optionally filter by action; limit defaults to 100 (max 500).",
        inputSchema: {
          action: z.string().optional(),
          limit: z.number().int().optional(),
        },
      },
      async (args: { action?: string; limit?: number }, eff) =>
        writeContent(await auditList(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "logs_query",
      {
        description:
          "Query the execution-flow logs (per-stage runtime telemetry, PII-free). Filters: since/until (ISO), level, stage, agent_id, conversation_id, turn_id, source (inbox|all|playground), search (substring on errorMessage). Keyset paginated via cursor; limit max 200.",
        inputSchema: {
          since: z.string().optional(),
          until: z.string().optional(),
          level: z.enum(FLOW_LEVELS).optional(),
          // NOTE: derived from the vocabulary, never listed here: a hand copy had drifted to 8 of the
          // 11 stages while `logs_stages` (mcp/read.ts) advertised all 11, so a caller filtering by a
          // stage this very server had just told it about was refused.
          stage: z.enum(FLOW_STAGES).optional(),
          agent_id: z.string().optional(),
          conversation_id: z.string().optional(),
          turn_id: z.string().optional(),
          source: z
            .enum(["inbox", "all", "playground"])
            .optional()
            .describe("Defaults to inbox (real traffic) when omitted."),
          search: z.string().optional(),
          limit: z.number().int().optional(),
          cursor: z.string().optional(),
        },
      },
      async (
        args: {
          since?: string;
          until?: string;
          level?: string;
          stage?: string;
          agent_id?: string;
          conversation_id?: string;
          turn_id?: string;
          source?: string;
          search?: string;
          limit?: number;
          cursor?: string;
        },
        eff,
      ) => writeContent(await logsQuery(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "logs_export",
      {
        description:
          "Export the (filtered) execution-flow logs as a downloadable CSV or JSON file, newest first. Same filters as logs_query (since/until ISO, level, stage, agent_id, conversation_id, turn_id, source inbox|all|playground, search). Returns { format, filename, count, truncated, content } — `content` is the serialized file. Bounded by max_rows (default 1000, hard cap 10000); `truncated` is true when more rows matched than were returned.",
        inputSchema: {
          since: z.string().optional(),
          until: z.string().optional(),
          level: z.enum(FLOW_LEVELS).optional(),
          // NOTE: derived from the vocabulary, never listed here: a hand copy had drifted to 8 of the
          // 11 stages while `logs_stages` (mcp/read.ts) advertised all 11, so a caller filtering by a
          // stage this very server had just told it about was refused.
          stage: z.enum(FLOW_STAGES).optional(),
          agent_id: z.string().optional(),
          conversation_id: z.string().optional(),
          turn_id: z.string().optional(),
          source: z
            .enum(["inbox", "all", "playground"])
            .optional()
            .describe("Defaults to inbox (real traffic) when omitted."),
          search: z.string().optional(),
          format: z
            .enum(["csv", "json"])
            .optional()
            .describe("Export format; defaults to csv."),
          max_rows: z
            .number()
            .int()
            .optional()
            .describe("Max rows to export (default 1000, hard cap 10000)."),
        },
      },
      async (
        args: {
          since?: string;
          until?: string;
          level?: string;
          stage?: string;
          agent_id?: string;
          conversation_id?: string;
          turn_id?: string;
          source?: string;
          search?: string;
          format?: string;
          max_rows?: number;
        },
        eff,
      ) => writeContent(await logsExport(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "metrics_get",
      {
        description:
          "Get the dashboard KPIs (conversation involvement/resolution/automation rates) plus consolidated LLM usage (tokens/calls by agent/inbox/model/source) and conversation counts by status. Optional since (ISO) and source (inbox|playground).",
        inputSchema: {
          since: z.string().optional(),
          source: z.enum(["inbox", "playground"]).optional(),
        },
      },
      async (args: { since?: string; source?: string }, eff) =>
        writeContent(await metricsGet(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "metrics_timeseries",
      {
        description:
          "Get the LLM usage timeseries (per-bucket calls and token counts). Optional since (ISO) and source (inbox|playground).",
        inputSchema: {
          since: z.string().optional(),
          source: z.enum(["inbox", "playground"]).optional(),
        },
      },
      async (args: { since?: string; source?: string }, eff) =>
        writeContent(await metricsTimeseries(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "conversation_get",
      {
        description:
          "Get one conversation's metadata (status, assignee, inbox, contact, last error). No message bodies — use conversation_messages.",
        inputSchema: { conversation_id: z.string() },
      },
      async (args: { conversation_id: string }, eff) =>
        writeContent(await conversationGet(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "conversation_messages",
      {
        description:
          "Fetch a conversation's message thread from Chatwoot (content, type, sender, private flag, timestamps). Degrades gracefully (messagesUnavailable) if Chatwoot is unreachable.",
        inputSchema: { conversation_id: z.string() },
      },
      async (args: { conversation_id: string }, eff) =>
        writeContent(await conversationMessages(eff, args)),
    );

    // The document READS live here with every other *_list/*_get, not with the writes below: the
    // scope contract in docs/mcp.md is that mcp:read sees everything that only reads, and these
    // five went out inside the write block — invisible to a read-only token even though their own
    // implementations go through readGate.
    registerTenantTool(
      server,
      principal,
      "document_template_list",
      {
        description:
          "List the tenant's document templates (id, name, slug, the agent tool name it produces, declared fields, block count, numbering). The blocks themselves come from document_template_get.",
        inputSchema: {},
      },
      async (_args, eff) => writeContent(await documentTemplateList(eff)),
    );

    registerTenantTool(
      server,
      principal,
      "document_template_get",
      {
        description:
          "Get one document template in full: its blocks, declared fields and style, exactly as document_template_update accepts them.",
        inputSchema: { document_template_id: z.string() },
      },
      async (args: { document_template_id: string }, eff) =>
        writeContent(await documentTemplateGet(eff, args)),
    );

    // NOTE: the block vocabulary is served HERE, on demand, instead of being published in every
    // tools/list as the input schema of the two write tools. A document block is a six-variant
    // discriminated union, and JSON Schema publishes a union by inlining every variant — measured at
    // ~3.2k characters per tool, paid by every client on every session, for a contract only a caller
    // actually authoring a template needs. Nothing on the client side renders a form for a six-way
    // oneOf, so the cost buys nothing. The enforcement is not weakened: the service validates
    // strictly, and its refusal names the block and the rule.
    registerTenantTool(
      server,
      principal,
      "document_template_schema",
      {
        description:
          "The authoring contract for document templates: JSON Schema for every block type, for a declared field and for the style, plus the full {{token}} list. Generated from the validator itself, so it is exactly what document_template_create accepts. Call it once before authoring blocks.",
        inputSchema: {},
      },
      async (_args, eff) => writeContent(await documentTemplateSchema(eff)),
    );

    registerTenantTool(
      server,
      principal,
      "document_starters_list",
      {
        description:
          "List the ready-made document templates (quote, proposal, receipt) that document_template_create can start from with `starter`.",
        inputSchema: { locale: z.enum(["pt-BR", "en-US"]).optional() },
      },
      async (args: { locale?: "pt-BR" | "en-US" }, eff) =>
        writeContent(await documentStarterList(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "issued_document_list",
      {
        description:
          "List documents the tenant has issued (id, title, number, template, status, thread, revoked). The PDFs themselves are served only to an authenticated console session.",
        inputSchema: {
          template_id: z.string().optional(),
          thread_id: z.string().optional(),
          limit: z.number().int().optional(),
        },
      },
      async (
        args: { template_id?: string; thread_id?: string; limit?: number },
        eff,
      ) => writeContent(await issuedDocumentList(eff, args)),
    );
  }

  if (hasScope(principal, "mcp:write")) {
    registerTenantTool(
      server,
      principal,
      "prompt_set",
      {
        description:
          "Set an agent's system prompt. Previews a diff and applies NOTHING unless dry_run is false.",
        inputSchema: {
          agent_id: z.string(),
          system_prompt: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          agent_id: string;
          system_prompt: string;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await promptSet(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "agent_settings_set",
      {
        description:
          "Patch an agent's BEHAVIOR config. Each block is a PARTIAL patch MERGED into the existing settings (untouched keys preserved) and re-validated by the runtime readers, which CLAMP rather than refuse: a number outside its band is stored at the nearest end, and a value they cannot use at all is stored as the block's default. Previews a normalized diff and applies NOTHING unless dry_run is false \u2014 read the diff, it is where a clamp becomes visible. credentialRef accepts a vault entry NAME or a stable vault:<id> ref (use vault:<id> when several entries share a name). The fields, choices and ranges of every block are in this tool's SCHEMA; what each block does, and what it costs, is in docs/ (tts, stt, split, service-window, channel-redirect, graph, logs, chatwoot). Here are only the rules a caller cannot get from either. REFUSED, as opposed to clamped: operator free text over its cap is refused, not trimmed, on the preview as well as the apply \u2014 handoff.instructions 1500, followUp step instructions 2000, availability.awayMessage 2000, vision.extractionPrompt 4000. Only text this write INTRODUCES or CHANGES, so re-sending a stored over-cap value untouched is not a refusal. SAVED BUT DEAD, as opposed to refused: a tts block that ends up carrying normalizeModel or normalizeCredentialRef with no normalizeProvider (even the agent's own value) is stored without complaint and the rewrite NEVER RUNS \u2014 a model id and a key belong to the vendor they were picked from, so name it. On memory.compaction that same mistake, or a provider other than the agent's with no credentialRef of its own, stops the SUMMARISER instead and the thread stays raw. Same shape: an availability.awayMessage carrying {proximo_atendimento}/{next_open} is WITHHELD ENTIRELY when the schedule never reopens, because there is no honest value to interpolate. (Appointment reminders live on the Calendar integration's config \u2014 see integration_update.)",
        inputSchema: {
          agent_id: z.string(),
          ...BEHAVIOR_PATCH_SHAPE,
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: BehaviorPatchArgs & { agent_id: string; dry_run?: boolean },
        eff,
      ) => writeContent(await agentSettingsSet(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "tenant_update",
      {
        description:
          "Update the targeted tenant (name). Previews a diff and applies NOTHING unless dry_run is false.",
        inputSchema: {
          name: z.string().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: { name?: string; dry_run?: boolean }, eff) =>
        writeContent(await tenantUpdate(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "credential_create",
      {
        description:
          "Create a PENDING credential reference in the vault (a placeholder, NO secret). This tool NEVER accepts a secret value — it only declares that a credential will be needed and returns a fillAt deeplink for the operator to fill the secret in the console. Other write tools can reference the entry by NAME immediately (so you can wire model/integration/tool config now), but it resolves as 'missing' at runtime until filled; the vault list and the agent editor flag the pending state. kind = a vault secret type id (default 'generic'); pass base_url/param_name when the kind requires them (these are not secrets). Previews and creates NOTHING unless dry_run is false.",
        inputSchema: {
          name: z.string(),
          kind: z.string().optional(),
          base_url: z.string().nullable().optional(),
          param_name: z.string().nullable().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          name: string;
          kind?: string;
          base_url?: string | null;
          param_name?: string | null;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await credentialCreate(eff, args)),
    );

    // ── agent-builder writes (mcp:write; dry-run by default + audit) ──

    registerTenantTool(
      server,
      principal,
      "agent_create",
      {
        description:
          "Create an agent. Previews the normalized input and creates NOTHING unless dry_run is false. model_config may carry a credentialRef as a vault entry NAME (resolved server-side; never a raw key). Use prompt_set for the system prompt and agent_settings_set for behavior.",
        inputSchema: {
          name: z.string(),
          system_prompt: z.string().optional(),
          enabled: z.boolean().optional(),
          mode: z.enum(["test", "production"]).optional(),
          transfer_with_summary: z.boolean().optional(),
          model_config: z.record(z.string(), z.unknown()).optional(),
          business_hours_id: z.string().nullable().optional(),
          follow_up_hours_id: z.string().nullable().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          name: string;
          system_prompt?: string;
          enabled?: boolean;
          mode?: "test" | "production";
          transfer_with_summary?: boolean;
          model_config?: Record<string, unknown>;
          business_hours_id?: string | null;
          follow_up_hours_id?: string | null;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await agentCreate(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "agent_update",
      {
        description:
          "Update an agent's name/enabled/mode/transfer_with_summary/model_config/business_hours_id/follow_up_hours_id. mode is 'test' (silent until the customer sends /teste) or 'production' (answers normally). Previews a diff and applies NOTHING unless dry_run is false. (System prompt → prompt_set; behavior → agent_settings_set.) model_config credentialRef accepts a vault NAME.",
        inputSchema: {
          agent_id: z.string(),
          name: z.string().optional(),
          enabled: z.boolean().optional(),
          mode: z.enum(["test", "production"]).optional(),
          transfer_with_summary: z.boolean().optional(),
          model_config: z.record(z.string(), z.unknown()).optional(),
          business_hours_id: z.string().nullable().optional(),
          follow_up_hours_id: z.string().nullable().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          agent_id: string;
          name?: string;
          enabled?: boolean;
          mode?: "test" | "production";
          transfer_with_summary?: boolean;
          model_config?: Record<string, unknown>;
          business_hours_id?: string | null;
          follow_up_hours_id?: string | null;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await agentUpdate(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "agent_clone",
      {
        description:
          "Clone an agent (full config copy, including tool grants). Previews source/new names and clones NOTHING unless dry_run is false. name overrides the new agent's name.",
        inputSchema: {
          agent_id: z.string(),
          name: z.string().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: { agent_id: string; name?: string; dry_run?: boolean },
        eff,
      ) => writeContent(await agentClone(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "agent_import",
      {
        description:
          "Import an agent from a portable export JSON (the shape agent_export produces). Previews what would be created and imports NOTHING unless dry_run is false. The agent is ALWAYS created disabled and in test mode; components are recreated/reused BY NAME. Any credential missing in the target tenant is created as a PENDING vault entry with its reference kept wired (flagged in the warnings for the operator to fill afterward); kinds that cannot be pending (managed OAuth, or kinds requiring a base URL / param name) are reported as not-found instead.",
        inputSchema: {
          export: z.record(z.string(), z.unknown()),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: { export: Record<string, unknown>; dry_run?: boolean },
        eff,
      ) => writeContent(await agentImport(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "agent_delete",
      {
        description:
          "Delete an agent. Previews the target and deletes NOTHING unless dry_run is false.",
        inputSchema: {
          agent_id: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: { agent_id: string; dry_run?: boolean }, eff) =>
        writeContent(await agentDelete(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "agent_tools_set",
      {
        description:
          "REPLACE an agent's entire set of tool grants (it is not additive — pass the full desired set). Discover ids via agent_tools_get. Each grant has a source (NATIVE/RAG/HTTP/MCP/INTEGRATION/DOCUMENT) and the matching id(s): toolDefinitionId (HTTP), mcpServerConnectionId (MCP), integrationInstanceId (INTEGRATION), documentTemplateId (DOCUMENT), knowledgeBaseIds (RAG), enabledTools (names to enable within the source). For a RAG grant, omitting enabledTools defaults to search_knowledge (the knowledge base would otherwise be granted but unreachable). Previews current vs next and applies NOTHING unless dry_run is false.",
        inputSchema: {
          agent_id: z.string(),
          grants: z.array(
            z.object({
              source: z.enum([
                "NATIVE",
                "RAG",
                "HTTP",
                "MCP",
                "INTEGRATION",
                "DOCUMENT",
              ]),
              toolDefinitionId: z.string().nullable().optional(),
              mcpServerConnectionId: z.string().nullable().optional(),
              integrationInstanceId: z.string().nullable().optional(),
              documentTemplateId: z.string().nullable().optional(),
              knowledgeBaseIds: z.array(z.string()).optional(),
              enabledTools: z.array(z.string()).optional(),
            }),
          ),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          agent_id: string;
          grants: Array<{
            source: string;
            toolDefinitionId?: string | null;
            mcpServerConnectionId?: string | null;
            integrationInstanceId?: string | null;
            documentTemplateId?: string | null;
            knowledgeBaseIds?: string[];
            enabledTools?: string[];
          }>;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await agentToolsSet(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "tool_create",
      {
        description:
          'Create an HTTP tool definition. Previews the normalized input and creates NOTHING unless dry_run is false. input_schema is a compact field map — {"field": {"type": "string"|"integer"|"number"|"boolean"|"enum"|"array"|"object", "required"?: true, "description"?: "...", "enumValues"?: [...], "itemType"?: "..."}} — standard JSON Schema ({"properties": ..., "required": [...]}) is also accepted and converted to that shape. Reference a field as {{field}} inside url_template, query values, headers and the body; {{secret}} injects the credential and context vars like {{conversation_id}}/{{contact_name}} also resolve. body is {"mode":"kv","rows":[{"key":…,"value":…}]} for a flat payload or {"mode":"raw","raw":"…"} for anything else — write a NESTED payload with raw; an object of your own keys is refused, because it is not a template and would be dropped (empty/absent keeps the legacy assembly from the declared fields). Single-brace {field} is normalized to {{field}} when it matches a declared field or context var; the dry-run preview reports conversions and unrecognized placeholders as warnings. credential_ref accepts a vault entry NAME (resolved server-side; never a raw secret). allowed_hosts is the SSRF allowlist.',
        inputSchema: {
          name: z.string(),
          label: z.string().optional(),
          url_template: z.string(),
          allowed_hosts: z.array(z.string()),
          method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
          description: z.string().nullable().optional(),
          headers: z.record(z.string(), z.unknown()).optional(),
          input_schema: z.record(z.string(), z.unknown()).optional(),
          output_schema: z.record(z.string(), z.unknown()).optional(),
          query: z.record(z.string(), z.unknown()).optional(),
          body: z.record(z.string(), z.unknown()).optional(),
          credential_ref: z.string().nullable().optional(),
          enabled: z.boolean().optional(),
          expected_statuses: z
            .array(z.number().int())
            .optional()
            .describe(
              "HTTP statuses this tool treats as ordinary results instead of integration failures (e.g. [404] where 'not found' is data). The model receives the same 'HTTP <status>' text either way; only the log level and the alert dispatch change. Empty keeps every non-2xx a failure.",
            ),
          ack_enabled: z.boolean().optional(),
          ack_message: z.string().nullable().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          name: string;
          label?: string;
          url_template: string;
          allowed_hosts: string[];
          method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
          description?: string | null;
          headers?: Record<string, unknown>;
          input_schema?: Record<string, unknown>;
          output_schema?: Record<string, unknown>;
          query?: Record<string, unknown>;
          body?: Record<string, unknown>;
          credential_ref?: string | null;
          enabled?: boolean;
          expected_statuses?: number[];
          ack_enabled?: boolean;
          ack_message?: string | null;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await toolCreate(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "tool_update",
      {
        description:
          'Update an HTTP tool definition. Previews a diff and applies NOTHING unless dry_run is false. Same authoring contract as tool_create: input_schema is the compact field map (standard JSON Schema is accepted and converted), fields are referenced as {{field}} in url_template/query/headers/body, body is {"mode":"kv","rows":[…]} or {"mode":"raw","raw":"…"} (nested payloads go in raw), and single-brace {field} is normalized when it matches a declared field or context var — the dry-run diff shows the canonical form plus warnings. credential_ref accepts a vault entry NAME (null clears it).',
        inputSchema: {
          tool_id: z.string(),
          name: z.string().optional(),
          label: z.string().optional(),
          url_template: z.string().optional(),
          allowed_hosts: z.array(z.string()).optional(),
          method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
          description: z.string().nullable().optional(),
          headers: z.record(z.string(), z.unknown()).optional(),
          input_schema: z.record(z.string(), z.unknown()).optional(),
          output_schema: z.record(z.string(), z.unknown()).optional(),
          query: z.record(z.string(), z.unknown()).optional(),
          body: z.record(z.string(), z.unknown()).optional(),
          credential_ref: z.string().nullable().optional(),
          enabled: z.boolean().optional(),
          expected_statuses: z
            .array(z.number().int())
            .optional()
            .describe(
              "HTTP statuses this tool treats as ordinary results instead of integration failures (e.g. [404] where 'not found' is data). The model receives the same 'HTTP <status>' text either way; only the log level and the alert dispatch change. Empty keeps every non-2xx a failure.",
            ),
          ack_enabled: z.boolean().optional(),
          ack_message: z.string().nullable().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          tool_id: string;
          name?: string;
          label?: string;
          url_template?: string;
          allowed_hosts?: string[];
          method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
          description?: string | null;
          headers?: Record<string, unknown>;
          input_schema?: Record<string, unknown>;
          output_schema?: Record<string, unknown>;
          query?: Record<string, unknown>;
          body?: Record<string, unknown>;
          credential_ref?: string | null;
          enabled?: boolean;
          expected_statuses?: number[];
          ack_enabled?: boolean;
          ack_message?: string | null;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await toolUpdate(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "tool_delete",
      {
        description:
          "Delete an HTTP tool definition. Previews the target and deletes NOTHING unless dry_run is false.",
        inputSchema: { tool_id: z.string(), dry_run: z.boolean().optional() },
      },
      async (args: { tool_id: string; dry_run?: boolean }, eff) =>
        writeContent(await toolDelete(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "document_template_create",
      {
        description:
          'Create a document template (quote, proposal, receipt, service order) that an agent can issue and attach to a reply. Previews by RENDERING the document and creates NOTHING unless dry_run is false. Call document_template_schema first for the exact shape of blocks/fields/style; a property outside it is REFUSED by name, never ignored — this description carries only what that cannot tell you. Pass `starter` ("quote"|"proposal"|"receipt", see document_starters_list) to begin from a ready-made template and override what you need; that is the cheapest way in. `blocks` lays the document out (header, text, fields, lineItems, totals, divider); `fields` declares what the AGENT fills at issue time, and becomes the argument list of the tool that agent gets. Rules that REFUSE the call: a field name may not start with company_, empresa_, doc_ or documento_ (those already resolve to the letterhead or to the document itself); a lineItems or totals block may only point at a field of type lineItems; and any {{token}} naming neither a declared field nor a reserved name is refused, because it would render as a blank space in a document the customer keeps. totals computes its own arithmetic from the line items — never ask a model for a sum, and never declare a field to hold one. Text blocks take **bold**, *italic* and "- " bullets and nothing else; anything richer renders as its own source. The letterhead (name, tax id, address, logo) comes from the tenant company profile, not from here.',
        inputSchema: {
          name: z.string().optional(),
          slug: z.string().optional(),
          description: z.string().nullable().optional(),
          blocks: z.array(z.record(z.string(), z.unknown())).optional(),
          fields: z.array(z.record(z.string(), z.unknown())).optional(),
          style: z.record(z.string(), z.unknown()).optional(),
          number_prefix: z.string().nullable().optional(),
          enabled: z.boolean().optional(),
          starter: z.string().optional(),
          locale: z.enum(["pt-BR", "en-US"]).optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: DocumentTemplateWriteArgs, eff) =>
        writeContent(await documentTemplateCreate(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "document_template_update",
      {
        description:
          "Patch a document template; omitted fields keep their value. blocks/fields/style take the shapes document_template_schema publishes, and sending either blocks or fields re-validates BOTH — half the rules are about how the two refer to each other. Previews by rendering the result and changes NOTHING unless dry_run is false.",
        inputSchema: {
          document_template_id: z.string(),
          name: z.string().optional(),
          slug: z.string().optional(),
          description: z.string().nullable().optional(),
          blocks: z.array(z.record(z.string(), z.unknown())).optional(),
          fields: z.array(z.record(z.string(), z.unknown())).optional(),
          style: z.record(z.string(), z.unknown()).optional(),
          number_prefix: z.string().nullable().optional(),
          enabled: z.boolean().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: DocumentTemplateWriteArgs & { document_template_id: string },
        eff,
      ) => writeContent(await documentTemplateUpdate(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "document_template_delete",
      {
        description:
          "Delete a document template. Previews the target and deletes NOTHING unless dry_run is false. Documents already issued from it keep their own frozen copy and stay readable.",
        inputSchema: {
          document_template_id: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: { document_template_id: string; dry_run?: boolean }, eff) =>
        writeContent(await documentTemplateDelete(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "mcp_connection_create",
      {
        description:
          "Create an outbound MCP server connection. Previews the input and creates NOTHING unless dry_run is false. transport is streamableHttp/sse (needs url) or stdio (needs command). credential_ref accepts a vault entry NAME (resolved server-side).",
        inputSchema: {
          name: z.string(),
          transport: z.enum(["streamableHttp", "sse", "stdio"]),
          url: z.string().nullable().optional(),
          command: z.string().nullable().optional(),
          credential_ref: z.string().nullable().optional(),
          enabled: z.boolean().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          name: string;
          transport: "streamableHttp" | "sse" | "stdio";
          url?: string | null;
          command?: string | null;
          credential_ref?: string | null;
          enabled?: boolean;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await mcpConnectionCreate(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "mcp_connection_update",
      {
        description:
          "Update an outbound MCP server connection. Previews a diff and applies NOTHING unless dry_run is false. credential_ref accepts a vault entry NAME (null clears it).",
        inputSchema: {
          connection_id: z.string(),
          name: z.string().optional(),
          transport: z.enum(["streamableHttp", "sse", "stdio"]).optional(),
          url: z.string().nullable().optional(),
          command: z.string().nullable().optional(),
          credential_ref: z.string().nullable().optional(),
          enabled: z.boolean().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          connection_id: string;
          name?: string;
          transport?: "streamableHttp" | "sse" | "stdio";
          url?: string | null;
          command?: string | null;
          credential_ref?: string | null;
          enabled?: boolean;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await mcpConnectionUpdate(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "mcp_connection_delete",
      {
        description:
          "Delete an outbound MCP server connection. Previews the target and deletes NOTHING unless dry_run is false.",
        inputSchema: {
          connection_id: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: { connection_id: string; dry_run?: boolean }, eff) =>
        writeContent(await mcpConnectionDelete(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "mcp_connection_discover",
      {
        description:
          "Connect to a remote MCP server (using the connection's stored credential, resolved server-side) and list the tool names it exposes. Read-only; runs immediately.",
        inputSchema: { connection_id: z.string() },
      },
      async (args: { connection_id: string }, eff) =>
        writeContent(await mcpConnectionDiscover(eff, args)),
    );

    // ── inbox binding + sync (mcp:write; dry-run by default + audit). Chatwoot SERVER + ACCOUNT
    // management (connect / token / probe / assign / disconnect) lives in the mcp:admin block below:
    // the shared-token probe would otherwise let a tenant admin enumerate other tenants' accounts on
    // a shared server. ──

    registerTenantTool(
      server,
      principal,
      "instance_sync_inboxes",
      {
        description:
          "Reconcile the local inbox mirror with the Chatwoot account (creates/updates Inbox rows). Calls Chatwoot. Previews a note and syncs NOTHING unless dry_run is false.",
        inputSchema: {
          instance_id: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: { instance_id: string; dry_run?: boolean }, eff) =>
        writeContent(await instanceSyncInboxes(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "inbox_bind",
      {
        description:
          "Bind an inbox to an agent (agent_id) or unbind it (agent_id null). Binding provisions/connects the agent's bot on Chatwoot. Previews current vs new and applies NOTHING unless dry_run is false.",
        inputSchema: {
          inbox_id: z.string(),
          agent_id: z.string().nullable().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          inbox_id: string;
          agent_id?: string | null;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await inboxBind(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "inbox_remove",
      {
        description:
          "Remove the LOCAL mirror of an inbox that was deleted in Chatwoot. Refused while the inbox still exists there. Previews whether Chatwoot says it is gone and applies NOTHING unless dry_run is false.",
        inputSchema: {
          inbox_id: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: { inbox_id: string; dry_run?: boolean }, eff) =>
        writeContent(await inboxRemove(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "inbox_reconnect",
      {
        description:
          "Re-provision an inbox's bot on Chatwoot (heals a bot removed out of band). Calls Chatwoot. Previews a note and acts ONLY when dry_run is false.",
        inputSchema: {
          inbox_id: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: { inbox_id: string; dry_run?: boolean }, eff) =>
        writeContent(await inboxReconnect(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "inbox_reconcile",
      {
        description:
          "Check every bound inbox's bot against Chatwoot and re-provision missing ones. Calls Chatwoot. Previews a note and acts ONLY when dry_run is false.",
        inputSchema: { dry_run: z.boolean().optional() },
      },
      async (args: { dry_run?: boolean }, eff) =>
        writeContent(await inboxReconcile(eff, args)),
    );

    // ── outbound webhooks + alert channels + integrations (mcp:write; EXTERNAL destinations) ──

    registerTenantTool(
      server,
      principal,
      "webhook_create",
      {
        description:
          "Register an outbound webhook subscription to an EXTERNAL url for the given events (see webhook_events_list). secret_ref is a vault entry NAME holding the HMAC signing secret (resolved server-side). Previews and creates NOTHING unless dry_run is false.",
        inputSchema: {
          url: z.string(),
          events: z.array(z.string()),
          secret_ref: z.string().nullable().optional(),
          enabled: z.boolean().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          url: string;
          events: string[];
          secret_ref?: string | null;
          enabled?: boolean;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await webhookCreate(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "webhook_update",
      {
        description:
          "Update an outbound webhook subscription. secret_ref is a vault entry NAME (null clears it). Previews a diff and applies NOTHING unless dry_run is false.",
        inputSchema: {
          webhook_id: z.string(),
          url: z.string().optional(),
          events: z.array(z.string()).optional(),
          secret_ref: z.string().nullable().optional(),
          enabled: z.boolean().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          webhook_id: string;
          url?: string;
          events?: string[];
          secret_ref?: string | null;
          enabled?: boolean;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await webhookUpdate(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "webhook_delete",
      {
        description:
          "Delete an outbound webhook subscription. Previews the target and deletes NOTHING unless dry_run is false.",
        inputSchema: {
          webhook_id: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: { webhook_id: string; dry_run?: boolean }, eff) =>
        writeContent(await webhookDelete(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "webhook_delivery_requeue",
      {
        description:
          "Put a DEAD outbound webhook delivery back in the worker queue: status returns to PENDING and attempts resets to 0, so the full retry ladder runs again. Only DEAD is accepted — any other status is refused, naming it. Previews the row and changes NOTHING unless dry_run is false.",
        inputSchema: {
          delivery_id: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: { delivery_id: string; dry_run?: boolean }, eff) =>
        writeContent(await webhookDeliveryRequeue(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "webhook_test",
      {
        description:
          "Send a signed test event to a webhook's EXTERNAL destination and return the delivery status (ok/status/signed). Sends a real request; runs immediately.",
        inputSchema: { webhook_id: z.string() },
      },
      async (args: { webhook_id: string }, eff) =>
        writeContent(await webhookTest(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "alert_channel_create",
      {
        description:
          "Create a flow-log alert channel (discord or generic webhook). url_ref is a vault entry NAME holding the FULL token-bearing destination URL (resolved server-side; never passed raw). secret_ref optionally holds an HMAC signing secret (vault NAME). min_level is info/warn/error; stages restrict which flow stages alert. Previews and creates NOTHING unless dry_run is false.",
        inputSchema: {
          name: z.string(),
          type: z.enum(["discord", "webhook"]),
          url_ref: z.string(),
          min_level: z.enum(["info", "warn", "error"]).optional(),
          stages: z.array(z.string()).optional(),
          secret_ref: z.string().nullable().optional(),
          enabled: z.boolean().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          name: string;
          type: "discord" | "webhook";
          url_ref: string;
          min_level?: "info" | "warn" | "error";
          stages?: string[];
          secret_ref?: string | null;
          enabled?: boolean;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await alertChannelCreate(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "alert_channel_update",
      {
        description:
          "Update a flow-log alert channel. url_ref rotates the token-bearing URL (vault NAME; never raw, never in the diff). secret_ref is a vault NAME (null clears it). Previews and applies NOTHING unless dry_run is false.",
        inputSchema: {
          channel_id: z.string(),
          name: z.string().optional(),
          type: z.enum(["discord", "webhook"]).optional(),
          url_ref: z.string().optional(),
          min_level: z.enum(["info", "warn", "error"]).optional(),
          stages: z.array(z.string()).optional(),
          secret_ref: z.string().nullable().optional(),
          enabled: z.boolean().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          channel_id: string;
          name?: string;
          type?: "discord" | "webhook";
          url_ref?: string;
          min_level?: "info" | "warn" | "error";
          stages?: string[];
          secret_ref?: string | null;
          enabled?: boolean;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await alertChannelUpdate(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "alert_channel_delete",
      {
        description:
          "Delete a flow-log alert channel. Previews the target and deletes NOTHING unless dry_run is false.",
        inputSchema: {
          channel_id: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: { channel_id: string; dry_run?: boolean }, eff) =>
        writeContent(await alertChannelDelete(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "integration_create",
      {
        description:
          "Instantiate an integration from the catalog (see integration_catalog). credential_ref/inbound_secret_ref are vault entry NAMES (resolved server-side). The inbound route token is a generated secret: it is NOT returned here — the response gives a console URL to reveal it. Previews and creates NOTHING unless dry_run is false.",
        inputSchema: {
          catalog_type: z.string(),
          name: z.string(),
          config: z.record(z.string(), z.unknown()).optional(),
          credential_ref: z.string().nullable().optional(),
          inbound_auth_strategy: z
            .enum(["NONE", "STATIC_HEADER", "HMAC_SHA256"])
            .optional(),
          inbound_secret_ref: z.string().nullable().optional(),
          enabled: z.boolean().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          catalog_type: string;
          name: string;
          config?: Record<string, unknown>;
          credential_ref?: string | null;
          inbound_auth_strategy?: "NONE" | "STATIC_HEADER" | "HMAC_SHA256";
          inbound_secret_ref?: string | null;
          enabled?: boolean;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await integrationCreate(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "integration_update",
      {
        description:
          "Update an integration instance (name, enabled, config, credentials, inbound auth). credential_ref/inbound_secret_ref are vault entry NAMES (null clears). Previews a diff and applies NOTHING unless dry_run is false. The `config` shape depends on catalogType. GOOGLE_CALENDAR: {calendarIds(allowlist of calendar ids the agent may operate on; empty ⇒ the tools refuse until one is picked), blockingCalendarIds(calendars only RESPECTED by availability, never operated on, e.g. holidays/closures; EVERY event on them blocks slots; max 10, availability refuses beyond that), calendarLabels(map of id→friendly name), timeZone(IANA, e.g. America/Sao_Paulo), businessHoursId(the BusinessHours profile bounding bookable slots; empty ⇒ no time-of-day limit), slotDurationMinutes, slotGranularityMinutes, createMeetLink(default true: calendar_create_event asks Google for a Meet room and returns its meetLink; set false when the calendar is a pure busy-block), appointmentReminders:{enabled,offsetsHours(array of hours-before-start, e.g. [24,1]),askConfirmationOnLast}}. GOOGLE_DRIVE: {folderId, folderName}.",
        inputSchema: {
          integration_id: z.string(),
          name: z.string().optional(),
          config: z.record(z.string(), z.unknown()).optional(),
          credential_ref: z.string().nullable().optional(),
          inbound_auth_strategy: z
            .enum(["NONE", "STATIC_HEADER", "HMAC_SHA256"])
            .optional(),
          inbound_secret_ref: z.string().nullable().optional(),
          enabled: z.boolean().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          integration_id: string;
          name?: string;
          config?: Record<string, unknown>;
          credential_ref?: string | null;
          inbound_auth_strategy?: "NONE" | "STATIC_HEADER" | "HMAC_SHA256";
          inbound_secret_ref?: string | null;
          enabled?: boolean;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await integrationUpdate(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "integration_delete",
      {
        description:
          "Delete an integration instance. Previews the target and deletes NOTHING unless dry_run is false.",
        inputSchema: {
          integration_id: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: { integration_id: string; dry_run?: boolean }, eff) =>
        writeContent(await integrationDelete(eff, args)),
    );

    // ── knowledge bases + documents + approvals (mcp:write; dry-run by default + audit) ──

    registerTenantTool(
      server,
      principal,
      "knowledge_create",
      {
        description:
          "Create a knowledge base. embedding_model defaults to the tenant's configured model. Previews and creates NOTHING unless dry_run is false.",
        inputSchema: {
          name: z.string(),
          description: z.string().optional(),
          embedding_model: z.string().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          name: string;
          description?: string;
          embedding_model?: string;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await knowledgeCreate(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "knowledge_update",
      {
        description:
          "Update a knowledge base (name, description, chunk_size, chunk_overlap). Previews a diff and applies NOTHING unless dry_run is false.",
        inputSchema: {
          knowledge_base_id: z.string(),
          name: z.string().optional(),
          description: z.string().nullable().optional(),
          chunk_size: z.number().int().optional(),
          chunk_overlap: z.number().int().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          knowledge_base_id: string;
          name?: string;
          description?: string | null;
          chunk_size?: number;
          chunk_overlap?: number;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await knowledgeUpdate(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "knowledge_delete",
      {
        description:
          "Delete a knowledge base (and its documents/chunks by cascade). Previews the target and deletes NOTHING unless dry_run is false.",
        inputSchema: {
          knowledge_base_id: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: { knowledge_base_id: string; dry_run?: boolean }, eff) =>
        writeContent(await knowledgeDelete(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "knowledge_document_create",
      {
        description:
          "Ingest a TEXT document into a knowledge base (binary upload stays UI-only). The document is queued for async embedding (lands PENDING). Previews and creates NOTHING unless dry_run is false.",
        inputSchema: {
          knowledge_base_id: z.string(),
          title: z.string(),
          text: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          knowledge_base_id: string;
          title: string;
          text: string;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await knowledgeDocumentCreate(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "knowledge_document_delete",
      {
        description:
          "Delete a knowledge-base document (and its chunks). Previews the target and deletes NOTHING unless dry_run is false.",
        inputSchema: {
          document_id: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: { document_id: string; dry_run?: boolean }, eff) =>
        writeContent(await knowledgeDocumentDelete(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "knowledge_document_retry",
      {
        description:
          "Re-queue a FAILED document for embedding. Previews and acts ONLY when dry_run is false.",
        inputSchema: {
          document_id: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: { document_id: string; dry_run?: boolean }, eff) =>
        writeContent(await knowledgeDocumentRetry(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "knowledge_reindex",
      {
        description:
          "Bulk-index a knowledge base: re-queue every not-yet-indexed (UNINDEXED) document in one call — the 'index all' after an agent import. Set include_failed to also recover FAILED docs. If the tenant's embedding credential is unconfigured or its secret is not filled yet, nothing is queued and the result is `blocked` (with a fillAt deeplink for a pending credential) — fix that first, then re-run. Previews (counts + any block) and acts ONLY when dry_run is false.",
        inputSchema: {
          knowledge_base_id: z.string(),
          include_failed: z.boolean().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          knowledge_base_id: string;
          include_failed?: boolean;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await knowledgeReindex(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "knowledge_approve",
      {
        description:
          "Approve a pending knowledge suggestion: creates a document and queues embedding. Previews the item and acts ONLY when dry_run is false.",
        inputSchema: {
          approval_id: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: { approval_id: string; dry_run?: boolean }, eff) =>
        writeContent(await knowledgeApprove(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "knowledge_reject",
      {
        description:
          "Reject a pending knowledge suggestion. Previews the item and acts ONLY when dry_run is false.",
        inputSchema: {
          approval_id: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: { approval_id: string; dry_run?: boolean }, eff) =>
        writeContent(await knowledgeReject(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "knowledge_edit",
      {
        description:
          "Edit a pending knowledge suggestion (title, content, rationale) before approving. Previews and applies NOTHING unless dry_run is false.",
        inputSchema: {
          approval_id: z.string(),
          title: z.string().optional(),
          content: z.string().optional(),
          rationale: z.string().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          approval_id: string;
          title?: string;
          content?: string;
          rationale?: string;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await knowledgeEdit(eff, args)),
    );

    // ── experiments + business hours + tenant settings + API keys (mcp:write) ──

    registerTenantTool(
      server,
      principal,
      "experiment_create",
      {
        description:
          "Create an A/B prompt experiment. variants is an array of { key, weight?, system_prompt? }. agent_id optionally scopes it. Previews and creates NOTHING unless dry_run is false.",
        inputSchema: {
          name: z.string(),
          agent_id: z.string().nullable().optional(),
          variants: z.array(
            z.object({
              key: z.string(),
              weight: z.number().optional(),
              system_prompt: z.string().optional(),
            }),
          ),
          enabled: z.boolean().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          name: string;
          agent_id?: string | null;
          variants: Array<{
            key: string;
            weight?: number;
            system_prompt?: string;
          }>;
          enabled?: boolean;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await experimentCreate(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "experiment_update",
      {
        description:
          "Update an A/B prompt experiment (name, agent_id, variants, enabled). Previews and applies NOTHING unless dry_run is false.",
        inputSchema: {
          experiment_id: z.string(),
          name: z.string().optional(),
          agent_id: z.string().nullable().optional(),
          variants: z
            .array(
              z.object({
                key: z.string(),
                weight: z.number().optional(),
                system_prompt: z.string().optional(),
              }),
            )
            .optional(),
          enabled: z.boolean().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          experiment_id: string;
          name?: string;
          agent_id?: string | null;
          variants?: Array<{
            key: string;
            weight?: number;
            system_prompt?: string;
          }>;
          enabled?: boolean;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await experimentUpdate(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "experiment_delete",
      {
        description:
          "Delete an A/B prompt experiment. Previews the target and deletes NOTHING unless dry_run is false.",
        inputSchema: {
          experiment_id: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: { experiment_id: string; dry_run?: boolean }, eff) =>
        writeContent(await experimentDelete(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "business_hours_create",
      {
        description:
          "Create a business-hours profile. windows is an array of { day (0-6), start (HH:mm), end (HH:mm) }. exceptions is an array of date overrides that REPLACE the weekly grid on the dates they match: { date (YYYY-MM-DD), dateEnd (optional, inclusive span end), recurring (optional, matches the same month-day every year), label, ranges (array of { start, end }; empty = closed all day) }. Previews and creates NOTHING unless dry_run is false.",
        inputSchema: {
          name: z.string(),
          timezone: z.string().optional(),
          windows: z
            .array(
              z.object({
                day: z.number().int(),
                start: z.string(),
                end: z.string(),
              }),
            )
            .optional(),
          exceptions: z
            .array(
              z.object({
                date: z.string(),
                dateEnd: z.string().optional(),
                recurring: z.boolean().optional(),
                label: z.string().optional(),
                ranges: z.array(
                  z.object({ start: z.string(), end: z.string() }),
                ),
              }),
            )
            .optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          name: string;
          timezone?: string;
          windows?: Array<{ day: number; start: string; end: string }>;
          exceptions?: Array<{
            date: string;
            dateEnd?: string;
            recurring?: boolean;
            label?: string;
            ranges: Array<{ start: string; end: string }>;
          }>;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await businessHoursCreate(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "business_hours_update",
      {
        description:
          "Update a business-hours profile (name, timezone, windows, exceptions). exceptions is an array of date overrides that REPLACE the weekly grid on the dates they match: { date (YYYY-MM-DD), dateEnd (optional, inclusive span end), recurring (optional, matches the same month-day every year), label, ranges (array of { start, end }; empty = closed all day) }. Previews a diff and applies NOTHING unless dry_run is false.",
        inputSchema: {
          business_hours_id: z.string(),
          name: z.string().optional(),
          timezone: z.string().optional(),
          windows: z
            .array(
              z.object({
                day: z.number().int(),
                start: z.string(),
                end: z.string(),
              }),
            )
            .optional(),
          exceptions: z
            .array(
              z.object({
                date: z.string(),
                dateEnd: z.string().optional(),
                recurring: z.boolean().optional(),
                label: z.string().optional(),
                ranges: z.array(
                  z.object({ start: z.string(), end: z.string() }),
                ),
              }),
            )
            .optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          business_hours_id: string;
          name?: string;
          timezone?: string;
          windows?: Array<{ day: number; start: string; end: string }>;
          exceptions?: Array<{
            date: string;
            dateEnd?: string;
            recurring?: boolean;
            label?: string;
            ranges: Array<{ start: string; end: string }>;
          }>;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await businessHoursUpdate(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "business_hours_delete",
      {
        description:
          "Delete a business-hours profile. Previews the target and deletes NOTHING unless dry_run is false.",
        inputSchema: {
          business_hours_id: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: { business_hours_id: string; dry_run?: boolean }, eff) =>
        writeContent(await businessHoursDelete(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "tenant_settings_update",
      {
        description:
          "Update the tenant's embedding and/or Langfuse settings. credential_ref values are vault entry NAMES (resolved server-side; null clears). embedding accepts { credential_ref }; langfuse accepts { enabled, credential_ref, send_content, debug }. debug attaches the full tool schemas to every trace (heavy; tool names are always sent). Previews and applies NOTHING unless dry_run is false.",
        inputSchema: {
          embedding: z
            .object({ credential_ref: z.string().nullable().optional() })
            .optional(),
          langfuse: z
            .object({
              enabled: z.boolean().optional(),
              credential_ref: z.string().nullable().optional(),
              send_content: z.boolean().optional(),
              debug: z.boolean().optional(),
            })
            .optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          embedding?: { credential_ref?: string | null };
          langfuse?: {
            enabled?: boolean;
            credential_ref?: string | null;
            send_content?: boolean;
            debug?: boolean;
          };
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await tenantSettingsUpdate(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "langfuse_connect",
      {
        description:
          "Provision-and-wire Langfuse tracing in one step: stores the project API key pair (public_key + secret_key — the RAW keys the agent generated and seeded into Langfuse via LANGFUSE_INIT, an infra secret the caller holds) as a FILLED kind:langfuse vault credential and enables tracing on the tenant. Idempotent (a re-connect updates the stored keys). The keys are used in-band and kept out of the audit. Previews and applies NOTHING unless dry_run is false.",
        inputSchema: {
          public_key: z.string(),
          secret_key: z.string(),
          base_url: z.string(),
          name: z.string().optional(),
          enabled: z.boolean().optional(),
          send_content: z.boolean().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          public_key: string;
          secret_key: string;
          base_url: string;
          name?: string;
          enabled?: boolean;
          send_content?: boolean;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await langfuseConnect(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "api_key_revoke",
      {
        description:
          "Revoke a tenant API key immediately (it stops authenticating). Previews and acts ONLY when dry_run is false. Creating keys stays in the console (the plaintext token cannot cross the model).",
        inputSchema: {
          api_key_id: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: { api_key_id: string; dry_run?: boolean }, eff) =>
        writeContent(await apiKeyRevoke(eff, args)),
    );

    // ── conversation control (mcp:write; EXTERNAL effect — sends real messages / changes state) ──

    registerTenantTool(
      server,
      principal,
      "conversation_reply",
      {
        description:
          "Reply in a conversation. dry_run (default) previews the EXACT text that would be sent; with dry_run false it sends a real message to the customer (private true posts an internal note instead). Not reversible.",
        inputSchema: {
          conversation_id: z.string(),
          content: z.string(),
          private: z.boolean().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          conversation_id: string;
          content: string;
          private?: boolean;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await conversationReply(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "conversation_handoff",
      {
        description:
          "Hand a conversation off to a human (optionally assignee_id; status → open, bot stops). Calls Chatwoot. Previews and acts ONLY when dry_run is false.",
        inputSchema: {
          conversation_id: z.string(),
          assignee_id: z.number().int().nullable().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          conversation_id: string;
          assignee_id?: number | null;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await conversationHandoff(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "conversation_return",
      {
        description:
          "Return a conversation to the bot (unassign human, status → pending). Calls Chatwoot. Previews and acts ONLY when dry_run is false.",
        inputSchema: {
          conversation_id: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: { conversation_id: string; dry_run?: boolean }, eff) =>
        writeContent(await conversationReturn(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "conversation_status",
      {
        description:
          "Set a conversation's status (open/pending/resolved) in Chatwoot. Previews current → new and acts ONLY when dry_run is false.",
        inputSchema: {
          conversation_id: z.string(),
          status: z.enum(["open", "pending", "resolved"]),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          conversation_id: string;
          status: "open" | "pending" | "resolved";
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await conversationStatus(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "conversation_reengage",
      {
        description:
          "Run the agent on the conversation's unanswered tail; it may SEND a proactive message to the customer. Calls the model + Chatwoot; not reversible. Previews and acts ONLY when dry_run is false.",
        inputSchema: {
          conversation_id: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: { conversation_id: string; dry_run?: boolean }, eff) =>
        writeContent(await conversationReengage(eff, args)),
    );
  }

  // mcp:admin gates fleet/global writes (not per-agent config). Only SUPER_ADMIN tokens ever hold it
  // (scopesForRole), so this is the privileged tier above ordinary mcp:write.
  if (hasScope(principal, "mcp:admin")) {
    server.registerTool(
      "branding_set",
      {
        description:
          "Set the GLOBAL app identity (SUPER_ADMIN token only). Previews a diff and applies NOTHING unless dry_run is false. brand_name is the white-label display name (title + auth footer; null = default). color_mode SIMPLE uses brand_color (a #rrggbb hex); ADVANCED uses the tokens_light/tokens_dark maps. site_url (absolute http(s) URL) and support_email replace the sidebar-footer defaults (null/empty = back to the default); hide_github_link is a boolean — true removes the footer GitHub entry, false restores it. Logo and favicon are uploaded via branding_asset_set (or cropped in the UI at /admin/branding).",
        inputSchema: {
          brand_name: z.string().nullable().optional(),
          color_mode: z.enum(["SIMPLE", "ADVANCED"]).optional(),
          brand_color: z.string().nullable().optional(),
          tokens_light: z.record(z.string(), z.unknown()).optional(),
          tokens_dark: z.record(z.string(), z.unknown()).optional(),
          site_url: z.string().nullable().optional(),
          support_email: z.string().nullable().optional(),
          hide_github_link: z.boolean().optional(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: {
        brand_name?: string | null;
        color_mode?: "SIMPLE" | "ADVANCED";
        brand_color?: string | null;
        tokens_light?: Record<string, unknown>;
        tokens_dark?: Record<string, unknown>;
        site_url?: string | null;
        support_email?: string | null;
        hide_github_link?: boolean;
        dry_run?: boolean;
      }) => writeContent(await brandingSet(principal, args)),
    );

    server.registerTool(
      "branding_asset_set",
      {
        description:
          'Upload a GLOBAL branding asset — a logo or favicon image (SUPER_ADMIN token only). kind is "logo" or "favicon"; variant is "dark" or "light" (one variant is enough — the app falls back to the other per theme). content_base64 is the raw image bytes, base64-encoded (a data: URL prefix is tolerated); mime is one of image/png, image/jpeg, image/webp, image/svg+xml, image/x-icon. Per-kind size caps apply (logo 1 MB, favicon 512 KB). Previews metadata and writes NOTHING unless dry_run is false. Cropping/preview is in the UI at /admin/branding.',
        inputSchema: {
          kind: z.enum(["logo", "favicon"]),
          variant: z.enum(["dark", "light"]),
          content_base64: z.string(),
          mime: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: {
        kind: "logo" | "favicon";
        variant: "dark" | "light";
        content_base64: string;
        mime: string;
        dry_run?: boolean;
      }) => writeContent(await brandingAssetSet(principal, args)),
    );

    // ── Chatwoot SERVER + ACCOUNT management (mcp:admin; super-admin only). A server can back many
    // tenants, so its admin-token account probe would leak other clients' accounts to a tenant admin
    // — these stay admin-gated. The super-admin targets a tenant via the token's tenant. ──

    registerTenantTool(
      server,
      principal,
      "deployment_connect",
      {
        description:
          "Register a tenant's Chatwoot deployment from a base URL + admin token (entered once; one deployment per tenant). admin_token is the RAW Chatwoot admin token (the caller already holds it, from provisioning or the user); it is used in-band and kept out of the audit. Validates the credentials by probing /profile and returns the reachable accounts. Previews and connects NOTHING unless dry_run is false.",
        inputSchema: {
          base_url: z.string(),
          admin_token: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (
        args: {
          base_url: string;
          admin_token: string;
          dry_run?: boolean;
        },
        eff,
      ) => writeContent(await deploymentConnect(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "deployment_rotate_token",
      {
        description:
          "Rotate the deployment's shared admin token. admin_token is the NEW token, raw (used in-band, kept out of the audit). Affects every account under the deployment. Previews and applies NOTHING unless dry_run is false.",
        inputSchema: {
          admin_token: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: { admin_token: string; dry_run?: boolean }, eff) =>
        writeContent(await deploymentRotateToken(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "deployment_list_accounts",
      {
        description:
          "List the accounts the deployment's STORED token can reach (no token re-entry). Read-only. SUPER_ADMIN only: on a shared server this is the whole roster.",
        inputSchema: {
          dry_run: z.boolean().optional(),
        },
      },
      async (args: { dry_run?: boolean }, eff) =>
        writeContent(await deploymentListAccounts(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "deployment_set_accounts",
      {
        description:
          "Set which accounts are connected to THIS tenant, as a diff: newly-selected accounts are connected (and their inboxes synced), de-selected active ones are soft-disconnected (history kept). An account already owned by another tenant is rejected. Calls Chatwoot. Previews and applies NOTHING unless dry_run is false.",
        inputSchema: {
          account_ids: z.array(z.number().int()),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: { account_ids: number[]; dry_run?: boolean }, eff) =>
        writeContent(await deploymentSetAccounts(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "instance_disconnect",
      {
        description:
          "Soft-disconnect ONE account: unbind its inboxes' agents and stop handling its traffic, keeping the conversation/analytics rows for history. Re-select it in deployment_set_accounts to reconnect. Previews and applies NOTHING unless dry_run is false.",
        inputSchema: {
          instance_id: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: { instance_id: string; dry_run?: boolean }, eff) =>
        writeContent(await instanceDisconnect(eff, args)),
    );

    registerTenantTool(
      server,
      principal,
      "instance_list_accounts",
      {
        description:
          "Probe a Chatwoot base URL for the accounts a token can see (discover accounts before deployment_connect). Stateless: admin_token is the raw token, used for the probe and never persisted.",
        inputSchema: {
          base_url: z.string(),
          admin_token: z.string(),
        },
      },
      async (args: { base_url: string; admin_token: string }, eff) =>
        writeContent(await instanceListAccounts(eff, args)),
    );

    // ── fleet: tenants across the whole instance (cross-tenant; SUPER_ADMIN only) ──

    server.registerTool(
      "tenant_list",
      {
        description:
          "List ALL tenants in the instance (id, name, slug, demoMode). Fleet-wide; SUPER_ADMIN only.",
        inputSchema: {},
      },
      async () => writeContent(await tenantList(principal)),
    );

    server.registerTool(
      "tenant_get",
      {
        description:
          "Get any tenant by id (cross-tenant). Fleet-wide; SUPER_ADMIN only.",
        inputSchema: { tenant_id: z.string() },
      },
      async (args: { tenant_id: string }) =>
        writeContent(await tenantGet(principal, args)),
    );

    server.registerTool(
      "tenant_create",
      {
        description:
          "Provision a NEW tenant (name + slug). slug is the stable URL/DNS-safe identifier. Previews and creates NOTHING unless dry_run is false. Fleet-wide; SUPER_ADMIN only.",
        inputSchema: {
          name: z.string(),
          slug: z.string(),
          dry_run: z.boolean().optional(),
        },
      },
      async (args: { name: string; slug: string; dry_run?: boolean }) =>
        writeContent(await tenantCreate(principal, args)),
    );
  }

  return server;
}

// Stateless JSON-RPC over the Web-standard streamable-HTTP transport: one server per request,
// connect, hand off the Request, return the Web Response (passthrough by Elysia).
export async function handleMcpRequest(
  req: Request,
  principal: VerifiedToken,
): Promise<Response> {
  const server = buildMcpServer(principal);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}
