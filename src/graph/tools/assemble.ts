import type { StructuredToolInterface } from "@langchain/core/tools";
import type { ScopedDb } from "@/lib/tenancy";
import type { DocumentField } from "@/modules/documents/blocks";
import { parseTemplateContent } from "@/modules/documents/validate";
import type { IntegrationSelection } from "@/modules/integrations/toolpacks";
import { isManagedOAuthKind } from "@/modules/vault/secret-types";
import {
  formatVaultRef,
  tryResolveVaultEntry,
  VAULT_REF_PREFIX,
} from "@/modules/vault/service";
import type { DocumentSelection } from "./documents";
import { buildHttpTool, type HttpToolDef } from "./http";
import type { McpSelection } from "./mcp";

// Per-agent tool assembly with fail-closed allowlists. The single source of truth is the
// agent_tool_selections table (one grant row per source). Native Chatwoot tools default to ALL
// when there is no NATIVE row or its allowlist is empty (they only act on the current
// conversation); HTTP/MCP/integration/RAG tools are fail-closed — a tool the agent was not granted
// is never exposed, and a new upstream tool is not auto-granted.

export interface RagConfig {
  tools: string[];
  knowledgeBaseIds: bigint[];
  // Name + description of the selected bases, surfaced in the search_knowledge tool description so the
  // agent knows WHAT it can look up (a single tool still searches across all of them at once). The id
  // backs the optional knowledge_base narrowing parameter (name -> id, names are not unique).
  knowledgeBases?: { id: bigint; name: string; description: string | null }[];
  // Optional grounding threshold (max cosine distance) sourced from agent.settings.grounding; the
  // RAG selection row has no column for it, so prepare.ts plumbs it in from the agent settings.
  maxDistance?: number;
}

export interface LoadedHttpToolDef {
  name: string;
  description: string | null;
  method: string;
  urlTemplate: string;
  allowedHosts: string[];
  headers: unknown;
  inputSchema: unknown;
  credentialRef: string | null;
  // The credential's predefined secret type (item 8), resolved from the vault entry. Drives
  // automatic auth injection (header/bearer/basic/query) so the operator need not hand-write the
  // header with {{secret}}. null/generic ⇒ no auto-injection (manual {{secret}} still works).
  credentialKind: string | null;
  // Header/query param name for `header`/`query` credential kinds (from VaultEntry.paramName).
  credentialParamName: string | null;
  // baseUrl from the vault entry. Used when urlTemplate is relative (starts with /) so the
  // credential carries both the auth secret and the server address.
  credentialBaseUrl: string | null;
  // Optional "I'll look into that…" ack posted to the customer before this (slow) tool runs.
  ackEnabled: boolean;
  ackMessage: string | null;
  // Query-string params (Record<string,string> templates), applied for any method (ToolDefinition.query).
  query: unknown;
  // Request body shape: { mode: "kv", rows } | { mode: "raw", raw } | legacy { mode: "fields" }.
  body: unknown;
  // HTTP statuses this tool declares as results rather than integration failures (issue #59).
  // Required, unlike on `HttpToolDef`: a turn gets its definitions from `loadToolSelections`, whose
  // Prisma `select` enumerates its columns, so an optional field here is one a future column can be
  // forgotten in — silently, since a missing column reads as `undefined` and normalizes to "declare
  // nothing". Keeping it required makes both the select and the mapping a compile error to skip.
  expectedStatuses: number[];
}

export interface AgentToolSelections {
  // undefined ⇒ all native tools (NO NATIVE row — the permissive default for legacy/new agents).
  // An explicit NATIVE row yields exactly its allowlist (an empty array ⇒ NO native tools), so the
  // editor can persist an explicit set, including "none". The tools only act on the current
  // conversation, which is why their default (absent row) is permissive.
  nativeToolsAllow?: string[];
  // undefined ⇒ no RAG (no RAG row, or an empty tool allowlist — fail-closed).
  ragConfig?: RagConfig;
  httpToolDefs: LoadedHttpToolDef[];
  mcpSelections: McpSelection[];
  integrationSelections: IntegrationSelection[];
  // Fail-closed like HTTP/MCP/integration/RAG: a document template the agent was not granted is
  // never exposed, so no agent gains a tool that hands out priced paperwork on upgrade.
  documentSelections: DocumentSelection[];
}

