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
  credRefSlot,
  remapCredRefAt,
  SETTINGS_CREDENTIAL_PATHS,
} from "@/modules/agents/credential-paths";
import { clampOversizedTextInPlace } from "@/modules/agents/text-caps";
import {
  MAX_SCHEDULE_EXCEPTIONS,
  MAX_SCHEDULE_WINDOWS,
  parseExceptions,
  parseWindows,
  type ScheduleException,
  type WindowSpec,
} from "@/modules/business-hours/hours";
import { parseDocumentStyle } from "@/modules/documents/blocks";
import {
  slugProblem,
  templateMetadataProblem,
  templateNameSchema,
} from "@/modules/documents/templates";
import { parseAuthoredTemplate } from "@/modules/documents/validate";
import { disarmFullDetail } from "@/modules/flowlog/settings";
import { normalizeSettingsForStorage } from "@/modules/images/settings";
import { isKnownCatalogType } from "@/modules/integrations/catalog";
import { assertNoSecrets } from "@/modules/n8n-export/n8n";
import {
  canonicalBodyShape,
  unsupportedBodyShape,
} from "@/modules/tool-definitions/body-shape";
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
  // NOTE: by SLUG, not by name and not by id. The id is local to one instance, and the slug is what
  // the grant is about, since it IS the agent's tool name. It does not survive a rename on the
  // destination — the slug follows the name there too — so a renamed template no longer answers to
  // the slug the bundle asks for, and the grant lands as a `documentGrantNotFound` warning naming
  // it. No enabledTools: a template grant exposes exactly one tool.
  z.object({ source: z.literal("DOCUMENT"), documentTemplate: z.string() }),
]);

// A grant whose SOURCE this build does not know — one a newer release added — is dropped with a
// warning instead of failing the whole bundle. A discriminated union refuses the entire array on one
// unknown arm, so without this a single grant of a kind we have not heard of makes an otherwise
// importable agent unimportable, and the operator is told nothing about which part was the problem.
//
// This does NOT help an OLDER instance read a bundle written here — nothing in this file can, and
// bumping the format version would only trade a confusing refusal for a clean one while making every
// bundle without a document grant refusable too, which is the trade `riskTier` above already
// rejected for the same reason. What it does is stop the next arm from breaking this direction.
//
// Restricted to sources this build has never HEARD of. Without that restriction the fallback also
// swallowed a malformed grant from a source we do know — `{source:"DOCUMENT"}` with no template —
// dropping it silently and blaming a newer version for it, when the honest answer is that the
// bundle is broken and the import should say so.
const KNOWN_GRANT_SOURCES = new Set(
  exportedGrantSchema.options.map((o) => o.shape.source.value as string),
);
const importedGrantSchema = z.union([
  exportedGrantSchema,
  z
    .object({ source: z.string() })
    .refine((g) => !KNOWN_GRANT_SOURCES.has(g.source), {
      message: "malformed grant for a known source",
    })
    .transform(() => null),
]);

// Full component definitions (opt-in via ?components=true). Each references its credential BY NAME
// (never id, never secret); integrations carry NO inboundSecretRef/routeTokenHash (regenerated on
// import). Knowledge bases carry metadata; their documents' SOURCE TEXT is bundled only with the
// separate ?documents opt-in (re-chunked + re-embedded at the destination — embeddings/chunks, being
// derived and model-specific, are never exported).
// Wire-format constant, not data. `tool_definitions.risk_tier` was retired behind `@ignore` (#176)
// and then dropped from the database (#149), so there is no field on the row to read: the export
// writes this instead. The KEY stays on the wire for the reason spelled out on `riskTier` below,
// and the value is arbitrary because no build in any supported version acts on it.
const RETIRED_RISK_TIER = "medium";

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
  // Retired (issue #137) and read by nothing. The KEY outlives the column, and outlives the schema
  // ignoring it, because they are different compatibility surfaces. A rollback is one operator on one instance minutes apart,
  // which is what #149's one-release wait bounds; a bundle is a file handed to ANOTHER instance at
  // an arbitrary version, and the format is versioned as a whole (`version: z.literal(1)`), so an
  // instance one release behind parses our bundle with a schema where this key is REQUIRED.
  // Omitting it would make every bundle this build writes unimportable there, and bumping the
  // version would only trade that for a cleaner refusal while also making THIS build reject every
  // v1 bundle. So the export echoes RETIRED_RISK_TIER instead of the row, and this stays optional
  // in both directions: a bundle written after the column is dropped still imports, and one written
  // before it does too, with the value discarded on the way in.
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
const exportedDocumentTemplateSchema = z.object({
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable().optional(),
  blocks: z.array(z.unknown()),
  fields: z.array(z.unknown()),
  style: z.record(z.string(), z.unknown()).optional(),
  numberPrefix: z.string().nullable().optional(),
  // Optional so a bundle from before this field still imports; absent means enabled, which is the
  // column default and what every such bundle described.
  enabled: z.boolean().optional(),
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
  // Optional for back-compat: an export written before document templates existed simply has none.
  documentTemplates: z.array(exportedDocumentTemplateSchema).optional(),
  knowledgeBases: z.array(exportedKnowledgeBaseSchema),
  businessHours: z.array(exportedBusinessHoursSchema).optional(),
});

