// Agent export/import (item 3) — share + reuse an agent's full configuration across tenants/
// instances WITHOUT ever moving a secret. This whole module is a Full-distribution feature.
//
// The export is a self-contained JSON that references everything BY NAME (never by id and never the
// secret value): the system prompt, the model config, the behavior settings (debounce/stt/tts/split/
// serviceWindow/grounding), and the tool grants (HTTP tool name, MCP server name, integration
// catalogType+name, KB names). Credential refs are stored internally as `vault:<id>` (tenant-local),
// so export translates them id→NAME and import translates NAME→`vault:<id>` in the target tenant
// (collectCredRefs/remapCredRefs). `assertNoSecrets` (the n8n-export value scanner) is the backstop: the
// export REFUSES if any concrete secret-shaped value slipped in. Import recreates the agent DISABLED,
// resolves each reference by name in the target tenant. A credential missing at the destination is
// re-created as an empty PENDING vault entry with the ref kept wired (so the operator only fills the
// secret); anything still unresolvable is warned (the agent stays incomplete but never breaks).
// Secret VALUES are never imported, only empty placeholders.

import { z } from "zod";
import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { normalizeExpectedStatuses } from "@/graph/tools/http-status";
import { AppError, NotFoundError } from "@/lib/errors";
import {
  hasSafeStdioCommandChars,
  isMcpStdioLauncher,
  stdioCommandLauncher,
} from "@/lib/mcp-launchers";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import {
  type CredentialFieldTab,
  SETTINGS_CREDENTIAL_PATHS,
} from "@/modules/agents/credential-paths";
import { clampOversizedTextInPlace } from "@/modules/agents/text-caps";
import { normalizeSettingsForStorage } from "@/modules/images/settings";
import { isKnownCatalogType } from "@/modules/integrations/catalog";
import { assertNoSecrets } from "@/modules/n8n-export/n8n";
import { normalizeToolShapes } from "@/modules/tool-definitions/normalize";
import {
  createPendingVaultEntry,
  formatVaultRef,
  isVaultIdRef,
  resolveVaultRefByName,
  VAULT_REF_PREFIX,
} from "@/modules/vault/service";
import { generateRouteToken } from "@/modules/webhooks/inbound/route-token";
import {
  AGENT_SELECT,
  type AgentDto,
  assertPromptSize,
  requireTenant,
  toDto,
} from "./service";

export const AGENT_EXPORT_KIND = "fazer-ai.agent";
export const AGENT_EXPORT_VERSION = 1;

const exportedGrantSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("NATIVE"), enabledTools: z.array(z.string()) }),
  z.object({
    source: z.literal("RAG"),
    enabledTools: z.array(z.string()),
    knowledgeBases: z.array(z.string()),
  }),
  z.object({
    source: z.literal("HTTP"),
    tool: z.string(),
    enabledTools: z.array(z.string()),
  }),
  z.object({
    source: z.literal("MCP"),
    server: z.string(),
    enabledTools: z.array(z.string()),
  }),
  z.object({
    source: z.literal("INTEGRATION"),
    catalogType: z.string(),
    integration: z.string(),
    enabledTools: z.array(z.string()),
  }),
]);

// Full component definitions (opt-in via ?components=true). Each references its credential BY NAME
// (never id, never secret); integrations carry NO inboundSecretRef/routeTokenHash (regenerated on
// import). Knowledge bases carry metadata; their documents' SOURCE TEXT is bundled only with the
// separate ?documents opt-in (re-chunked + re-embedded at the destination — embeddings/chunks, being
// derived and model-specific, are never exported).
const exportedHttpToolSchema = z.object({
  name: z.string(),
  label: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  method: z.string(),
  urlTemplate: z.string(),
  allowedHosts: z.array(z.string()),
  headers: z.record(z.string(), z.unknown()),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  // Optional so exports produced before query existed still import (defaults to {}).
  query: z.record(z.string(), z.unknown()).optional(),
  body: z.record(z.string(), z.unknown()),
  // Retired (issue #137) and read by nothing. Still ECHOED on export, and optional here, because
  // the bundle format is versioned as a whole (`version: z.literal(1)`): an instance one release
  // behind still requires this key, so omitting it would make every bundle this build produces
  // unimportable there, and bumping the version would only trade that for a cleaner refusal while
  // also making THIS build reject every v1 bundle. Optional in both directions, so a bundle written
  // after #149 drops the column still imports. Never written back — the column keeps its default.
  riskTier: z.string().optional(),
  ackEnabled: z.boolean(),
  ackMessage: z.string().nullable().optional(),
  credentialRef: z.string().nullable().optional(),
  // Optional so bundles exported before issue #59 still import (defaults to [], which is today's
  // "every non-2xx is a failure").
  expectedStatuses: z.array(z.number()).optional(),
});
const exportedMcpServerSchema = z.object({
  name: z.string(),
  transport: z.string(),
  url: z.string().nullable().optional(),
  command: z.string().nullable().optional(),
  credentialRef: z.string().nullable().optional(),
});
const exportedIntegrationSchema = z.object({
  catalogType: z.string(),
  name: z.string(),
  config: z.record(z.string(), z.unknown()),
  credentialRef: z.string().nullable().optional(),
});
// One source document of a knowledge base. Only the extracted TEXT travels (content); the destination
// re-chunks + re-embeds. `sourceType` is a plain string (matches the DB column) so a future source kind
// does not break import of older/newer exports.
const exportedKnowledgeDocumentSchema = z.object({
  title: z.string(),
  sourceType: z.string(),
  fileName: z.string().nullable().optional(),
  mimeType: z.string().nullable().optional(),
  content: z.string(),
});
const exportedKnowledgeBaseSchema = z.object({
  name: z.string(),
  description: z.string().nullable().optional(),
  embeddingModel: z.string().optional(),
  chunkSize: z.number().optional(),
  chunkOverlap: z.number().optional(),
  // Opt-in (?documents=true): the source text of every document, re-indexed at the destination. Last
  // so the heavy, optional payload sits at the end of each KB object.
  documents: z.array(exportedKnowledgeDocumentSchema).optional(),
});
// A business-hours schedule the agent references (by name) for hours / follow-up windows. Bundled so
// the import can RECREATE it at the destination instead of leaving the reference unset (windows is the
// raw schedule JSON). Optional for back-compat with exports made before this was bundled.
const exportedBusinessHoursSchema = z.object({
  name: z.string(),
  timezone: z.string().optional(),
  windows: z.array(z.unknown()).optional(),
  // Absent in exports written before date exceptions existed, which import as a schedule with none —
  // the same schedule the source had. Omitting this field here would not fail any type check: the
  // export would simply arrive at the destination with every holiday and shutdown silently gone.
  exceptions: z.array(z.unknown()).optional(),
  source: z.string().optional(),
});
const exportedComponentsSchema = z.object({
  httpTools: z.array(exportedHttpToolSchema),
  mcpServers: z.array(exportedMcpServerSchema),
  integrations: z.array(exportedIntegrationSchema),
  knowledgeBases: z.array(exportedKnowledgeBaseSchema),
  businessHours: z.array(exportedBusinessHoursSchema).optional(),
});

