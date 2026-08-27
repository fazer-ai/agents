import type { StructuredToolInterface } from "@langchain/core/tools";
import type { AgentToolSource, Prisma } from "@/../generated/prisma/client";
import type { ScopedDb } from "@/lib/tenancy";
import type { DocumentField } from "@/modules/documents/blocks";
import { parseTemplateContent } from "@/modules/documents/validate";
import type { IntegrationSelection } from "@/modules/integrations/toolpacks";
import { isManagedOAuthKind } from "@/modules/vault/secret-types";
import {
  formatVaultRef,
  readVaultRefId,
  tryResolveVaultEntry,
} from "@/modules/vault/service";
import type { DocumentSelection } from "./documents";
import { buildHttpTool, type HttpToolDef, type HttpToolDeps } from "./http";
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
  // What this tool's response declares about an appointment, or null when it declares nothing
  // (issue #352). Required for the same reason `expectedStatuses` above is: a column that can be
  // forgotten in the `select` reads as `undefined` and normalizes to "declare nothing", which is a
  // feature going silently missing rather than failing.
  appointment: unknown;
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

// THE PRECEDENCE WHEN TWO TOOLS CLAIM ONE NAME (#389), anchored on the SOURCE's identity.
//
// `namespacedToolName` gives the plain name to whoever asks first and `_2` to the next, and
// `dropDuplicateToolNames` keeps the first of two toolpack instances that expose the same names. So
// the order this read comes back in is not cosmetic; it decides which tool the model sees under
// which name.
//
// Unordered, that answer was the physical row order — and `replaceAgentToolSelections` deletes every
// row and recreates the set on each save, in the order the client sent, which for the editor is the
// operator's CLICK HISTORY (`toggleMcp` appends on toggle-on). Toggling one of two colliding
// connections off and back on therefore renamed the other one's tools, mid-conversation, for a
// change that granted nothing new.
//
// Ordering by the grant's `id` looks equivalent and is not: the recreated rows are assigned ids in
// the order the client sent, so it reproduces exactly the click history it was meant to erase.
// Measured — grants inserted alphabetically read back as ids 6727…6734, and after a re-save that
// sent them reversed they read back 6734…6727, with `ORDER BY id` agreeing with the unordered read
// both times. The connection / instance / definition rows are the thing a grant POINTS AT, and a
// grant re-save never touches them.
//
// AND THE ANCHOR IS THE SOURCE'S NAME, not its id (#412). The id is identity inside one tenant and
// nothing at all across two: `exportAgent` carries each component by NAME and `importAgent` matches
// on it, creating a row only where the destination has none — so the destination's ids are whatever
// that import assigned, in no relation to the source's. When the destination ALREADY has one of two
// colliding sources, it is reused with its own (lower) id while its partner is created fresh, and
// ordering by id puts the pair the other way round. Both tools still exist under both names, and each
// name now reaches the OTHER server. Nothing is missing, so nothing looks wrong.
//
// The name is the right anchor because it is what the transfer preserves and what the database
// already keeps unique (`@@unique([tenantId, name])` on the connection,
// `@@unique([tenantId, catalogType, name])` on the instance). It is the same anchor a re-save needs,
// so it replaces the id rather than joining it.
//
// BUT NOT `ORDER BY name` — the comparison is done here, in code, by UTF-16 code unit. SQL would
// compare under the database's collation, and a bundle exported from one deployment is imported into
// another: measured on the same two names, `en_US.utf8` orders "…connection a" before
// "…connection B" and `C` orders them the other way round, so the pair inverts on arrival and each
// name reaches the other server again — the very failure this is fixing, one layer down. A code-unit
// comparison is the same on every runtime and every database.
//
// The instance is ordered by name ALONE, without its catalogType, because the only pair that can
// contest a name is two instances of ONE catalog type — every toolpack prefixes its tools with its
// own catalog (`calendar_`, `asaas_`, `drive_`), so no two catalog types expose a common name — and
// within one catalog type the name is already a total order. Adding the catalogType key first killed
// no test in the mutation battery, which is what a rule with no observable effect looks like.
//
// HTTP and document grants stay on the id: their exposed names are the definition's name and
// `send_<slug>`, both unique per tenant, so no two of them can contest a name and the order is
// invisible either way (asserted in tests/graph/tool-grant-order.test.ts).
const GRANT_ORDER: Prisma.AgentToolSelectionOrderByWithRelationInput[] = [
  { source: "asc" },
  { mcpServerConnectionId: "asc" },
  { integrationInstanceId: "asc" },
  { toolDefinitionId: "asc" },
  { documentTemplateId: "asc" },
];

// The grant rows in assembly order: source first, then the source's NAME for the two sources that can
// contest one, compared by code unit.
//
// A TOTAL order, and it has to be: a comparator that answers 0 for the rows without a name while
// ordering the named ones among themselves is not transitive, and `Array.prototype.sort` is free to
// return anything for one of those. The `?? ""` is what buys that — a grant whose relation row is
// missing gets a position instead of tying with every row it meets.
//
// The source key on top of it buys the GROUPING, not the totality: it keeps the blocks the read
// already delivered (`source: "asc"`) instead of interleaving MCP and integration rows by name.
// Measured, removing it kills no test, because each source is dispatched into its own array below
// and nothing reads `rows` as blocks. It stays as the cheaper half of a surprise for whoever does.
function byContestedName(
  a: {
    source: AgentToolSource;
    mcpServerConnection: { name: string } | null;
    integrationInstance: { name: string } | null;
  },
  b: {
    source: AgentToolSource;
    mcpServerConnection: { name: string } | null;
    integrationInstance: { name: string } | null;
  },
): number {
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  const an = a.mcpServerConnection?.name ?? a.integrationInstance?.name ?? "";
  const bn = b.mcpServerConnection?.name ?? b.integrationInstance?.name ?? "";
  return an < bn ? -1 : an > bn ? 1 : 0;
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
    orderBy: GRANT_ORDER,
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
          appointment: true,
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
          name: true,
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

  for (const row of [...rows].sort(byContestedName)) {
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
          appointment: td.appointment,
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
      // malformed, or past what a bigint column holds → no kind (auto-injection off for it)
      const id = readVaultRefId(r);
      if (id !== null) ids.push(id);
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
  // Passed straight through to every tool built here, for the ones whose definition declares that
  // their response describes an appointment (issue #352). Named individually rather than spread from
  // HttpToolDeps so that adding a dep to the runtime does not silently widen what this layer
  // forwards.
  // The agent zone an offset-less start is read in, same reason as the rest of this block.
  timezone?: HttpToolDeps["timezone"];
  appointmentBooked?: HttpToolDeps["appointmentBooked"];
  cancelAppointment?: HttpToolDeps["cancelAppointment"];
  onSideEffectError?: HttpToolDeps["onSideEffectError"];
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
      appointment: d.appointment,
    };
    return buildHttpTool(def, deps);
  });
}