// Every component array a bundle can carry, named once. A dry run has to disclose all of them — the
// apply creates or reuses each before it assigns the grants — and "the preview forgot the array that
// was just added" is a hole nobody sees, because a preview that omits something looks like a preview
// of a smaller change. Read from the schema so the list cannot drift from the bundle.
export const EXPORTED_COMPONENT_KEYS = Object.keys(
  exportedComponentsSchema.shape,
) as (keyof z.infer<typeof exportedComponentsSchema>)[];

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
    // Tolerant on the way IN: a grant of a source this build does not know is dropped rather than
    // taking the bundle with it (see importedGrantSchema). Nulls are filtered where they are read.
    tools: z.array(importedGrantSchema),
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
  | { kind: "document"; name: string }
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
  for (const { path } of SETTINGS_CREDENTIAL_PATHS) {
    const slot = credRefSlot(settings, path);
    const ref = slot?.holder[slot.key];
    if (typeof ref === "string" && ref) refs.push(ref);
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
  for (const { path, tab, sectionId } of SETTINGS_CREDENTIAL_PATHS) {
    const slot = credRefSlot(settings, path);
    if (slot) add(slot.holder[slot.key], tab, sectionId);
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
  // NOTE: each pass returns a NEW root and the next one reads it, since two paths share the `tts`
  // block and the second must see the first one's rewrite.
  let st: Record<string, unknown> = { ...settings };
  for (const { path } of SETTINGS_CREDENTIAL_PATHS) {
    st = remapCredRefAt(st, path, map);
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
  // A document template's blocks and style are TENANT PROSE, exactly like a knowledge-base
  // document's text, and the scanner cannot tell an operator writing "api_key=abcdef" in a quote's
  // terms from a leaked credential. Left in, that quote makes its own agent unexportable — the
  // scanner refusing the export it exists to protect. Blanked in the CLONE only; what is returned
  // still carries the prose.
  for (const tpl of clone.components?.documentTemplates ?? []) {
    tpl.blocks = [];
    tpl.style = {};
    tpl.description = null;
    // A field's LABEL and DESCRIPTION are prose too — the description is what the operator writes to
    // tell the model what to put in the field ("o CNPJ do cliente, ex: 12.345.678/0001-90"), which
    // is exactly the shape a secret regex reads as a credential. The `name` and `type` stay
    // scanned: they are the tool contract, identifiers, and no place to hide anything.
    tpl.fields = (tpl.fields as Record<string, unknown>[]).map((f) => ({
      ...f,
      label: "",
      description: null,
    }));
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
        documentTemplateId: true,
        toolDefinition: { select: { name: true } },
        mcpServerConnection: { select: { name: true } },
        integrationInstance: { select: { catalogType: true, name: true } },
        documentTemplate: { select: { slug: true } },
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
        case "DOCUMENT":
          if (g.documentTemplate) {
            tools.push({
              source: "DOCUMENT",
              documentTemplate: g.documentTemplate.slug,
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
      const documentTemplateIds = [
        ...new Set(
          grants
            .filter((g) => g.source === "DOCUMENT")
            .map((g) => g.documentTemplateId)
            .filter((x): x is bigint => x != null),
        ),
      ];
      const documentTemplateRows = documentTemplateIds.length
        ? await db.documentTemplate.findMany({
            where: { id: { in: documentTemplateIds } },
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
          riskTier: RETIRED_RISK_TIER,
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
        // No credential of any kind travels here, which is what makes a document template the
        // simplest component: blocks, fields and style are plain JSON the destination re-validates.
        documentTemplates: documentTemplateRows.map((r) => ({
          name: r.name,
          slug: r.slug,
          description: r.description,
          blocks: (r.blocks ?? []) as unknown[],
          fields: (r.fields ?? []) as unknown[],
          style: (r.style ?? {}) as Record<string, unknown>,
          numberPrefix: r.numberPrefix,
          // A template the operator turned OFF is off for a reason. Omitted, the import recreates it
          // with the column default — enabled — and the destination agent can issue a document the
          // source instance had deliberately made unavailable.
          enabled: r.enabled,
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
          // Carried through explicitly, like every other list here: this object is REBUILT rather
          // than spread, so a component the rebuild forgets is exported as a grant pointing at
          // nothing and the import can only drop it with a warning.
          documentTemplates: componentsRaw.documentTemplates,
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
        settings: disarmFullDetail(
          normalizeSettingsForStorage(settings) ?? settings,
        ) as Prisma.InputJsonValue,
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

    // Grants of a source this build does not know arrive as null (see importedGrantSchema) and are
    // dropped here, with a warning naming how many — the bundle imports, and the operator learns
    // that something in it did not.
    const knownGrants = exp.tools.filter(
      (g): g is Exclude<typeof g, null> => g !== null,
    );
    const unknownGrants = exp.tools.length - knownGrants.length;
    if (unknownGrants > 0) {
      warnings.push({
        code: "unknownGrantSourceSkipped",
        params: { n: unknownGrants },
      });
    }
    const grantRows = await buildGrantRows(
      db,
      tenantId,
      created.id,
      knownGrants,
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
type EntryFate = "dropped" | "altered" | "intact";

// How many bundled entries do not reach the column as written. Three things it has to get right, and
// each one was a wrong answer first:
//
//   - a subtraction of ARRAY LENGTHS misses the entry that survives and still loses something.
//     `parseExceptions` prunes the RANGES inside an exception it keeps, so a half-day written
//     backwards (14:00–09:00) loses its only range and lands as `ranges: []`, which means CLOSED ALL
//     DAY: a different schedule than the bundle asked for, arriving with nothing said;
//   - the verdict per entry is taken by running the REAL parser over that entry alone, never by a
//     second copy of its rules, so this cannot drift from what actually gets stored;
//   - the cap counts SURVIVORS, not positions. A malformed entry does not consume a slot, so testing
//     the first `cap` raw items over-reports by one for every one of them (measured: one bad window
//     followed by 200 good ones stores all 200 and would have been reported as two lost). The walk
//     below therefore tracks how many have been stored so far, which is exactly what decides whether
//     the next survivor lands or is truncated away.
function countNotStoredAsWritten(
  raw: unknown[],
  cap: number,
  fateOf: (item: unknown) => EntryFate,
): number {
  let stored = 0;
  let lost = 0;
  for (const item of raw) {
    const fate = fateOf(item);
    if (fate === "dropped" || stored >= cap) {
      lost++;
      continue;
    }
    stored++;
    if (fate === "altered") lost++;
  }
  return lost;
}

// The ranges a bundled exception CLAIMS, before any of them is judged. Read off the raw entry, since
// the parsed one only ever reports the survivors.
function rangeCount(item: unknown): number {
  const ranges = (item as { ranges?: unknown })?.ranges;
  return Array.isArray(ranges) ? ranges.length : 0;
}

// The half of a bundled schedule this instance can actually read, with everything it dropped named
// in a warning. Both JSON columns arrive as `z.array(z.unknown())` and this path writes to the table
// directly rather than through `createBusinessHours`, so the import is the one writer that never
// answers to `businessHoursCreateSchema`: nothing between a hand-authored file and the column asks
// whether an entry is readable at all.
//
// Storing what the READER surfaces settles that, and the reader is the right authority precisely
// because it is entry-by-entry and bounded. One unreadable window then costs that window instead of
// the whole grid, which matters here more than the tidiness suggests: an empty grid is not "closed",
// it is ALWAYS OPEN, so the as-a-unit reading turned a typo in a bundle into an agent that answers
// around the clock on the destination tenant (issue #346).
//
// The two rejected alternatives fail in that same direction. Refusing the whole BUNDLE over one
// field is the wrong trade for a bulk restore. SKIPPING just this schedule is worse than it looks:
// the agent then resolves no business hours at all, which is the very always-open state being fixed.
// So the schedule always lands, carrying what could be read, and the warning is what keeps the drop
// from being one more silence.
function readableSchedule(
  h: ExportedBusinessHours,
  warnings: ImportWarning[],
): { windows: WindowSpec[]; exceptions: ScheduleException[] } {
  const windows = parseWindows(h.windows ?? []);
  // `parseExceptions` deliberately does NOT cap (dropping a closure widens availability, so the
  // reader must never do it to a row already written). The bound is this writer's job, and here it
  // is safe for the reason it is not there: it applies to a row being created, and it is warned.
  const exceptions = parseExceptions(h.exceptions ?? []).slice(
    0,
    MAX_SCHEDULE_EXCEPTIONS,
  );
  const dropped: [string, number][] = [
    [
      "hoursWindowsDropped",
      countNotStoredAsWritten(h.windows ?? [], MAX_SCHEDULE_WINDOWS, (item) =>
        parseWindows([item]).length === 1 ? "intact" : "dropped",
      ),
    ],
    [
      "hoursExceptionsDropped",
      countNotStoredAsWritten(
        h.exceptions ?? [],
        MAX_SCHEDULE_EXCEPTIONS,
        (item) => {
          const [one] = parseExceptions([item]);
          if (one === undefined) return "dropped";
          return one.ranges.length === rangeCount(item) ? "intact" : "altered";
        },
      ),
    ],
  ];
  for (const [code, count] of dropped) {
    if (count <= 0) continue;
    warnings.push({
      code,
      params: { name: h.name, count },
      target: { kind: "businessHours", name: h.name },
    });
  }
  return { windows, exceptions };
}

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
    const { windows, exceptions } = readableSchedule(h, warnings);
    await db.businessHours.create({
      data: {
        tenantId,
        name: h.name,
        ...(h.timezone ? { timezone: h.timezone } : {}),
        ...(h.windows != null
          ? { windows: windows as Prisma.InputJsonValue }
          : {}),
        ...(h.exceptions != null
          ? { exceptions: exceptions as Prisma.InputJsonValue }
          : {}),
        ...(h.source ? { source: h.source } : {}),
      },
    });
    // Creating a fresh schedule is silent when it arrived intact: a brand-new bundled schedule is
    // correct by construction. Only a same-name REUSE warns (above), and a DROP (readableSchedule),
    // which the operator has no other way to notice.
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
    // A body shape this version refuses is CANONICALIZED rather than refused, the same trade the
    // expectedStatuses line below makes: failing a whole bundle over an untidily stored body would
    // be worse than importing it. `canonicalBodyShape` returns what `parseBody` was already
    // executing, so the outbound request is byte-identical and only the storage stops holding keys
    // nothing reads. Blanking it to `{}` would NOT be equivalent: that is behaviour-preserving only
    // for a body with no recognized mode, and would switch a `{mode:"raw", …, extra}` tool to the
    // fields assembly — changing what it sends (issue #150).
    const badBody = unsupportedBodyShape(tdef.body);
    const { shapes } = normalizeToolShapes({
      urlTemplate: tdef.urlTemplate,
      query: tdef.query ?? {},
      headers: tdef.headers,
      body: badBody ? canonicalBodyShape(tdef.body) : tdef.body,
      inputSchema: tdef.inputSchema,
    });
    // `createMany({ skipDuplicates })` rather than `create`, for the reason spelled out on the
    // document-template loop below: the pre-check above can answer "free" and a concurrent writer
    // commit before this insert, and a P2002 here does not cost one tool: the whole import runs
    // inside ONE `runScopedOn` transaction, so it aborts that transaction and every statement after
    // it fails with "current transaction is aborted" (issue #221).
    const { count } = await db.toolDefinition.createMany({
      data: [
        {
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
      ],
      skipDuplicates: true,
    });
    if (count === 0) {
      // Lost the race. The name is taken now, which is exactly the reuse the pre-check reports.
      warnings.push({
        code: "httpToolReused",
        params: { name: tdef.name },
        target: { kind: "tool", name: tdef.name },
      });
      continue;
    }
    // Both warnings below describe the row that was just written, so they wait for the insert to
    // report one: the reuse path above says nothing about a body or a credential it did not store.
    if (badBody) {
      warnings.push({
        code: "httpToolBodyIgnored",
        params: { name: tdef.name },
        target: { kind: "tool", name: tdef.name },
      });
    }
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
    // `createMany({ skipDuplicates })` for the same reason as the loop above: a lost race on
    // `@@unique([tenantId, name])` would abort the enclosing transaction and take the whole import
    // with it (issue #221).
    const { count } = await db.mcpServerConnection.createMany({
      data: [
        {
          tenantId,
          name: m.name,
          transport: m.transport,
          url: m.url ?? null,
          command: m.command ?? null,
          credentialRef: resolveCredName(m.credentialRef),
          enabled: true,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 0) {
      warnings.push({
        code: "mcpReused",
        params: { name: m.name },
        target: { kind: "mcp", name: m.name },
      });
    }
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
    //
    // Collected aside rather than pushed straight through: what it reports is a reference inside the
    // config THIS iteration built, and that config is discarded if the insert below turns out to be
    // a reuse. The pre-check path never emitted it (it `continue`s first), and the race path is the
    // same outcome reached later.
    const configWarnings: ImportWarning[] = [];
    const config = await remapConfigBusinessHoursNameToId(
      db,
      i.config as Record<string, unknown>,
      configWarnings,
    );
    // `createMany({ skipDuplicates })` for the same reason as the loops above: a lost race on
    // `@@unique([tenantId, catalogType, name])` would abort the enclosing transaction and take the
    // whole import with it (issue #221). `routeTokenHash` is unique too and also covered by the
    // ON CONFLICT, but it is 32 fresh random bytes hashed, so a skip here is the name, in practice.
    const { count } = await db.integrationInstance.createMany({
      data: [
        {
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
      ],
      skipDuplicates: true,
    });
    if (count === 0) {
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
    warnings.push(...configWarnings);
    // Created integrations are silent (only reused ones warn). The fresh inbound token is re-readable
    // any time on the integration page; for a clone the operator wires the external webhook from scratch.
  }

  for (const tpl of components.documentTemplates ?? []) {
    const existing = await db.documentTemplate.findFirst({
      where: { slug: tpl.slug },
      select: { id: true },
    });
    if (existing) {
      warnings.push({
        code: "documentTemplateReused",
        params: { name: tpl.name },
        target: { kind: "document", name: tpl.slug },
      });
      continue;
    }
    // Re-validated on the way IN, never trusted as exported: a template written by a newer build can
    // carry a block this one does not know how to render, and a warning that names the reason is a
    // better import than a document that renders wrong in front of a customer.
    //
    // The SLUG goes through the same gate as a hand-written one. A bundle is user-supplied, and the
    // slug becomes a tool name: one reading `image` produces `send_image`, which the assembly then
    // drops as a duplicate of the built-in — the operator would see a granted template whose tool
    // never appears, with nothing anywhere saying why.
    // A bundle is hand-editable, and this path writes to the table directly rather than through
    // createDocumentTemplate — so every rule that write applies has to be applied here too. The
    // description is the one that bites: it is appended verbatim to the agent's tool description on
    // every turn, and an oversized one arriving in a bundle would do that on the destination.
    const metaFault =
      templateMetadataProblem({
        name: tpl.name,
        description: tpl.description ?? null,
        numberPrefix: tpl.numberPrefix ?? null,
      }) ?? (slugProblem(tpl.slug) ? `slug: ${slugProblem(tpl.slug)}.` : null);
    const content = metaFault
      ? ({ ok: false, reason: metaFault } as const)
      : parseAuthoredTemplate(tpl.blocks, tpl.fields, tpl.style);
    if (!content.ok) {
      warnings.push({
        code: "documentTemplateInvalid",
        params: { name: tpl.name, reason: content.reason },
      });
      continue;
    }
    // The NAME is unique per tenant too, and separately from the slug — so a bundle can arrive with a
    // free slug and a name this account already uses. Not reused like a slug match: the grant below
    // resolves by SLUG, so binding it to the template that holds the name would hand the agent a
    // tool with a different name than the bundle asked for. Skipped and said out loud instead, which
    // leaves the operator one rename away on either side.
    //
    // Asked AFTER the validity gate, and the order is the message: a bundle carrying a template that
    // is both unreadable and named like an existing one is more usefully told about the first.
    // not-caller-input: a name read off the template being imported, not a value from this request
    const approvedName = templateNameSchema.parse(tpl.name);
    const nameHolder = await db.documentTemplate.findFirst({
      where: { name: approvedName },
      select: { slug: true },
    });
    if (nameHolder) {
      warnings.push({
        code: "documentTemplateNameTaken",
        params: { name: approvedName, existing: nameHolder.slug },
        target: { kind: "document", name: tpl.slug },
      });
      continue;
    }
    // `createMany({ skipDuplicates })` rather than `create`, and the enclosing transaction is the
    // whole reason. Both pre-checks above can answer "free" and a writer commit before this insert
    // — a second import, or someone saving a template in the console. A P2002 here does not cost one
    // template: `importAgent` runs the ENTIRE import inside one `runScopedOn` transaction, so it
    // aborts that transaction, every statement after it fails with "current transaction is aborted",
    // and the operator loses the agent, the tools and the knowledge bases to a race over a name.
    //
    // A `catch` around the insert is the trap, not the remedy: by the time it runs the transaction
    // is already dead, so it swallows the one legible error and replaces it with a confusing one.
    // Only NOT RAISING works, and `ON CONFLICT DO NOTHING` covers BOTH unique indexes on this table,
    // which is what the two pre-checks were separately trying to do.
    const { count } = await db.documentTemplate.createMany({
      data: [
        {
          tenantId,
          // The value the gate APPROVED, not the one it was handed: `templateNameSchema` trims
          // before it measures, so a name padded with whitespace passes a bound the raw string
          // fails. The name becomes the tool's title, carried by every granted agent on every turn.
          name: approvedName,
          slug: tpl.slug,
          description: tpl.description ?? null,
          blocks: content.content.blocks as unknown as Prisma.InputJsonValue,
          fields: content.content.fields as unknown as Prisma.InputJsonValue,
          style: parseDocumentStyle(
            tpl.style,
          ) as unknown as Prisma.InputJsonValue,
          numberPrefix: tpl.numberPrefix ?? null,
          enabled: tpl.enabled ?? true,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 0) {
      // Lost the race. WHICH warning is right depends on which index refused, so it is re-asked
      // rather than guessed — the row is committed by now, and each statement in a READ COMMITTED
      // transaction takes a fresh snapshot, so this read sees it.
      const holder = await db.documentTemplate.findFirst({
        where: { name: approvedName },
        select: { slug: true },
      });
      warnings.push(
        holder
          ? {
              code: "documentTemplateNameTaken",
              params: { name: approvedName, existing: holder.slug },
              target: { kind: "document", name: tpl.slug },
            }
          : {
              code: "documentTemplateReused",
              params: { name: tpl.name },
              target: { kind: "document", name: tpl.slug },
            },
      );
    }
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
      case "DOCUMENT": {
        const tpl = await db.documentTemplate.findFirst({
          where: { slug: g.documentTemplate },
          select: { id: true },
        });
        if (!tpl) {
          warnings.push({
            code: "documentGrantNotFound",
            params: { name: g.documentTemplate },
            target: { kind: "document", name: g.documentTemplate },
          });
          break;
        }
        rows.push({
          tenantId,
          agentId,
          source: "DOCUMENT",
          documentTemplateId: tpl.id,
          enabledTools: [],
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