// Loads every tool grant for an agent in one scoped read (DB only — no network; MCP connect/
// discover and the toolpack build happen later, outside the tx). Resolves each MCP connection's
// vault credential here (still a scoped DB read). A grant whose source is disabled
// (ToolDefinition/connection/instance enabled=false) is skipped.
export async function loadToolSelections(
  db: ScopedDb,
  agentId: bigint,
): Promise<AgentToolSelections> {
  const rows = await db.agentToolSelection.findMany({
    where: { agentId },
    select: {
      source: true,
      enabledTools: true,
      knowledgeBaseIds: true,
      toolDefinition: {
        select: {
          name: true,
          description: true,
          method: true,
          urlTemplate: true,
          allowedHosts: true,
          headers: true,
          inputSchema: true,
          query: true,
          body: true,
          credentialRef: true,
          enabled: true,
          ackEnabled: true,
          ackMessage: true,
          expectedStatuses: true,
        },
      },
      mcpServerConnection: {
        select: {
          id: true,
          name: true,
          transport: true,
          url: true,
          command: true,
          credentialRef: true,
          enabled: true,
        },
      },
      integrationInstance: {
        select: {
          id: true,
          catalogType: true,
          config: true,
          credentialRef: true,
          enabled: true,
        },
      },
      documentTemplate: {
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          blocks: true,
          fields: true,
          // Selected only so the content check sees the whole template: the footer's tokens are
          // validated with the blocks' (see parseTemplateContent), and the tool itself renders
          // nothing — issuance loads the template again for that.
          style: true,
          enabled: true,
        },
      },
    },
  });

  const result: AgentToolSelections = {
    httpToolDefs: [],
    mcpSelections: [],
    integrationSelections: [],
    documentSelections: [],
  };

  for (const row of rows) {
    switch (row.source) {
      case "NATIVE":
        // Explicit row ⇒ exactly this set (empty ⇒ none, fail-closed). The absence of a row keeps
        // nativeToolsAllow undefined ⇒ all (handled by the default above).
        result.nativeToolsAllow = row.enabledTools;
        break;
      case "RAG":
        if (row.enabledTools.length > 0) {
          result.ragConfig = {
            tools: row.enabledTools,
            knowledgeBaseIds: row.knowledgeBaseIds,
          };
        }
        break;
      case "HTTP": {
        const td = row.toolDefinition;
        if (!td?.enabled) break;
        result.httpToolDefs.push({
          name: td.name,
          description: td.description,
          method: td.method,
          urlTemplate: td.urlTemplate,
          allowedHosts: td.allowedHosts,
          headers: td.headers,
          inputSchema: td.inputSchema,
          credentialRef: td.credentialRef,
          credentialKind: null, // resolved in a single batch after the loop
          credentialParamName: null, // resolved in a single batch after the loop
          credentialBaseUrl: null, // resolved in a single batch after the loop
          ackEnabled: td.ackEnabled,
          ackMessage: td.ackMessage,
          query: td.query,
          body: td.body,
          expectedStatuses: td.expectedStatuses,
        });
        break;
      }
      case "MCP": {
        const conn = row.mcpServerConnection;
        if (!conn?.enabled) break;
        let secret: string | null = null;
        let credentialBaseUrl: string | null = null;
        let credentialKind: string | null = null;
        let credentialParamName: string | null = null;
        if (conn.credentialRef) {
          const entry = await tryResolveVaultEntry<unknown>(
            db,
            conn.credentialRef,
          );
          credentialKind = entry?.kind ?? null;
          credentialParamName = entry?.paramName ?? null;
          credentialBaseUrl = entry?.baseUrl ?? null;
          // Managed-OAuth kinds (google_oauth, mcp_oauth) store a JSON object, not a string; their
          // access token is refreshed outside the tx in loadMcpToolsForAgent. Other kinds carry a
          // plain string secret.
          secret =
            !isManagedOAuthKind(credentialKind) &&
            typeof entry?.secret === "string"
              ? entry.secret
              : null;
        }
        result.mcpSelections.push({
          connId: conn.id,
          name: conn.name,
          transport: conn.transport,
          url: conn.url,
          command: conn.command,
          secret,
          credentialBaseUrl,
          credentialKind,
          credentialParamName,
          credentialRef: conn.credentialRef,
          enabledTools: row.enabledTools,
        });
        break;
      }
      case "INTEGRATION": {
        const inst = row.integrationInstance;
        if (!inst?.enabled) break;
        result.integrationSelections.push({
          instanceId: inst.id,
          catalogType: inst.catalogType,
          config: (inst.config ?? {}) as Record<string, unknown>,
          credentialRef: inst.credentialRef,
          enabledTools: row.enabledTools,
        });
        break;
      }
      case "DOCUMENT": {
        const tpl = row.documentTemplate;
        if (!tpl?.enabled) break;
        // A template whose content no longer parses is SKIPPED rather than exposed with an empty
        // argument list: a tool that accepts nothing and renders a blank document is worse for the
        // customer than a tool the agent does not have.
        const content = parseTemplateContent(tpl.blocks, tpl.fields, tpl.style);
        if (!content.ok) break;
        result.documentSelections.push({
          templateId: tpl.id,
          name: tpl.name,
          slug: tpl.slug,
          description: tpl.description,
          fields: content.content.fields as DocumentField[],
        });
        break;
      }
    }
  }

  // Name + description of the selected knowledge bases (one scoped read), surfaced in the
  // search_knowledge tool description so the agent knows what it can look up.
  if (result.ragConfig && result.ragConfig.knowledgeBaseIds.length > 0) {
    result.ragConfig.knowledgeBases = await db.knowledgeBase.findMany({
      where: { id: { in: result.ragConfig.knowledgeBaseIds } },
      select: { id: true, name: true, description: true },
      orderBy: { name: "asc" },
    });
  }

  // Resolve the predefined secret type (kind) of each HTTP tool's credential in one batch, so the
  // runtime can auto-inject the auth header/param (item 8) without the operator wiring {{secret}}.
  const refs = [
    ...new Set(
      result.httpToolDefs
        .map((d) => d.credentialRef)
        .filter((r): r is string => !!r),
    ),
  ];
  if (refs.length > 0) {
    // Stored tool credentialRefs are `vault:<id>`; resolve each to its secret type by id and key
    // the map by the ref string so the lookup matches what is stored on the tool.
    const ids: bigint[] = [];
    for (const r of refs) {
      if (r.startsWith(VAULT_REF_PREFIX)) {
        try {
          ids.push(BigInt(r.slice(VAULT_REF_PREFIX.length)));
        } catch {
          // malformed id-ref → no kind (auto-injection simply off for it)
        }
      }
    }
    const entries =
      ids.length > 0
        ? await db.vaultEntry.findMany({
            where: { id: { in: ids } },
            select: { id: true, kind: true, paramName: true, baseUrl: true },
          })
        : [];
    const metaByRef = new Map<
      string,
      { kind: string | null; paramName: string | null; baseUrl: string | null }
    >();
    for (const e of entries) {
      metaByRef.set(formatVaultRef(e.id), {
        kind: e.kind,
        paramName: e.paramName,
        baseUrl: e.baseUrl,
      });
    }
    for (const d of result.httpToolDefs) {
      const meta = d.credentialRef
        ? (metaByRef.get(d.credentialRef) ?? null)
        : null;
      d.credentialKind = meta?.kind ?? null;
      d.credentialParamName = meta?.paramName ?? null;
      d.credentialBaseUrl = meta?.baseUrl ?? null;
    }
  }
  return result;
}