export const agentExportSchema = z.object({
  version: z.literal(AGENT_EXPORT_VERSION),
  kind: z.literal(AGENT_EXPORT_KIND),
  // Informational provenance (item 2): where/when this export came from. Optional so older exports
  // and hand-written payloads still import.
  meta: z
    .object({
      exportedAt: z.string(),
      exportedFrom: z.string(),
      appVersion: z.string(),
    })
    .optional(),
  agent: z.object({
    name: z.string().min(1).max(200),
    systemPrompt: z.string().max(config.agent.promptMaxChars),
    modelConfig: z.record(z.string(), z.unknown()),
    settings: z.record(z.string(), z.unknown()),
    transferWithSummary: z.boolean(),
    businessHours: z.string().nullable(),
    followUpHours: z.string().nullable(),
    tools: z.array(exportedGrantSchema),
    // Metadata for unambiguous import: every credential name referenced in modelConfig/settings
    // (and in the component definitions) carries its kind here, so import resolves by (name, kind)
    // — never by bare name.
    credentials: z.array(z.object({ name: z.string(), kind: z.string() })),
  }),
  // Opt-in full component definitions (HTTP tools / MCP servers / integrations / KB metadata) so an
  // agent imports self-sufficiently. Absent ⇒ import resolves components by name (legacy behavior).
  components: exportedComponentsSchema.optional(),
});

export type AgentExport = z.infer<typeof agentExportSchema>;
type ExportedGrant = z.infer<typeof exportedGrantSchema>;
type ExportedComponents = z.infer<typeof exportedComponentsSchema>;
type ExportedKnowledgeDocument = z.infer<
  typeof exportedKnowledgeDocumentSchema
>;
type ExportedBusinessHours = z.infer<typeof exportedBusinessHoursSchema>;

// A structured import warning: a stable `code` the editor localizes, optional interpolation `params`,
// and an optional deep-link `target` so the banner can offer a "review/resolve" action (mirrors the
// config-health panel). The backend stays i18n-agnostic; all message text lives in the client locale.
export type ImportWarningTarget =
  | { kind: "vault" }
  // An agent-level credential field (model/stt/tts/vision/guardrails): deep-links to the exact editor
  // section that references the missing credential, instead of the vault page.
  | { kind: "agentField"; tab: CredentialFieldTab; sectionId: string }
  | { kind: "businessHours"; name: string }
  | { kind: "tool"; name: string }
  | { kind: "mcp"; name: string }
  | { kind: "integration"; catalogType: string; name: string }
  | { kind: "knowledge"; name: string };

export interface ImportWarning {
  code: string;
  params?: Record<string, string | number>;
  target?: ImportWarningTarget;
}

// De-dupes by (code + params): the same issue surfaced from several places warns once, and the toast
// count matches the rendered list.
function dedupeWarnings(ws: ImportWarning[]): ImportWarning[] {
  const seen = new Set<string>();
  const out: ImportWarning[] = [];
  for (const w of ws) {
    const key = `${w.code}|${JSON.stringify(w.params ?? {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

// Credentials live in several JSON paths on an agent: modelConfig.credentialRef and
// settings.{stt,tts,vision}.credentialRef. Internally they are `vault:<id>` (tenant-local); export
// translates them id→name and import translates name→id so the JSON stays portable.
export function collectCredRefs(
  modelConfig: Record<string, unknown>,
  settings: Record<string, unknown>,
): string[] {
  const refs: string[] = [];
  if (
    typeof modelConfig.credentialRef === "string" &&
    modelConfig.credentialRef
  ) {
    refs.push(modelConfig.credentialRef);
  }
  for (const { block, field } of SETTINGS_CREDENTIAL_PATHS) {
    const sub = settings[block];
    if (sub && typeof sub === "object") {
      const ref = (sub as Record<string, unknown>)[field];
      if (typeof ref === "string" && ref) refs.push(ref);
    }
  }
  return refs;
}

// Maps each agent-field credential ref (model/stt/tts/vision) to the editor section that sets it, so a
// "credential not found" import warning can deep-link to the exact field rather than the vault page.
// First occurrence wins: a name shared across fields lands on one section, and config-health surfaces
// the rest live once the agent is open. The section ids mirror configHealth.ts.
export function credentialFieldTargets(
  modelConfig: Record<string, unknown>,
  settings: Record<string, unknown>,
): Map<string, { tab: CredentialFieldTab; sectionId: string }> {
  const out = new Map<string, { tab: CredentialFieldTab; sectionId: string }>();
  const add = (
    ref: unknown,
    tab: CredentialFieldTab,
    sectionId: string,
  ): void => {
    if (typeof ref === "string" && ref && !isVaultIdRef(ref) && !out.has(ref)) {
      out.set(ref, { tab, sectionId });
    }
  };
  add(modelConfig.credentialRef, "general", "general-model");
  for (const { block, field, tab, sectionId } of SETTINGS_CREDENTIAL_PATHS) {
    const sub = settings[block];
    if (sub && typeof sub === "object") {
      add((sub as Record<string, unknown>)[field], tab, sectionId);
    }
  }
  return out;
}

// Copies of modelConfig/settings with each credential ref passed through `map` (a null mapping
// removes the ref). Originals are not mutated.
export function remapCredRefs(
  modelConfig: Record<string, unknown>,
  settings: Record<string, unknown>,
  map: (ref: string) => string | null,
): { modelConfig: Record<string, unknown>; settings: Record<string, unknown> } {
  const mc = { ...modelConfig };
  if (typeof mc.credentialRef === "string" && mc.credentialRef) {
    const mapped = map(mc.credentialRef);
    if (mapped === null) delete mc.credentialRef;
    else mc.credentialRef = mapped;
  }
  const st = { ...settings };
  // NOTE: re-read st[key] each time, since two paths share the `tts` block and the second must see
  // the first one's rewrite.
  for (const { block, field } of SETTINGS_CREDENTIAL_PATHS) {
    const sub = st[block];
    if (sub && typeof sub === "object") {
      const subCopy = { ...(sub as Record<string, unknown>) };
      const ref = subCopy[field];
      if (typeof ref === "string" && ref) {
        const mapped = map(ref);
        if (mapped === null) delete subCopy[field];
        else subCopy[field] = mapped;
        st[block] = subCopy;
      }
    }
  }
  return { modelConfig: mc, settings: st };
}

// All credential refs referenced by the component definitions (httpTools/mcpServers/integrations).
// KB metadata carries no credential.
function collectComponentCredRefs(components: ExportedComponents): string[] {
  const refs: string[] = [];
  for (const tdef of components.httpTools) {
    if (tdef.credentialRef) refs.push(tdef.credentialRef);
  }
  for (const m of components.mcpServers) {
    if (m.credentialRef) refs.push(m.credentialRef);
  }
  for (const i of components.integrations) {
    if (i.credentialRef) refs.push(i.credentialRef);
  }
  return refs;
}

// Deep clone of an export with every bundled document's `content` blanked. The secret scan + vault-ref
// check run on THIS clone: document source text is tenant CONTENT (not config) and is deliberately
// exempt — free prose trips the secret regexes and may legitimately contain the literal "vault:". All
// config + KB/document metadata (titles, filenames) stay scanned.
function blankDocumentContent(data: AgentExport): AgentExport {
  const clone = JSON.parse(JSON.stringify(data)) as AgentExport;
  for (const kb of clone.components?.knowledgeBases ?? []) {
    if (kb.documents) {
      for (const d of kb.documents) d.content = "";
    }
  }
  return clone;
}

// ── export ──

export async function exportAgent(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
  opts: { includeComponents?: boolean; includeDocuments?: boolean } = {},
): Promise<AgentExport> {
  requireTenant(ctx);
  const data = await runScopedOn(base, ctx, async (db) => {
    const agent = await db.agent.findUnique({
      where: { id },
      select: {
        name: true,
        systemPrompt: true,
        modelConfig: true,
        settings: true,
        transferWithSummary: true,
        businessHoursId: true,
        followUpHoursId: true,
      },
    });
    if (!agent) {
      throw new NotFoundError("agent not found", "errors.agentNotFound");
    }
    const businessHours = agent.businessHoursId
      ? ((
          await db.businessHours.findUnique({
            where: { id: agent.businessHoursId },
            select: { name: true },
          })
        )?.name ?? null)
      : null;
    const followUpHours = agent.followUpHoursId
      ? ((
          await db.businessHours.findUnique({
            where: { id: agent.followUpHoursId },
            select: { name: true },
          })
        )?.name ?? null)
      : null;

    const grants = await db.agentToolSelection.findMany({
      where: { agentId: id },
      select: {
        source: true,
        enabledTools: true,
        knowledgeBaseIds: true,
        toolDefinitionId: true,
        mcpServerConnectionId: true,
        integrationInstanceId: true,
        toolDefinition: { select: { name: true } },
        mcpServerConnection: { select: { name: true } },
        integrationInstance: { select: { catalogType: true, name: true } },
      },
    });

    // RAG grants reference KB ids → resolve to names (those that still exist). The full rows feed the
    // KB component metadata when components are included.
    const kbIds = [...new Set(grants.flatMap((g) => g.knowledgeBaseIds))];
    const kbRows =
      kbIds.length > 0
        ? await db.knowledgeBase.findMany({
            where: { id: { in: kbIds } },
            select: {
              id: true,
              name: true,
              description: true,
              embeddingModel: true,
              chunkSize: true,
              chunkOverlap: true,
            },
          })
        : [];
    const kbNameById = new Map<bigint, string>();
    for (const kb of kbRows) kbNameById.set(kb.id, kb.name);

    const tools: ExportedGrant[] = [];
    for (const g of grants) {
      switch (g.source) {
        case "NATIVE":
          tools.push({ source: "NATIVE", enabledTools: g.enabledTools });
          break;
        case "RAG":
          tools.push({
            source: "RAG",
            enabledTools: g.enabledTools,
            knowledgeBases: g.knowledgeBaseIds
              .map((kid) => kbNameById.get(kid))
              .filter((n): n is string => !!n),
          });
          break;
        case "HTTP":
          if (g.toolDefinition) {
            tools.push({
              source: "HTTP",
              tool: g.toolDefinition.name,
              enabledTools: g.enabledTools,
            });
          }
          break;
        case "MCP":
          if (g.mcpServerConnection) {
            tools.push({
              source: "MCP",
              server: g.mcpServerConnection.name,
              enabledTools: g.enabledTools,
            });
          }
          break;
        case "INTEGRATION":
          if (g.integrationInstance) {
            tools.push({
              source: "INTEGRATION",
              catalogType: g.integrationInstance.catalogType,
              integration: g.integrationInstance.name,
              enabledTools: g.enabledTools,
            });
          }
          break;
      }
    }

    // ── full component definitions (opt-in) ──
    // Loaded from the components this agent's grants reference. credentialRef stays `vault:<id>` here
    // and is translated to a portable NAME below, alongside the model/settings refs. Integrations
    // export NEITHER inboundSecretRef NOR routeTokenHash — those are regenerated on import.
    let componentsRaw: ExportedComponents | undefined;
    if (opts.includeComponents) {
      const httpIds = [
        ...new Set(
          grants
            .filter((g) => g.source === "HTTP")
            .map((g) => g.toolDefinitionId)
            .filter((x): x is bigint => x != null),
        ),
      ];
      const mcpIds = [
        ...new Set(
          grants
            .filter((g) => g.source === "MCP")
            .map((g) => g.mcpServerConnectionId)
            .filter((x): x is bigint => x != null),
        ),
      ];
      const integrationIds = [
        ...new Set(
          grants
            .filter((g) => g.source === "INTEGRATION")
            .map((g) => g.integrationInstanceId)
            .filter((x): x is bigint => x != null),
        ),
      ];
      const httpRows = httpIds.length
        ? await db.toolDefinition.findMany({ where: { id: { in: httpIds } } })
        : [];
      const mcpRows = mcpIds.length
        ? await db.mcpServerConnection.findMany({
            where: { id: { in: mcpIds } },
          })
        : [];
      const integrationRows = integrationIds.length
        ? await db.integrationInstance.findMany({
            where: { id: { in: integrationIds } },
          })
        : [];
      // KB document source text (opt-in, ?documents=true). Grouped by KB id; only the text travels.
      const withDocs = opts.includeDocuments === true;
      const docRows =
        withDocs && kbIds.length > 0
          ? await db.knowledgeDocument.findMany({
              where: { knowledgeBaseId: { in: kbIds } },
              select: {
                knowledgeBaseId: true,
                title: true,
                sourceType: true,
                fileName: true,
                mimeType: true,
                content: true,
              },
              orderBy: { id: "asc" },
            })
          : [];
      const docsByKb = new Map<bigint, ExportedKnowledgeDocument[]>();
      for (const d of docRows) {
        const list = docsByKb.get(d.knowledgeBaseId) ?? [];
        list.push({
          title: d.title,
          sourceType: d.sourceType,
          fileName: d.fileName,
          mimeType: d.mimeType,
          content: d.content,
        });
        docsByKb.set(d.knowledgeBaseId, list);
      }
      // Bundle the referenced business-hours schedules so import can RECREATE them (not just reuse a
      // same-name one or leave the agent's hours unset). Dedup the refs: the agent's hours + follow-up,
      // AND the ones referenced INSIDE integration configs (e.g. Google Calendar's `businessHoursId`) —
      // those are otherwise a dead id at the destination, since the config is not remapped on import.
      const configBhIds = integrationRows.flatMap((r) => {
        const raw = (r.config as Record<string, unknown> | null)
          ?.businessHoursId;
        if (typeof raw !== "string" || raw === "") return [];
        try {
          return [BigInt(raw)];
        } catch {
          return [];
        }
      });
      const bhIds = [
        ...new Set(
          [agent.businessHoursId, agent.followUpHoursId, ...configBhIds].filter(
            (x): x is bigint => x != null,
          ),
        ),
      ];
      const bhRows = bhIds.length
        ? await db.businessHours.findMany({
            where: { id: { in: bhIds } },
            select: {
              id: true,
              name: true,
              timezone: true,
              windows: true,
              exceptions: true,
              source: true,
            },
          })
        : [];
      // id→name for the referenced schedules, so an integration config carries a portable NAME instead
      // of a destination-invalid id (import resolves it back — see remapConfigBusinessHoursNameToId).
      const bhNameById = new Map(bhRows.map((r) => [r.id.toString(), r.name]));
      componentsRaw = {
        httpTools: httpRows.map((r) => ({
          name: r.name,
          label: r.label,
          description: r.description,
          method: r.method,
          urlTemplate: r.urlTemplate,
          allowedHosts: r.allowedHosts,
          headers: (r.headers ?? {}) as Record<string, unknown>,
          inputSchema: (r.inputSchema ?? {}) as Record<string, unknown>,
          outputSchema: (r.outputSchema ?? {}) as Record<string, unknown>,
          query: (r.query ?? {}) as Record<string, unknown>,
          body: (r.body ?? {}) as Record<string, unknown>,
          riskTier: r.riskTier,
          ackEnabled: r.ackEnabled,
          ackMessage: r.ackMessage,
          credentialRef: r.credentialRef,
          expectedStatuses: r.expectedStatuses,
        })),
        mcpServers: mcpRows.map((r) => ({
          name: r.name,
          transport: r.transport,
          url: r.url,
          command: r.command,
          credentialRef: r.credentialRef,
        })),
        integrations: integrationRows.map((r) => ({
          catalogType: r.catalogType,
          name: r.name,
          config: remapConfigBusinessHoursIdToName(
            (r.config ?? {}) as Record<string, unknown>,
            bhNameById,
          ),
          credentialRef: r.credentialRef,
        })),
        knowledgeBases: kbRows.map((r) => ({
          name: r.name,
          description: r.description,
          embeddingModel: r.embeddingModel,
          chunkSize: r.chunkSize,
          chunkOverlap: r.chunkOverlap,
          ...(withDocs ? { documents: docsByKb.get(r.id) ?? [] } : {}),
        })),
        businessHours: bhRows.map((r) => ({
          name: r.name,
          timezone: r.timezone,
          windows: (r.windows ?? []) as unknown[],
          exceptions: (r.exceptions ?? []) as unknown[],
          source: r.source,
        })),
      };
    }

    // Translate stored `vault:<id>` credential refs back to portable vault NAMES (the id is
    // tenant-local). An id that no longer resolves (deleted credential) drops to unset. Also collect
    // kind alongside name so the export carries enough metadata for unambiguous import. Components'
    // credential refs are translated with the SAME id→name map.
    const modelConfigRaw = (agent.modelConfig ?? {}) as Record<string, unknown>;
    const settingsRaw = (agent.settings ?? {}) as Record<string, unknown>;
    const exportIdRefs = [
      ...collectCredRefs(modelConfigRaw, settingsRaw),
      ...(componentsRaw ? collectComponentCredRefs(componentsRaw) : []),
    ].filter(isVaultIdRef);
    const nameByRef = new Map<string, string>();
    const kindByRef = new Map<string, string>();
    if (exportIdRefs.length > 0) {
      const ids: bigint[] = [];
      for (const r of exportIdRefs) {
        try {
          ids.push(BigInt(r.slice(VAULT_REF_PREFIX.length)));
        } catch {
          // malformed id-ref → skipped (translates to unset)
        }
      }
      const vrows = await db.vaultEntry.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, kind: true },
      });
      for (const e of vrows) {
        nameByRef.set(formatVaultRef(e.id), e.name);
        kindByRef.set(formatVaultRef(e.id), e.kind);
      }
    }
    const refToName = (ref: string | null): string | null =>
      ref && isVaultIdRef(ref) ? (nameByRef.get(ref) ?? null) : ref;
    const { modelConfig, settings } = remapCredRefs(
      modelConfigRaw,
      settingsRaw,
      (ref) => refToName(ref),
    );

    // Translate component credential refs id→name (deletes the ref when the id no longer resolves).
    const components: ExportedComponents | undefined = componentsRaw
      ? {
          httpTools: componentsRaw.httpTools.map((tdef) => ({
            ...tdef,
            credentialRef: refToName(tdef.credentialRef ?? null),
          })),
          mcpServers: componentsRaw.mcpServers.map((m) => ({
            ...m,
            credentialRef: refToName(m.credentialRef ?? null),
          })),
          integrations: componentsRaw.integrations.map((i) => ({
            ...i,
            credentialRef: refToName(i.credentialRef ?? null),
          })),
          knowledgeBases: componentsRaw.knowledgeBases,
          businessHours: componentsRaw.businessHours,
        }
      : undefined;

    // Deduplicated list of (name, kind) for the credentials referenced by this agent + its components.
    const seen = new Set<string>();
    const credentials: { name: string; kind: string }[] = [];
    for (const ref of exportIdRefs) {
      const name = nameByRef.get(ref);
      const kind = kindByRef.get(ref);
      if (name && kind) {
        const key = `${name}\0${kind}`;
        if (!seen.has(key)) {
          seen.add(key);
          credentials.push({ name, kind });
        }
      }
    }

    let exportedFrom = config.publicUrl;
    try {
      exportedFrom = new URL(config.publicUrl).host;
    } catch {
      // malformed PUBLIC_URL → keep the raw string (informational only)
    }

    return {
      version: AGENT_EXPORT_VERSION as typeof AGENT_EXPORT_VERSION,
      kind: AGENT_EXPORT_KIND as typeof AGENT_EXPORT_KIND,
      meta: {
        exportedAt: new Date().toISOString(),
        exportedFrom,
        appVersion: config.packageInfo.version,
      },
      agent: {
        name: agent.name,
        systemPrompt: agent.systemPrompt,
        modelConfig,
        settings,
        transferWithSummary: agent.transferWithSummary,
        businessHours,
        followUpHours,
        tools,
        credentials,
      },
      ...(components ? { components } : {}),
    } satisfies AgentExport;
  });

  // Belt-and-suspenders: refuse to emit if any concrete secret-shaped value slipped in (a stray
  // apiKey in modelConfig, etc.). credentialRef values are vault NAMES, which the scanner allows.
  // Scanned on a clone with document content blanked (tenant content is exempt — see
  // blankDocumentContent); the real `data` (with content) is what we return.
  const scanTarget = blankDocumentContent(data);
  assertNoSecrets(scanTarget);
  // Defense-in-depth: the id→name translation covers the known credential paths, but a `vault:<id>`
  // stored under any OTHER key would be a tenant-local id leak that assertNoSecrets cannot see (an
  // id has no secret shape). Refuse to emit rather than leak the boundary this refactor protects.
  if (JSON.stringify(scanTarget).includes(VAULT_REF_PREFIX)) {
    throw new AppError(
      "agent export contains an unresolved vault reference",
      500,
    );
  }
  return data;
}

// ── import ──

export interface ImportAgentResult {
  agent: AgentDto;
  warnings: ImportWarning[];
}

export async function importAgent(
  ctx: TenantContext,
  raw: unknown,
  base: PrismaClient = basePrisma,
): Promise<ImportAgentResult> {
  const tenantId = requireTenant(ctx);
  // NOTE: size check BEFORE the schema parse — past the cap the operator gets the specific
  // prompt-too-long error, not the generic invalid-payload one.
  if (raw && typeof raw === "object") {
    const sp = (raw as { agent?: { systemPrompt?: unknown } }).agent
      ?.systemPrompt;
    if (typeof sp === "string") assertPromptSize(sp);
  }
  const parsed = agentExportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      "invalid agent export payload",
      400,
      "errors.invalidAgentExport",
    );
  }
  const exp = parsed.data.agent;
  const components = parsed.data.components;
  const warnings: ImportWarning[] = [];

  return runScopedOn(base, ctx, async (db) => {
    // Recreate bundled business-hours schedules FIRST so the agent's hours / follow-up names resolve
    // below (instead of falling back to a same-name match or being left unset).
    if (components?.businessHours?.length) {
      await createMissingBusinessHours(
        db,
        tenantId,
        components.businessHours,
        warnings,
      );
    }
    const businessHoursId = await resolveByName(
      db,
      "businessHours",
      exp.businessHours,
      warnings,
    );
    const followUpHoursId = await resolveByName(
      db,
      "followUpHours",
      exp.followUpHours,
      warnings,
    );

    // Translate portable credential NAMES back to `vault:<id>` for the target tenant, always by
    // (name, kind) from the mandatory `credentials` metadata — never by bare name. Includes the
    // component definitions' credential refs so created components re-link their credential too.
    const importNames = [
      ...collectCredRefs(
        exp.modelConfig as Record<string, unknown>,
        exp.settings as Record<string, unknown>,
      ),
      ...(components ? collectComponentCredRefs(components) : []),
    ].filter((r) => !isVaultIdRef(r));

    // Build name→kind from the metadata. A name listed with MORE THAN ONE kind is unresolvable:
    // the in-JSON refs are bare names, so there is no way to tell which path meant which
    // credential — flag it (null) and leave every use unset.
    const kindByName = new Map<string, string | null>();
    for (const c of exp.credentials) {
      const prev = kindByName.get(c.name);
      if (prev === undefined) kindByName.set(c.name, c.kind);
      else if (prev !== c.kind) kindByName.set(c.name, null);
    }

    // Where each credential is referenced on the agent (model/stt/tts/vision) → its editor section, so
    // a missing/ambiguous credential deep-links to the exact field. Names referenced only by component
    // definitions (httpTool/MCP) aren't here, so they fall back to the vault.
    const credFieldByName = credentialFieldTargets(
      exp.modelConfig as Record<string, unknown>,
      exp.settings as Record<string, unknown>,
    );
    const credTarget = (name: string): ImportWarningTarget => {
      const f = credFieldByName.get(name);
      return f
        ? { kind: "agentField", tab: f.tab, sectionId: f.sectionId }
        : { kind: "vault" };
    };

    const refByName = new Map<string, string | null>();
    for (const name of importNames) {
      if (refByName.has(name)) continue;
      const kind = kindByName.get(name);
      if (kind === undefined) {
        warnings.push({
          code: "credentialMissingMeta",
          params: { name },
          target: credTarget(name),
        });
        refByName.set(name, null);
        continue;
      }
      if (kind === null) {
        warnings.push({
          code: "credentialAmbiguous",
          params: { name },
          target: credTarget(name),
        });
        refByName.set(name, null);
        continue;
      }
      const resolution = await resolveVaultRefByName(ctx, name, kind, base);
      if (resolution.status === "found") {
        refByName.set(name, resolution.ref);
      } else {
        // Not in the target tenant yet: instead of dropping the ref, create a reference-only PENDING
        // vault entry (name + kind) and KEEP the ref wired. The operator then only fills the secret
        // (config-health + the vault list surface a pending entry), never re-links by hand after import.
        // Some kinds can't be pending — managed OAuth, or ones needing a baseUrl/paramName the export
        // metadata doesn't carry — so fall back to leaving the field unset for those.
        try {
          const pending = await createPendingVaultEntry(
            ctx,
            { name, kind },
            base,
          );
          refByName.set(name, pending.ref);
          warnings.push({
            code: "credentialPending",
            params: { name },
            target: { kind: "vault" },
          });
        } catch {
          warnings.push({
            code: "credentialNotFound",
            params: { name },
            target: credTarget(name),
          });
          refByName.set(name, null);
        }
      }
    }

    const { modelConfig, settings } = remapCredRefs(
      exp.modelConfig as Record<string, unknown>,
      exp.settings as Record<string, unknown>,
      (ref) => {
        if (isVaultIdRef(ref)) return ref;
        return refByName.get(ref) ?? null;
      },
    );

    // Operator prose over its cap is CLAMPED here, not refused. A direct write refuses (the person is
    // at the keyboard and can trim it), but a bundle authored somewhere else would be rejected whole
    // over a long note, and the readers would clip it on every read anyway. Clamping also keeps the
    // imported agent saveable: an over-cap value stored here would make its first save fail.
    for (const clipped of clampOversizedTextInPlace(settings)) {
      warnings.push({
        code: "guidanceClipped",
        params: { field: clipped.path, max: clipped.max },
      });
    }

    // Import DISABLED and in TEST mode — the operator reviews, re-links any missing references +
    // credentials, validates with /teste, then enables for production. Both are set explicitly: the
    // Agent.mode column defaults to "production", so an imported clone must never land live by default.
    const created = await db.agent.create({
      data: {
        tenantId,
        name: exp.name,
        systemPrompt: exp.systemPrompt,
        modelConfig: modelConfig as Prisma.InputJsonValue,
        settings: (normalizeSettingsForStorage(settings) ??
          settings) as Prisma.InputJsonValue,
        transferWithSummary: exp.transferWithSummary,
        businessHoursId,
        followUpHoursId,
        enabled: false,
        mode: "test",
      },
      select: AGENT_SELECT,
    });

    // Create any bundled components that don't already exist on the target tenant, BEFORE resolving
    // the grants (so buildGrantRows finds them by name). Components of the same name are reused, never
    // overwritten. Credentials are re-linked by name where resolved; otherwise left unset.
    if (components) {
      const resolveCredName = (
        name: string | null | undefined,
      ): string | null =>
        name && !isVaultIdRef(name) ? (refByName.get(name) ?? null) : null;
      await createMissingComponents(
        db,
        tenantId,
        components,
        resolveCredName,
        warnings,
      );
    }

    const grantRows = await buildGrantRows(
      db,
      tenantId,
      created.id,
      exp.tools,
      warnings,
    );
    if (grantRows.length > 0) {
      await db.agentToolSelection.createMany({ data: grantRows });
    }

    // De-dupe: the same credential/component referenced in several places should warn once, and the
    // toast count ("{{n}} warnings") must match the rendered list.
    return { agent: toDto(created), warnings: dedupeWarnings(warnings) };
  });
}

// An integration config may reference a business-hours schedule by id (Google Calendar's
// `businessHoursId`). On EXPORT we rewrite that id to the schedule's NAME so it survives the tenant hop
// (the referenced schedule is also bundled in components.businessHours); on IMPORT the name is resolved
// back to the local id. A config with no such ref, or an unresolved one, is left untouched.
export function remapConfigBusinessHoursIdToName(
  config: Record<string, unknown>,
  bhNameById: Map<string, string>,
): Record<string, unknown> {
  const id = config.businessHoursId;
  if (typeof id !== "string" || id === "") return config;
  const name = bhNameById.get(id);
  return name ? { ...config, businessHoursId: name } : config;
}

async function remapConfigBusinessHoursNameToId(
  db: ScopedDb,
  config: Record<string, unknown>,
  warnings: ImportWarning[],
): Promise<Record<string, unknown>> {
  const ref = config.businessHoursId;
  if (typeof ref !== "string" || ref === "") return config;
  // A bare numeric id (old export / hand-written sample) is left as-is: the common fresh-tenant case
  // (recreated schedule → id 1) still resolves, and there's no name to look up. A NAME is remapped.
  if (/^\d+$/.test(ref)) return config;
  const id = await resolveByName(db, "businessHours", ref, warnings);
  return { ...config, businessHoursId: id === null ? null : String(id) };
}

async function resolveByName(
  db: ScopedDb,
  _model: "businessHours" | "followUpHours",
  name: string | null,
  warnings: ImportWarning[],
): Promise<bigint | null> {
  if (!name) return null;
  // Both businessHours and followUpHours resolve against the business_hours table.
  const row = await db.businessHours.findFirst({
    where: { name },
    select: { id: true },
  });
  if (!row) {
    warnings.push({
      code: "hoursNotFound",
      params: { name },
      target: { kind: "businessHours", name },
    });
    return null;
  }
  return row.id;
}

// Recreates the bundled business-hours schedules missing on the target tenant. A same-name schedule is
// reused (warned, never overwritten) — its windows may differ from the source, so the operator should
// review it. Runs before the agent's hours/follow-up names are resolved.
async function createMissingBusinessHours(
  db: ScopedDb,
  tenantId: bigint,
  hours: ExportedBusinessHours[],
  warnings: ImportWarning[],
): Promise<void> {
  for (const h of hours) {
    const existing = await db.businessHours.findFirst({
      where: { name: h.name },
      select: { id: true },
    });
    if (existing) {
      warnings.push({
        code: "hoursReused",
        params: { name: h.name },
        target: { kind: "businessHours", name: h.name },
      });
      continue;
    }
    await db.businessHours.create({
      data: {
        tenantId,
        name: h.name,
        ...(h.timezone ? { timezone: h.timezone } : {}),
        ...(h.windows != null
          ? { windows: h.windows as Prisma.InputJsonValue }
          : {}),
        ...(h.exceptions != null
          ? { exceptions: h.exceptions as Prisma.InputJsonValue }
          : {}),
        ...(h.source ? { source: h.source } : {}),
      },
    });
    // Creating a fresh schedule is silent: a brand-new bundled schedule is correct by construction.
    // Only a same-name REUSE warns (above), so the operator verifies it matches the source.
  }
}

// Creates the bundled components missing on the target tenant. Existing same-name components are
// reused — and ONLY a reuse warns (so the operator verifies it matches the source); a fresh creation
// is silent (correct by construction). Integrations regenerate a fresh routeToken hash + reset inbound
// auth (the original secret/token never travel); the token is re-readable on the integration page.
// KBs recreate their bundled documents as UNINDEXED (source text only, no embeddings) for manual
// re-indexing, surfaced by the editor's live "needs indexing" alert rather than a one-shot warning.
async function createMissingComponents(
  db: ScopedDb,
  tenantId: bigint,
  components: ExportedComponents,
  resolveCredName: (name: string | null | undefined) => string | null,
  warnings: ImportWarning[],
): Promise<void> {
  for (const tdef of components.httpTools) {
    const existing = await db.toolDefinition.findFirst({
      where: { name: tdef.name },
      select: { id: true },
    });
    if (existing) {
      warnings.push({
        code: "httpToolReused",
        params: { name: tdef.name },
        target: { kind: "tool", name: tdef.name },
      });
      continue;
    }
    // NOTE: the import writes straight to the DB (not via the service), so canonicalize authoring
    // shapes here too; a bundle exported from a pre-normalization instance may carry JSON-Schema
    // inputSchema / single-brace placeholders.
    const { shapes } = normalizeToolShapes({
      urlTemplate: tdef.urlTemplate,
      query: tdef.query ?? {},
      headers: tdef.headers,
      body: tdef.body,
      inputSchema: tdef.inputSchema,
    });
    await db.toolDefinition.create({
      data: {
        tenantId,
        name: tdef.name,
        // label is required now; legacy exports without one fall back to the identifier.
        label: tdef.label ?? tdef.name,
        description: tdef.description ?? null,
        method: tdef.method,
        urlTemplate: (shapes.urlTemplate ?? tdef.urlTemplate) as string,
        allowedHosts: tdef.allowedHosts,
        headers: shapes.headers as Prisma.InputJsonValue,
        inputSchema: shapes.inputSchema as Prisma.InputJsonValue,
        outputSchema: tdef.outputSchema as Prisma.InputJsonValue,
        query: shapes.query as Prisma.InputJsonValue,
        body: shapes.body as Prisma.InputJsonValue,
        // Normalized like the shapes above, and for the same reason: the import writes straight to
        // the DB, so a hand-edited bundle would otherwise store a list the service would refuse.
        expectedStatuses: normalizeExpectedStatuses(tdef.expectedStatuses),
        ackEnabled: tdef.ackEnabled,
        ackMessage: tdef.ackMessage ?? null,
        credentialRef: resolveCredName(tdef.credentialRef),
        enabled: true,
      },
    });
    if (tdef.credentialRef && !resolveCredName(tdef.credentialRef)) {
      warnings.push({
        code: "httpToolCredNotFound",
        params: { tool: tdef.name, credential: tdef.credentialRef },
        target: { kind: "tool", name: tdef.name },
      });
    }
  }

  for (const m of components.mcpServers) {
    const existing = await db.mcpServerConnection.findFirst({
      where: { name: m.name },
      select: { id: true },
    });
    if (existing) {
      warnings.push({
        code: "mcpReused",
        params: { name: m.name },
        target: { kind: "mcp", name: m.name },
      });
      continue;
    }
    // This write bypasses createMcpConnection/assertTransportValid, so re-validate the stdio command
    // here: an import file is untrusted input and must not be able to persist an arbitrary launcher
    // invocation. (The runtime buildConnConfig also re-checks, so an unsafe row would never spawn, but
    // we refuse to persist it at all.)
    if (m.transport === "stdio") {
      const cmd = m.command ?? "";
      if (
        !isMcpStdioLauncher(stdioCommandLauncher(cmd)) ||
        !hasSafeStdioCommandChars(cmd)
      ) {
        warnings.push({ code: "mcpUnsafeStdio", params: { name: m.name } });
        continue;
      }
    }
    await db.mcpServerConnection.create({
      data: {
        tenantId,
        name: m.name,
        transport: m.transport,
        url: m.url ?? null,
        command: m.command ?? null,
        credentialRef: resolveCredName(m.credentialRef),
        enabled: true,
      },
    });
  }

  for (const i of components.integrations) {
    if (!isKnownCatalogType(i.catalogType)) {
      warnings.push({
        code: "integrationUnknownType",
        params: { type: i.catalogType, name: i.name },
      });
      continue;
    }
    const existing = await db.integrationInstance.findFirst({
      where: { catalogType: i.catalogType, name: i.name },
      select: { id: true },
    });
    if (existing) {
      warnings.push({
        code: "integrationReused",
        params: { type: i.catalogType, name: i.name },
        target: {
          kind: "integration",
          catalogType: i.catalogType,
          name: i.name,
        },
      });
      continue;
    }
    // Fresh route token (plaintext discarded — re-read on the integration page); inbound auth reset.
    const { hash } = generateRouteToken();
    // Resolve a business-hours reference carried by NAME in the config back to the local id (Google
    // Calendar's businessHoursId — the bundled schedule was recreated by createMissingBusinessHours).
    const config = await remapConfigBusinessHoursNameToId(
      db,
      i.config as Record<string, unknown>,
      warnings,
    );
    await db.integrationInstance.create({
      data: {
        tenantId,
        catalogType: i.catalogType,
        name: i.name,
        config: config as Prisma.InputJsonValue,
        credentialRef: resolveCredName(i.credentialRef),
        inboundAuthStrategy: "NONE",
        inboundSecretRef: null,
        routeTokenHash: hash,
        enabled: true,
      },
    });
    // Created integrations are silent (only reused ones warn). The fresh inbound token is re-readable
    // any time on the integration page; for a clone the operator wires the external webhook from scratch.
  }

  for (const kb of components.knowledgeBases) {
    const existing = await db.knowledgeBase.findFirst({
      where: { name: kb.name },
      select: { id: true },
    });
    const docCount = kb.documents?.length ?? 0;
    if (existing) {
      // Never add bundled docs to a pre-existing base — re-importing would duplicate them.
      warnings.push(
        docCount > 0
          ? {
              code: "kbReusedDocsSkipped",
              params: { name: kb.name, n: docCount },
              target: { kind: "knowledge", name: kb.name },
            }
          : {
              code: "kbReused",
              params: { name: kb.name },
              target: { kind: "knowledge", name: kb.name },
            },
      );
      continue;
    }
    const createdKb = await db.knowledgeBase.create({
      data: {
        tenantId,
        name: kb.name,
        description: kb.description ?? null,
        ...(kb.embeddingModel ? { embeddingModel: kb.embeddingModel } : {}),
        ...(kb.chunkSize != null ? { chunkSize: kb.chunkSize } : {}),
        ...(kb.chunkOverlap != null ? { chunkOverlap: kb.chunkOverlap } : {}),
      },
      select: { id: true },
    });
    if (kb.documents && kb.documents.length > 0) {
      // Recreate the source documents as UNINDEXED — NOT via createDocument (which would enqueue a RAG
      // ingest job). They stay unindexed until the operator triggers re-indexing (manual re-ingest).
      await db.knowledgeDocument.createMany({
        data: kb.documents.map((d) => ({
          tenantId,
          knowledgeBaseId: createdKb.id,
          title: d.title,
          sourceType: d.sourceType,
          fileName: d.fileName ?? null,
          mimeType: d.mimeType ?? null,
          content: d.content,
          status: "UNINDEXED",
        })),
      });
    }
    // A freshly created KB is silent (only reused ones warn). Imported-but-unindexed documents surface
    // through the editor's live "needs indexing" alert (configHealth), not a one-shot import warning.
  }
}

async function buildGrantRows(
  db: ScopedDb,
  tenantId: bigint,
  agentId: bigint,
  tools: ExportedGrant[],
  warnings: ImportWarning[],
): Promise<Prisma.AgentToolSelectionCreateManyInput[]> {
  const rows: Prisma.AgentToolSelectionCreateManyInput[] = [];
  for (const g of tools) {
    switch (g.source) {
      case "NATIVE":
        rows.push({
          tenantId,
          agentId,
          source: "NATIVE",
          enabledTools: g.enabledTools,
          knowledgeBaseIds: [],
        });
        break;
      case "RAG": {
        const kbs = await db.knowledgeBase.findMany({
          where: { name: { in: g.knowledgeBases } },
          select: { id: true, name: true },
        });
        const found = new Set(kbs.map((k) => k.name));
        for (const n of g.knowledgeBases) {
          if (!found.has(n)) {
            warnings.push({
              code: "kbGrantNotFound",
              params: { name: n },
              target: { kind: "knowledge", name: n },
            });
          }
        }
        rows.push({
          tenantId,
          agentId,
          source: "RAG",
          enabledTools: g.enabledTools,
          knowledgeBaseIds: kbs.map((k) => k.id),
        });
        break;
      }
      case "HTTP": {
        const td = await db.toolDefinition.findFirst({
          where: { name: g.tool },
          select: { id: true },
        });
        if (!td) {
          warnings.push({
            code: "httpGrantNotFound",
            params: { name: g.tool },
            target: { kind: "tool", name: g.tool },
          });
          break;
        }
        rows.push({
          tenantId,
          agentId,
          source: "HTTP",
          toolDefinitionId: td.id,
          enabledTools: g.enabledTools,
          knowledgeBaseIds: [],
        });
        break;
      }
      case "MCP": {
        const conn = await db.mcpServerConnection.findFirst({
          where: { name: g.server },
          select: { id: true },
        });
        if (!conn) {
          warnings.push({
            code: "mcpGrantNotFound",
            params: { name: g.server },
            target: { kind: "mcp", name: g.server },
          });
          break;
        }
        rows.push({
          tenantId,
          agentId,
          source: "MCP",
          mcpServerConnectionId: conn.id,
          enabledTools: g.enabledTools,
          knowledgeBaseIds: [],
        });
        break;
      }
      case "INTEGRATION": {
        const inst = await db.integrationInstance.findFirst({
          where: { catalogType: g.catalogType, name: g.integration },
          select: { id: true },
        });
        if (!inst) {
          warnings.push({
            code: "integrationGrantNotFound",
            params: { type: g.catalogType, name: g.integration },
            target: {
              kind: "integration",
              catalogType: g.catalogType,
              name: g.integration,
            },
          });
          break;
        }
        rows.push({
          tenantId,
          agentId,
          source: "INTEGRATION",
          integrationInstanceId: inst.id,
          enabledTools: g.enabledTools,
          knowledgeBaseIds: [],
        });
        break;
      }
    }
  }
  return rows;
}