export interface HttpToolBuildDeps {
  resolveCredential: (ref: string) => Promise<string | null>;
  allowHttp?: boolean;
  // Posts a per-tool "I'll look into that…" ack to the customer before a slow tool runs. Wired only
  // on a real conversation (the playground/nudge build omits it) — see prepare.ts buildToolset.
  emitAck?: (message: string) => Promise<void>;
  // Conversation/contact context for {{placeholder}} interpolation in fixed fields, headers, URL and
  // the raw body (e.g. {{conversation_id}}, {{contact_name}}). Never a secret.
  context?: Record<string, string>;
}

// Builds StructuredTools from loaded ToolDefinition rows. Network (the actual HTTP call) happens
// only when the model invokes a tool — never here.
export function buildHttpTools(
  defs: LoadedHttpToolDef[],
  deps: HttpToolBuildDeps,
): StructuredToolInterface[] {
  return defs.map((d) => {
    const def: HttpToolDef = {
      name: d.name,
      description: d.description,
      method: d.method,
      urlTemplate: d.urlTemplate,
      allowedHosts: d.allowedHosts,
      headers: (d.headers ?? {}) as Record<string, string>,
      inputSchema: d.inputSchema,
      credentialRef: d.credentialRef,
      credentialKind: d.credentialKind,
      credentialParamName: d.credentialParamName,
      credentialBaseUrl: d.credentialBaseUrl,
      ackMessage: d.ackEnabled ? d.ackMessage : null,
      query: d.query,
      body: d.body,
      expectedStatuses: d.expectedStatuses,
    };
    return buildHttpTool(def, deps);
  });
}
