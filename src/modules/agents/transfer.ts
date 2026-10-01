// Agent export/import: share an agent's full configuration across tenants and instances WITHOUT
// ever moving a secret. A Full-distribution feature.
//
// The export references everything BY NAME (never by id, never a secret value). Credential refs are
// `vault:<id>` internally, so export maps id to name and import maps name back in the target tenant;
// `assertNoSecrets` refuses an export where a secret-shaped value slipped in. Import recreates the
// agent DISABLED; a missing credential becomes an empty PENDING vault entry with the ref kept wired,
// and anything still unresolvable is a warning, never a failure.

import { z } from "zod";
import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import {
  currentNativeToolName,
  isNativeToolName,
  NATIVE_TOOL_NAMES,
  RENAMED_NATIVE_TOOLS,
} from "@/graph/tools/catalog";
import { SANDBOX_CODE_MAX_CHARS } from "@/graph/tools/code-sandbox-limits";
import { normalizeExpectedStatuses } from "@/graph/tools/http-status";
import { normalizeToolName } from "@/graph/tools/toolName";
import { checkCodeToolSyntax } from "@/lib/code-tool-syntax";
import { parseDbId } from "@/lib/db-id";
import { AppError, NotFoundError } from "@/lib/errors";
import {
  hasSafeStdioCommandChars,
  isMcpStdioLauncher,
  stdioCommandLauncher,
} from "@/lib/mcp-launchers";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { clipText } from "@/lib/text";
import { auditSafe } from "@/modules/agents/audit-projection";
import {
  type CredentialFieldTab,
  collectCredentialRefWrites,
  credRefSlot,
  remapCredRefAt,
  SETTINGS_CREDENTIAL_PATHS,
} from "@/modules/agents/credential-paths";
import {
  clampOversizedTextInPlace,
  TOOL_INSTRUCTIONS_MAX,
} from "@/modules/agents/text-caps";
import {
  ALLOWED_LABELS_MAX,
  PROTECTED_LABELS_MAX,
} from "@/modules/agents/tool-guidance";
import { auditMutation } from "@/modules/audit/service";
import {
  MAX_SCHEDULE_EXCEPTIONS,
  MAX_SCHEDULE_WINDOWS,
  parseExceptions,
  parseWindows,
  type ScheduleException,
  type WindowSpec,
} from "@/modules/business-hours/hours";
import { parseDocumentStyle } from "@/modules/documents/blocks";
import { documentToolName } from "@/modules/documents/slug";
import {
  slugProblem,
  templateMetadataProblem,
  templateNameSchema,
} from "@/modules/documents/templates";
import { parseAuthoredTemplate } from "@/modules/documents/validate";
import { disarmFullDetail } from "@/modules/flowlog/settings";
import { normalizeSettingsForStorage } from "@/modules/images/settings";
import {
  getCatalogEntry,
  isKnownCatalogType,
} from "@/modules/integrations/catalog";
import {
  credentialHeaderName,
  mcpHeadersProblem,
  readMcpHeaders,
} from "@/modules/mcp-connections/headers";
import {
  assertNoSecrets,
  assertNoSecretsInCode,
} from "@/modules/n8n-export/n8n";
import { knowledgeBaseNameUsable } from "@/modules/rag/service";
import { armSourceSync, parseSourceInput } from "@/modules/rag/source";
import { readAppointmentDeclaration } from "@/modules/tool-definitions/appointment";
import {
  canonicalBodyShape,
  unsupportedBodyShape,
} from "@/modules/tool-definitions/body-shape";
import {
  documentHoldingToolName,
  isRagToolName,
  lockToolNames,
  toolHoldingName,
  toolsUnderModelName,
  toolUnderModelName,
} from "@/modules/tool-definitions/namespace";
import { normalizeToolShapes } from "@/modules/tool-definitions/normalize";
import {
  effectiveMaxResponseChars,
  storableResponseTemplate,
} from "@/modules/tool-definitions/response-template";
import {
  type HttpToolMethod,
  readHttpMethod,
  relativeTemplateHasBase,
  TOOL_LABEL_MAX,
  urlTemplateProblem,
} from "@/modules/tool-definitions/service";
import { credentialServes } from "@/modules/vault/secret-types";
import {
  assertPendingVaultEntryCreatable,
  ensurePendingVaultEntryOn,
  formatVaultRef,
  isVaultIdRef,
  readVaultRefFacts,
  readVaultRefId,
  resolveVaultRefByNameOn,
  storedVaultName,
  VAULT_REF_PREFIX,
  type VaultEntryFacts,
} from "@/modules/vault/service";
import { generateRouteToken } from "@/modules/webhooks/inbound/route-token";
import { ensureInboundSweep } from "@/modules/webhooks/inbound/sweep";
import {
  AGENT_SELECT,
  type AgentDto,
  assertPromptSize,
  dropUnusableImportedSettingsInPlace,
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
  // By NAME, like an HTTP tool's. No enabledTools: a code tool grant exposes exactly one tool, the
  // way a document template's does.
  z.object({ source: z.literal("CODE"), tool: z.string() }),
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

// A grant whose SOURCE this build has never heard of (a newer release added it) is dropped with a
// warning instead of failing the bundle, since a discriminated union refuses the whole array on one
// unknown arm. A malformed grant from a KNOWN source still fails: the bundle is broken, not newer.
// This does not help an older instance read a bundle written here; nothing in this file can.
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

// Wire-format constant: the risk tier column no longer exists, but the `riskTier` key stays on the
// wire (see below), and its value is arbitrary because no supported version acts on it.
const RETIRED_RISK_TIER = "medium";

// A field map as the bundle wrote it, kept KEY FOR KEY. `z.record` would rebuild it, and the one
// name that cannot survive that (`__proto__`, which hits the prototype setter) is exactly the one
// the normalizer is supposed to drop with a warning further down.
const rawFieldMap = z.custom<Record<string, unknown>>(
  (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  { message: "expected an object" },
);

const exportedHttpToolSchema = z.object({
  name: z.string(),
  label: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  method: z.string(),
  urlTemplate: z.string(),
  allowedHosts: z.array(z.string()),
  headers: z.record(z.string(), z.unknown()),
  // Passed through raw, for the reason the code tool's carries.
  inputSchema: rawFieldMap,
  outputSchema: z.record(z.string(), z.unknown()),
  // Optional so exports produced before query existed still import (defaults to {}).
  query: z.record(z.string(), z.unknown()).optional(),
  body: z.record(z.string(), z.unknown()),
  // Read by nothing, but the KEY stays: a bundle is read by other instances at arbitrary versions
  // under one format version, and an instance one release behind requires it. Omitting it would make
  // every bundle written here unimportable there, and bumping the version would make this build
  // reject every v1 bundle. So the export writes RETIRED_RISK_TIER, and the key is optional both ways.
  riskTier: z.string().optional(),
  ackEnabled: z.boolean(),
  ackMessage: z.string().nullable().optional(),
  credentialRef: z.string().nullable().optional(),
  // Optional so older bundles still import; absent is [], "every non-2xx is a failure".
  expectedStatuses: z.array(z.number()).optional(),
  // Optional: a bundle from before the column carries nothing, which is what every tool declared then.
  appointment: z.record(z.string(), z.unknown()).nullable().optional(),
  // The NAME of the GENERIC integration this tool hands `{{conversation_ref}}` for, bundled beside it
  // in `integrations`. By name because an id is tenant-local; optional for older bundles.
  conversationRefIntegration: z.string().nullable().optional(),
  // This tool's ceiling on what the model receives; absent or null is the default.
  maxResponseChars: z.number().nullable().optional(),
});
// An operator-authored code tool. The body is its wiring, the way an HTTP tool's request is, and it
// travels so the grant points at something. No credential: the sandbox reaches nothing outside the
// thread.
const exportedCodeToolSchema = z.object({
  name: z.string(),
  label: z.string().nullable().optional(),
  // The column is required (it is the only thing that tells the model when to call), and the
  // service refuses an empty one. Tolerated here and filled from the label, because refusing a
  // whole bundle over it is the trade this file already rejects for prose.
  description: z.string().nullable().optional(),
  // NOT `z.record`: that rebuilds the map by assignment, and an own `__proto__` key would be gone
  // before `normalizeToolShapes` could drop it with the warning this import promises. Passed
  // through as it arrived, shape-checked only.
  inputSchema: rawFieldMap,
  // Bounded as the service bounds it, and REFUSED rather than warned, the way the system prompt's
  // cap is: the body is handed to a thread as source, and past the cap it is a pasted library,
  // not a tool. There is no clamped body that is still the same tool.
  code: z.string().min(1).max(SANDBOX_CODE_MAX_CHARS),
  enabled: z.boolean().optional(),
});
const exportedMcpServerSchema = z.object({
  name: z.string(),
  transport: z.string(),
  url: z.string().nullable().optional(),
  command: z.string().nullable().optional(),
  credentialRef: z.string().nullable().optional(),
  // Optional for back-compat: an export written before connection headers existed has none. The
  // templates travel, never a resolved value.
  headers: z.record(z.string(), z.unknown()).optional(),
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
  // A synced document's article, carried so a base that keeps its source at the destination readopts
  // these documents by id instead of copying each; optional for older bundles.
  externalId: z.string().nullable().optional(),
  sourceUrl: z.string().nullable().optional(),
});
// A base's help center source, as the operator configured it. Re-validated on import like the write
// validates it, so a bundle cannot store what the API would refuse.
const exportedKnowledgeSourceSchema = z.object({
  kind: z.string(),
  baseUrl: z.string(),
  slug: z.string(),
  locale: z.string(),
  excludeIds: z.array(z.number()).optional(),
  intervalMinutes: z.number().optional(),
});
const exportedKnowledgeBaseSchema = z.object({
  name: z.string(),
  description: z.string().nullable().optional(),
  embeddingModel: z.string().optional(),
  chunkSize: z.number().optional(),
  chunkOverlap: z.number().optional(),
  // Optional for older bundles: absent reads as off, the column default.
  stripContactFooters: z.boolean().optional(),
  // Optional: absent (older bundles) and null both mean the base mirrors nothing.
  source: exportedKnowledgeSourceSchema.nullable().optional(),
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
// Full component definitions (opt-in via ?components=true), each credential by NAME. Integrations
// carry no inbound secret or route token hash (regenerated on import). Knowledge base document text
// travels only with ?documents, and is re-chunked and re-embedded at the destination.
const exportedComponentsSchema = z.object({
  httpTools: z.array(exportedHttpToolSchema),
  // Optional for back-compat: a bundle written before code tools existed simply has none.
  codeTools: z.array(exportedCodeToolSchema).optional(),
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
export type ExportedHttpTool = z.infer<typeof exportedHttpToolSchema>;
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
  | { kind: "codeTool"; name: string }
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
    // The TARGET is part of the identity: two warnings with the same code and rendered params
    // can be about different components (a clipped name param makes two bases look alike). The
    // duplicates this exists for (one credential referenced from several paths) share the target.
    const key = `${w.code}|${JSON.stringify(w.params ?? {})}|${JSON.stringify(
      w.target ?? {},
    )}`;
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
// the rest live once the agent is open. The section ids mirror config-health.ts.
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

// The editor location of a credential field named by its DOTTED PATH, which is how a refusal and an
// import warning about a stored ref name it (`settings.tts.credentialRef`). The sibling above keys
// the same map by credential NAME, which only works while the ref is still portable — after the
// remap there are no names left, only `vault:<id>`.
export function fieldTargetForPath(path: string): ImportWarningTarget {
  if (path === "modelConfig.credentialRef") {
    return { kind: "agentField", tab: "general", sectionId: "general-model" };
  }
  for (const { path: p, tab, sectionId } of SETTINGS_CREDENTIAL_PATHS) {
    if (`settings.${p.join(".")}` === path) {
      return { kind: "agentField", tab, sectionId };
    }
  }
  return { kind: "vault" };
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
  // Each pass returns a NEW root and the next one reads it, since two paths share the `tts`
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
  // NOTE: a code tool's BODY is not exempt, it is scanned by a DIFFERENT reader
  // (assertNoSecretsInCode, called on the real bodies below) and blanked here so the structured
  // matcher does not see it twice. The reason is that a body is neither prose nor a JSON value: in
  // a program `password: input.password` is a reference, and refusing it makes the agent that owns
  // such a tool unexportable, while a quoted literal in the same position is the leak the scanner
  // exists to catch. The sandbox has no credential slot, so a secret in the body is the only way
  // one reaches a code tool, and an export carrying it would hand it to every instance the bundle
  // lands on.
  for (const ct of clone.components?.codeTools ?? []) ct.code = "";
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
        codeToolDefinitionId: true,
        toolDefinition: { select: { name: true } },
        codeToolDefinition: { select: { name: true } },
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
              stripContactFooters: true,
              source: {
                select: { kind: true, config: true, intervalMinutes: true },
              },
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
        case "CODE":
          if (g.codeToolDefinition) {
            tools.push({ source: "CODE", tool: g.codeToolDefinition.name });
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
      const codeIds = [
        ...new Set(
          grants
            .filter((g) => g.source === "CODE")
            .map((g) => g.codeToolDefinitionId)
            .filter((x): x is bigint => x != null),
        ),
      ];
      const httpRows = httpIds.length
        ? await db.toolDefinition.findMany({ where: { id: { in: httpIds } } })
        : [];
      // The GENERIC instances the bundled tools hand `{{conversation_ref}}` for travel with them:
      // nothing grants a GENERIC to an agent, so the grant walk above never finds them, and a tool
      // imported without its instance refuses every call at the destination.
      const refIntegrationIds = httpRows
        .map((r) => r.conversationRefIntegrationId)
        .filter((x): x is bigint => x != null);
      const codeRows = codeIds.length
        ? await db.codeToolDefinition.findMany({
            where: { id: { in: codeIds } },
          })
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
      const allIntegrationIds = [
        ...new Set([...integrationIds, ...refIntegrationIds]),
      ];
      const integrationRows = allIntegrationIds.length
        ? await db.integrationInstance.findMany({
            where: { id: { in: allIntegrationIds } },
          })
        : [];
      const integrationNameById = new Map(
        integrationRows.map((r) => [r.id.toString(), r.name]),
      );
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
                externalId: true,
                sourceUrl: true,
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
          externalId: d.externalId,
          sourceUrl: d.sourceUrl,
        });
        docsByKb.set(d.knowledgeBaseId, list);
      }
      // Bundle the referenced business-hours schedules so import can RECREATE them (not just reuse a
      // same-name one or leave the agent's hours unset). Dedup the refs: the agent's hours + follow-up,
      // AND the ones referenced INSIDE integration configs (e.g. Google Calendar's `businessHoursId`) —
      // those are otherwise a dead id at the destination, since the config is not remapped on import.
      const configBhIds = integrationRows.flatMap((r) => {
        const id = configBusinessHoursId(
          r.config as Record<string, unknown> | null,
        );
        return id === null ? [] : [id];
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
          // NOTE: Carried, because a bundle that drops it re-imports the tool WITHOUT its declaration,
          // and the agent then books appointments the platform never hears about.
          appointment: (r.appointment ?? null) as Record<
            string,
            unknown
          > | null,
          conversationRefIntegration:
            r.conversationRefIntegrationId != null
              ? (integrationNameById.get(
                  r.conversationRefIntegrationId.toString(),
                ) ?? null)
              : null,
          maxResponseChars: r.maxResponseChars,
        })),
        codeTools: codeRows.map((r) => ({
          name: r.name,
          label: r.label,
          description: r.description,
          inputSchema: (r.inputSchema ?? {}) as Record<string, unknown>,
          code: r.code,
          // Carried for the reason a document template's is: a tool the operator turned OFF is
          // off for a reason, and the column default would turn it back on at the destination.
          enabled: r.enabled,
        })),
        mcpServers: mcpRows.map((r) => ({
          name: r.name,
          transport: r.transport,
          url: r.url,
          command: r.command,
          credentialRef: r.credentialRef,
          headers: readMcpHeaders(r.headers),
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
          stripContactFooters: r.stripContactFooters,
          source: r.source
            ? {
                kind: r.source.kind,
                ...(r.source.config as {
                  baseUrl: string;
                  slug: string;
                  locale: string;
                  excludeIds: number[];
                }),
                intervalMinutes: r.source.intervalMinutes,
              }
            : null,
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
        // malformed, or past what a bigint column holds → skipped (translates to unset)
        const id = readVaultRefId(r);
        if (id !== null) ids.push(id);
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
          codeTools: componentsRaw.codeTools,
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
  // The bodies themselves, through the reader written for source rather than for values.
  for (const ct of data.components?.codeTools ?? []) {
    assertNoSecretsInCode(ct.code, `$.components.codeTools.${ct.name}.code`);
  }
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

// The dry run IS the apply, rolled back: the preview runs the import and throws this at the end,
// inside the transaction, so what it reports is what the apply produces. A second walk mirroring the
// apply's decisions (reuse, ambiguity, namespace moves, unstorable methods) drifts from it. The cost:
// a dry run takes the import's locks (`lockToolNames` included) for its duration, and the sequences
// it consumes do not come back.
class DryRunRollback extends Error {
  constructor(readonly result: ImportAgentResult) {
    super("dry run");
  }
}

// How many unusable settings values an import names one by one before it just counts the rest.
const SETTINGS_DROPPED_NAMED = 20;

export async function importAgent(
  ctx: TenantContext,
  raw: unknown,
  base: PrismaClient = basePrisma,
  opts: { dryRun?: boolean } = {},
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

  const imported = await runScopedOn(base, ctx, async (db) => {
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
      // The name the vault would STORE (the write trims), so the lookup below and the insert
      // agree on which row a spelling like ` cred ` means.
      const storedName = storedVaultName(name);
      if (storedName === null) {
        warnings.push({
          code: "credentialNotFound",
          params: { name },
          target: credTarget(name),
        });
        refByName.set(name, null);
        continue;
      }
      // On `db`, inside the import's transaction: a separate connection cannot see what the
      // import already wrote, so a credential named twice under trim-equivalent spellings would read
      // as missing again and collide on insert.
      const resolution = await resolveVaultRefByNameOn(db, storedName, kind);
      if (resolution.status === "found") {
        refByName.set(name, resolution.ref);
      } else {
        // Not in the target tenant yet: create a reference-only PENDING vault entry (name + kind)
        // and KEEP the ref wired, so the operator only fills the secret. Some kinds cannot be pending
        // (managed OAuth, or ones needing a baseUrl/paramName the export lacks) and leave the field
        // unset. That is asked BEFORE the write, by the write's own guard, never by catching the write:
        // a failed statement aborts the import's transaction and every statement after it.
        let creatable = true;
        try {
          assertPendingVaultEntryCreatable({ name: storedName, kind });
        } catch {
          creatable = false;
        }
        if (!creatable) {
          warnings.push({
            code: "credentialNotFound",
            params: { name },
            target: credTarget(name),
          });
          refByName.set(name, null);
          continue;
        }
        // ON `db`, not on `base`: this write belongs to the import's own transaction. A call that
        // opened its own committed independently of it, so the dry run's rollback left the entry
        // and its audit row behind, and the preview then answered differently the second time.
        //
        // And it does not raise on a row that is already there: inside this transaction a failed
        // INSERT aborts everything, so a second import of the same bundle racing this one would take
        // the whole agent down instead of finding the credential. A row that was already there is
        // one to reuse, and reusing it silently is what `resolution.status === "found"` above does.
        const pending = await ensurePendingVaultEntryOn(db, ctx, {
          name: storedName,
          kind,
        });
        refByName.set(name, pending.ref);
        if (pending.created) {
          warnings.push({
            code: "credentialPending",
            params: { name },
            target: { kind: "vault" },
          });
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

    // Every credential the bags ended up wired to, judged against what the FIELD reads it as.
    // Only an import reaches this (the direct write refuses the pairing): a bundle can name a
    // `google_oauth` entry on the model and the (name, kind) lookup matches it. Warned, not refused
    // (one field would reject the whole bundle) and not unset (the entry exists, and the ref is the
    // only record of what the author meant); config-health keeps saying it until the operator acts.
    const wiredFacts = new Map<string, VaultEntryFacts | null>();
    for (const write of collectCredentialRefWrites(
      { modelConfig, settings },
      {},
    )) {
      let facts = wiredFacts.get(write.ref);
      if (facts === undefined) {
        facts = await readVaultRefFacts(db, write.ref);
        wiredFacts.set(write.ref, facts);
      }
      // The same two questions the write boundary and config-health ask, from the same helper, so an
      // import cannot admit a pairing a direct write refuses.
      if (facts !== null && !credentialServes(facts, write.use)) {
        warnings.push({
          code: "credentialKindUnusable",
          params: { field: write.path, kind: facts.kind },
          target: fieldTargetForPath(write.path),
        });
      }
    }

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

    // The protected-label list over its ceiling is clamped for the same reasons, and one more:
    // `readProtectedLabels` stops AT the ceiling, so a longer stored list would show the operator
    // guards that guard nothing. The imported agent lands disabled and in test mode for review.
    const dropped = clampProtectedLabelsInPlace(settings);
    if (dropped > 0) {
      warnings.push({
        code: "protectedLabelsClipped",
        params: { count: dropped, max: PROTECTED_LABELS_MAX },
      });
    }
    const droppedAllowed = clampAllowedLabelsInPlace(settings);
    if (droppedAllowed > 0) {
      warnings.push({
        code: "allowedLabelsClipped",
        params: { count: droppedAllowed, max: ALLOWED_LABELS_MAX },
      });
    }

    // The names this bundle grants as its OWN tools, HTTP or code. Read straight off the parsed
    // bundle (no database), because it decides what a settings key MEANS: a rule keyed
    // `assign_label` on an agent that grants a custom tool of that name is about that tool, not
    // about a native that held the name in an older release.
    const customToolNames = new Set(
      exp.tools.flatMap((g) =>
        g && (g.source === "HTTP" || g.source === "CODE") ? [g.tool] : [],
      ),
    );

    // Create any bundled components that don't already exist on the target tenant, BEFORE resolving
    // the grants (so buildGrantRows finds them by name). Components of the same name are reused, never
    // overwritten. Credentials are re-linked by name where resolved; otherwise left unset.
    //
    // ...AND BEFORE THE AGENT ROW. The settings bag carries the operator's rules keyed by tool NAME,
    // and a bundled tool that had to be stored under another name takes its rules with it, so the
    // rename map has to exist before the bag is written. The migration settles the same two moves in
    // the same order, for the same reason.
    let renamed: RenamedComponents = {
      httpTools: new Map(),
      codeTools: new Map(),
    };
    if (components) {
      const resolveCredName = (
        name: string | null | undefined,
      ): string | null =>
        name && !isVaultIdRef(name) ? (refByName.get(name) ?? null) : null;
      renamed = await createMissingComponents(
        db,
        tenantId,
        components,
        resolveCredName,
        warnings,
      );
    }

    // Import DISABLED and in TEST mode — the operator reviews, re-links any missing references +
    // credentials, validates with /teste, then enables for production. Both are set explicitly: the
    // Agent.mode column defaults to "production", so an imported clone must never land live by default.
    // The prompt's own mentions of a renamed native, moved before the row is written. See
    // `renameNativeToolsInProse`: the keys move next to it, and prose left behind names a tool the
    // catalog no longer has.
    const prompt = renameNativeToolsInProse(exp.systemPrompt, customToolNames);
    if (prompt.renamed > 0) {
      warnings.push({
        code: "promptToolRenamed",
        params: { count: prompt.renamed, name: "set_labels" },
      });
    }
    // Copied before the pass below edits it in place: the bag above is still read after the row is
    // written (`carriesRetiredTaxonomy`), and the blocks the passes above did not rebuild are shared.
    const storable = structuredClone(
      disarmFullDetail(
        stripRetiredLabelKeys(
          renameNativeToolKeys(
            normalizeSettingsForStorage(settings) ?? settings,
            renamed,
            customToolNames,
          ),
        ),
      ),
    );
    // What create would refuse (a closed value outside its domain, half a fallback, a tool guard
    // that cannot parse), asked of the bag AS IT WILL BE STORED, after the renames and strips above.
    // Named one by one up to a point and counted past it: a bundle can carry thousands of entries.
    const unusable = dropUnusableImportedSettingsInPlace(storable);
    let named = 0;
    for (const field of unusable.paths) {
      if (named >= SETTINGS_DROPPED_NAMED) break;
      warnings.push({ code: "settingsValueDropped", params: { field } });
      named += 1;
    }
    if (unusable.count > named) {
      warnings.push({
        code: "settingsValuesDroppedMore",
        params: { count: unusable.count - named },
      });
    }
    const created = await db.agent.create({
      data: {
        tenantId,
        name: exp.name,
        systemPrompt: prompt.text,
        modelConfig: modelConfig as Prisma.InputJsonValue,
        settings: storable as Prisma.InputJsonValue,
        transferWithSummary: exp.transferWithSummary,
        businessHoursId,
        followUpHoursId,
        enabled: false,
        mode: "test",
      },
      select: AGENT_SELECT,
    });

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
        // NOTE: `n` is the count's previous name, kept ONLY for the rolling-deploy overlap
        // (docs/deploy.md): an editor from the previous release still reads `{{n}}` and renders the
        // placeholder literally without it. The console reads `count` and falls back to `n`.
        // TODO: drop `n` once no container from the previous release can serve.
        params: { count: unknownGrants, n: unknownGrants },
      });
    }
    const grantRows = await buildGrantRows(
      db,
      tenantId,
      created.id,
      knownGrants,
      warnings,
      renamed,
      // Asked of the settings as the bundle carried them: `stripRetiredLabelKeys` above has already
      // deleted the key from what was stored.
      carriesRetiredTaxonomy(settings),
    );
    if (grantRows.length > 0) {
      await db.agentToolSelection.createMany({ data: grantRows });
    }

    const agent = toDto(created);
    await auditMutation(db, ctx, {
      action: "agent.import",
      target: `agent:${agent.id}`,
      after: auditSafe({
        id: agent.id,
        name: agent.name,
        enabled: agent.enabled,
        mode: agent.mode,
      }),
    });
    // De-dupe: the same credential/component referenced in several places should warn once, and the
    // toast count ("{{n}} warnings") must match the rendered list.
    const result = { agent, warnings: dedupeWarnings(warnings) };
    // The dry run leaves with the answer and without the rows: thrown from INSIDE, so the
    // transaction that produced it is the one that unwinds. Every write above — the components, the
    // grants, the agent, the audit row — goes with it.
    if (opts.dryRun) throw new DryRunRollback(result);
    return result;
  }).catch((e: unknown) => {
    if (e instanceof DryRunRollback) return e.result;
    throw e;
  });
  // NOTE: An import can be the moment a tenant first has an inbound surface (every imported
  // integration gets a route token), and the boot arm only reaches tenants that had one then. After
  // the commit and never on a dry run; best-effort, like the arm on `createIntegrationInstance`.
  if (!opts.dryRun && components?.integrations?.length) {
    await ensureInboundSweep(tenantId, base).catch((err) =>
      logger.warn(
        { tenantId: String(tenantId), err },
        "inbound sweep arm failed on agent import; next boot arms it",
      ),
    );
  }
  return imported;
}

// The schedule an integration config references (Google Calendar's `businessHoursId`), read the way
// the RUNTIME reads it: `resolveBusinessHoursId` trims, so `" 7 "` is a working pointer at schedule 7,
// and the export's bundling and id-to-name rewrite must agree with that. Bounded too, since digits
// past 2^63-1 convert under `BigInt` and would reach the `in` clause as a bind error.
export function configBusinessHoursId(
  config: Record<string, unknown> | null,
): bigint | null {
  const raw = config?.businessHoursId;
  return typeof raw === "string" ? parseDbId(raw.trim()) : null;
}

// On EXPORT the config's schedule id becomes the schedule's NAME, so it survives the tenant hop (the
// schedule is bundled too); on IMPORT the name resolves back to the local id. A config with no such
// ref, or an unresolved one, is left untouched.
export function remapConfigBusinessHoursIdToName(
  config: Record<string, unknown>,
  bhNameById: Map<string, string>,
): Record<string, unknown> {
  const id = configBusinessHoursId(config);
  if (id === null) return config;
  const name = bhNameById.get(id.toString());
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

type EntryFate = "dropped" | "altered" | "intact";

// How many bundled entries do not reach the column as written. The verdict per entry comes from the
// REAL parser run over that entry alone, and it counts an entry that survives but loses something (a
// backwards range pruned to `ranges: []` means CLOSED ALL DAY). The cap counts SURVIVORS, not
// positions: a malformed entry does not consume a slot, so the walk tracks how many were stored.
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

// The half of a bundled schedule this instance can actually read, with everything dropped named in a
// warning. The import writes the table directly, not through `createBusinessHours`, so nothing else
// asks whether an entry is readable. Entry by entry, because an empty grid is ALWAYS OPEN: rejecting
// the grid as a unit, or skipping the schedule, turns one typo into an agent that answers around the
// clock. Refusing the whole bundle over one field is the wrong trade for a bulk restore.
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

// Recreates the bundled business-hours schedules missing on the target tenant. A same-name schedule is
// reused (warned, never overwritten): its windows may differ from the source, so the operator should
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

// The provider's own ceiling on a tool name, and `normalizeToolName`'s: a name past it is refused
// with the WHOLE function list.
const TOOL_NAME_MAX = 64;
// The name a bundled tool carrying a native's name is stored under: the first `<base>_N` (N from 2)
// not in `taken`, which holds what the bundle carries and what the import already chose, so two
// entries never land on one row. Decided by the BUNDLE alone: a stored row under that name is reused,
// warned, so one bundle imported twice binds both agents to one row. The migration
// `rename_http_tools_named_after_natives` walks past stored rows instead, because both rows are real.
function renamedToolName(base: string, taken: ReadonlySet<string>): string {
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    // The suffix has to fit INSIDE the ceiling, not past it: a 64-character name already at the
    // limit would otherwise be renamed to 66 characters — refused by the provider for a code tool,
    // and normalized back to the original by the HTTP builder, which undoes the rename and leaves
    // the stored name disagreeing with the callable one.
    const stem =
      base.length + suffix.length > TOOL_NAME_MAX
        ? base.slice(0, TOOL_NAME_MAX - suffix.length)
        : base;
    const candidate = `${stem}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// The services bound what they store, and this path writes past them: a bundle carrying a longer
// label or description would create a row the console and the REST update can no longer save, and
// the operator would meet that only when they next edited the tool. Clipped rather than refused,
// the trade this file makes for prose everywhere else. `clipText` and never a bare slice, because
// these bound TEXT an operator wrote: a cut between the halves of an astral character leaves an
// orphan surrogate that Postgres refuses inside a jsonb write (src/lib/text.ts).
const TOOL_DESCRIPTION_MAX = 2000;
// A bundle can carry an EMPTY label or description — hand-edited, or written by a build whose rules
// differ — and `??` only answers for `null`/`undefined`. The services refuse a blank one in both
// fields (they are trimmed before the minimum), so a row created here with one could never be saved
// from the console again, and the label is what the whole console shows.
function blankFallback(
  value: string | null | undefined,
  fallback: string,
): string {
  return value?.trim() ? value.trim() : fallback;
}

function clipLabel(label: string): string {
  return clipText(label, TOOL_LABEL_MAX);
}
function clipDescription(text: string): string {
  return clipText(text, TOOL_DESCRIPTION_MAX);
}

// The label a renamed tool is stored with. It follows the name where the old label derived the old
// name, since the console submits `normalizeToolName(label)` as the name on every save; a label that
// never derived it is the operator's own. Same rule as the migration's. Shared by the HTTP and the
// code loop: both kinds are authored in the same console, under the same derivation.
function renamedLabel(
  bundledName: string,
  storedName: string,
  bundledLabel: string,
): string {
  if (storedName === bundledName) return bundledLabel;
  if (normalizeToolName(bundledLabel) !== bundledName) return bundledLabel;
  // The suffix comes off the STORED name, not from the bundled one's length: a name at the 64
  // ceiling has its stem trimmed before `_N` is appended (renamedToolName), so counting from the
  // bundled name starts past the end.
  const suffixed = `${bundledLabel} ${storedName.slice(storedName.lastIndexOf("_") + 1)}`;
  // Then the only question that matters is asked of the RESULT: a label at the 64 ceiling with
  // ` 2` appended normalizes back to 64 characters with the suffix CUT, deriving the name the row
  // could not take, and the tool could not be saved again. Clipped first, since TOOL_LABEL_MAX trims
  // on the way to the column and can break the derivation too. The stored name always derives
  // itself, so it is the fallback.
  const clipped = clipLabel(suffixed);
  return normalizeToolName(clipped) === storedName ? clipped : storedName;
}

// Whether this build can store the tool the bundle describes. An unreadable method or a url template
// this build cannot turn into a URL is warned and skipped, never canonicalized: falling back to GET
// changes what the tool does, and a stored invalid template throws on the model's first call. The
// url question is `urlTemplateProblem`, the one the write asks, since this path writes past the
// service.
export function importableHttpTool(
  tdef: ExportedHttpTool,
):
  | { ok: true; method: HttpToolMethod }
  | { ok: false; warning: ImportWarning } {
  const method = readHttpMethod(tdef.method);
  if (method === null) {
    return {
      ok: false,
      warning: {
        code: "httpToolMethodUnsupported",
        // The bundle's own name: no row is written, so there is no stored name to point at.
        params: { name: tdef.name, method: String(tdef.method) },
        target: { kind: "tool", name: tdef.name },
      },
    };
  }
  if (urlTemplateProblem(tdef.urlTemplate) !== null) {
    return {
      ok: false,
      warning: {
        code: "httpToolUrlTemplateUnusable",
        // The NAME alone: a URL an operator typed is redacted wherever it appears (the rule in
        // docs/api-and-fleet.md), and the tool it names is the only thing this warning acts on.
        params: { name: tdef.name },
        target: { kind: "tool", name: tdef.name },
      },
    };
  }
  return { ok: true, method };
}

// The name a bundled HTTP or code tool is stored under. A native's name moves first, decided by the
// bundle alone. Then ONE namespace reaches the model, and each service refuses a name the OTHER kind
// holds, so a row of the other kind under the name cannot be reused: the tool moves to the first
// `<name>_N` the other kind does not hold, and a same-kind row under THAT name is reused. The walk
// asks the table: the bundle says nothing about what the destination stored under the other kind.
async function storedToolName(
  bundled: string,
  taken: Set<string>,
  claimed: Set<string>,
  heldByOtherKind: (name: string) => Promise<boolean>,
): Promise<string> {
  // The bundle's own spelling is not necessarily a name the model can be offered. A provider
  // refuses the WHOLE function list over one that is empty, spaced or past 64 characters, so an
  // agent granted such a tool answers nothing at all — and the bundle is a file, hand-editable and
  // written by other versions, while this path writes past the service that would refuse it.
  // Normalized to the identifier the console derives from a label, which is also what makes it
  // reportable: a name that moves here moves through the same rename machinery as any other.
  const base = normalizeToolName(bundled);
  // ONE loop over every kind that owns a name, because they are the same question: a name the model
  // would answer with someone else's tool. Natives and RAG are built-ins (RAG's exist whenever a
  // knowledge base is granted, and both services refuse them where a name is typed);
  // `heldByOtherKind` is the caller's — the other tool table, plus the document templates, stored
  // and bundled.
  let name = base;
  while (
    isNativeToolName(name) ||
    isRagToolName(name) ||
    // NOTE: A name a component of THIS import already landed on. A same-kind row is normally REUSED
    // (decided below, outside this walk), but two DISTINCT entries whose names normalize alike ("a b"
    // and "a_b") are not one entry twice. `claimed` carries only names a row exists under, so an
    // entry the loop skipped frees the name again.
    claimed.has(name) ||
    (await heldByOtherKind(name))
  ) {
    taken.add(name);
    name = renamedToolName(base, taken);
  }
  return name;
}

// The part of a bundled template's validity that asks nothing of the database, shared by the name
// reservation (before the tool loops) and the insert loop (after them). Re-validated on the way IN:
// a newer build's block may not render here, and the SLUG becomes a tool name (`image` would produce
// `send_image`, a built-in's duplicate). This path writes the table directly, not through
// createDocumentTemplate, so every rule that write applies is applied here, the description's cap
// included (it is appended to the agent's tool description on every turn).
function readBundledTemplate(
  tpl: z.infer<typeof exportedDocumentTemplateSchema>,
):
  | {
      ok: true;
      name: string;
      content: Extract<
        ReturnType<typeof parseAuthoredTemplate>,
        { ok: true }
      >["content"];
    }
  | { ok: false; reason: string } {
  const metaFault =
    templateMetadataProblem({
      name: tpl.name,
      description: tpl.description ?? null,
      numberPrefix: tpl.numberPrefix ?? null,
    }) ?? (slugProblem(tpl.slug) ? `slug: ${slugProblem(tpl.slug)}.` : null);
  if (metaFault) return { ok: false, reason: metaFault };
  const content = parseAuthoredTemplate(tpl.blocks, tpl.fields, tpl.style);
  if (!content.ok) return { ok: false, reason: content.reason };
  // Safe only past `templateMetadataProblem`, which is the same schema: the value the gate
  // APPROVED, not the one it was handed — it trims before it measures, so a name padded with
  // whitespace passes a bound the raw string fails.
  // not-caller-input: a name read off the template being imported, not a value from this request
  const name = templateNameSchema.parse(tpl.name);
  return { ok: true, name, content: content.content };
}

// Bundle name → stored name, per kind, for the tools the import could not store under their own.
interface RenamedComponents {
  httpTools: Map<string, string>;
  codeTools: Map<string, string>;
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
): Promise<RenamedComponents> {
  // The import writes past both services, so it takes their lock itself, once and before either
  // tool loop: the pre-checks below ask the other table whether a name is free, and without this a
  // concurrent tool create could commit into that table between the question and the insert
  // (namespace.ts). One acquisition covers every name this import claims.
  await lockToolNames(db);
  // The `send_<slug>` tools the bundle's own templates will publish, carried by the tool loops
  // because the templates are inserted after them. Only templates that will actually CLAIM one: a
  // template the loop below skips publishes nothing, and a tool renamed off its name would be renamed
  // for nothing. The questions are that loop's own, asked here BEFORE the tool loops write, the only
  // order that terminates: reserving the name is what keeps a bundled tool off it.
  const bundledDocumentNames = new Set<string>();
  const bundledTemplateTitles = new Set<string>();
  for (const tpl of components.documentTemplates ?? []) {
    const toolName = documentToolName(tpl.slug);
    // A slug the destination already has is REUSED, not inserted — and the template that is
    // already there publishes the name, so it stays reserved.
    if (
      await db.documentTemplate.findFirst({
        where: { slug: tpl.slug },
        select: { id: true },
      })
    ) {
      bundledDocumentNames.add(toolName);
      continue;
    }
    const read = readBundledTemplate(tpl);
    if (!read.ok) continue;
    // A tool STORED on the destination under `send_<slug>` blocks the template instead of moving,
    // which is the one direction this reservation does not decide: it was there first.
    if (await toolHoldingName(db, tpl.slug)) continue;
    if (
      bundledTemplateTitles.has(read.name) ||
      (await db.documentTemplate.findFirst({
        where: { name: read.name },
        select: { slug: true },
      }))
    ) {
      continue;
    }
    bundledTemplateTitles.add(read.name);
    bundledDocumentNames.add(toolName);
  }
  // Bundle name → stored name, for the HTTP tools this loop could not store under their own.
  const renamedHttpTools = new Map<string, string>();
  // Both kinds share the model's namespace, so a name either loop chooses is taken from the
  // other: without the code names here, an HTTP tool renamed off a native could land on the
  // name a code tool of the SAME bundle carries, and the pair would then be one tool to the model.
  const taken = new Set([
    // Normalized, because that is what the loops will actually store (storedToolName): a bundle
    // carrying "a b" and "a_b" claims one name twice, and the raw spellings would hide it.
    ...components.httpTools.map((t) => normalizeToolName(t.name)),
    ...(components.codeTools ?? []).map((t) => normalizeToolName(t.name)),
    // ...and the templates THIS bundle carries: their `send_<slug>` tools are assembled before
    // either tool table, so a tool landing on one of those names is the one that disappears. The
    // STORED templates are asked per name below; these do not exist yet to be asked about.
    ...bundledDocumentNames,
  ]);
  // The names a component of THIS import has actually landed on, shared by both tool loops because
  // the model reads one namespace. Added by `landed` below rather than at the moment a name is
  // chosen: a component the loop then skips (an unsupported method) writes no row, and holding its
  // name would push the next one off it for nothing.
  const claimed = new Set<string>();
  // One stored name per bundle name: the second occurrence of a native-named component (a
  // hand-edited file) finds the first one's row and reuses it, instead of choosing another suffix.
  const chosen = new Map<string, string>();
  const conversationRefWiring: { tool: string; integration: string }[] = [];
  for (const tdef of components.httpTools) {
    // A bundle authored before a native took the name. The assembly reserves every native name,
    // so a tool stored under one would never reach the model, and this path writes past the service
    // that refuses it. Stored under `<name>_N`, warned, so the operator learns the name a prompt may
    // still use. A name a stored CODE tool holds moves the same way (`storedToolName`): the two kinds
    // share the namespace.
    const name =
      chosen.get(tdef.name) ??
      (await storedToolName(
        tdef.name,
        taken,
        claimed,
        async (n) =>
          // By the MODEL-FACING name (namespace.ts): a row stored `Foo` before names were
          // canonicalized answers to `foo`, which is the name being claimed here.
          (await toolsUnderModelName(db, n)).codeIds.length > 0 ||
          // A document template publishes `send_<slug>` and is assembled BEFORE either tool table,
          // so a tool landing on that name is the one the assembly drops (namespace.ts). The
          // bundle's own templates count too: they are inserted after this loop, so the database
          // cannot be asked about them yet.
          bundledDocumentNames.has(n) ||
          (await documentHoldingToolName(db, n)) !== null,
      ));
    chosen.set(tdef.name, name);
    taken.add(name);
    const label = clipLabel(
      renamedLabel(tdef.name, name, blankFallback(tdef.label, name)),
    );
    // Recorded once a row under the new name EXISTS (written below, or found by the pre-check or
    // the race) and not before: a component the checks skip must not be announced as imported.
    const landed = (): void => {
      // Before the early return: a component stored under its OWN name occupies it just as much as
      // a renamed one, and the next component whose name normalizes to it must not read that row
      // as a reuse of itself.
      claimed.add(name);
      if (name === tdef.name) return;
      renamedHttpTools.set(tdef.name, name);
      warnings.push({
        code: "httpToolRenamed",
        params: { name: tdef.name, renamed: name },
        target: { kind: "tool", name },
      });
    };
    // Reuse is decided by the MODEL-FACING name, not the stored spelling: a row written as `Foo`
    // answers to `foo`, and an exact lookup would insert a SECOND row under the name the model sees
    // (namespace.ts). Same resolution the grant uses, so "reuse" names ONE row.
    const reuse = await toolUnderModelName(db, name, "http");
    // Ambiguous is TAKEN, not free. Two rows already answer to this name here; writing a third
    // would deepen the collision, and reusing one would pick an endpoint on the destination's row
    // order. The component is skipped and said out loud, and the grant below reports it too, which
    // is the honest pair: neither the tool nor its grant landed.
    if (reuse.kind === "ambiguous") {
      warnings.push({
        code: "httpToolAmbiguous",
        params: { name, n: reuse.ids.length },
        target: { kind: "tool", name },
      });
      continue;
    }
    const existing = reuse.kind === "one" ? reuse.id : null;
    if (existing) {
      landed();
      warnings.push({
        code: "httpToolReused",
        params: { name },
        target: { kind: "tool", name },
      });
      continue;
    }
    // The import writes straight to the DB, so it canonicalizes authoring shapes too (a bundle
    // from an older instance may carry JSON-Schema inputSchema or single-brace placeholders). An
    // unsupported body shape is CANONICALIZED, not refused: `canonicalBodyShape` returns what
    // `parseBody` already executed, so the request is byte-identical. Blanking it to `{}` would switch
    // a `{mode:"raw", ..., extra}` tool to the fields assembly. The method and url, by contrast, are
    // warn-and-skip (`importableHttpTool`): there is no equivalent request to fall back to.
    const usable = importableHttpTool(tdef);
    if (!usable.ok) {
      warnings.push(usable.warning);
      continue;
    }
    const { method } = usable;
    const badBody = unsupportedBodyShape(tdef.body);

    const { shapes, warnings: shapeWarnings } = normalizeToolShapes({
      urlTemplate: tdef.urlTemplate,
      query: tdef.query ?? {},
      headers: tdef.headers,
      body: badBody ? canonicalBodyShape(tdef.body) : tdef.body,
      inputSchema: tdef.inputSchema,
    });
    // Same rule as the code loop below: what the normalization had to change is the operator's to
    // review, not something to discard on the way in.
    // The template as it will be STORED (the shapes pass canonicalizes single-brace placeholders),
    // because that is the string the runtime reads back.
    const storedUrlTemplate = (shapes.urlTemplate ??
      tdef.urlTemplate) as string;
    for (const reason of shapeWarnings) {
      warnings.push({
        code: "toolSchemaAdjusted",
        params: { name, reason },
        target: { kind: "tool", name },
      });
    }
    // And the pairing the write asks, on the row about to be stored. A relative template (`/...`)
    // with no credential base URL makes `buildHttpTool` THROW out of `buildHttpTools`, a bare `.map`
    // in the toolset literal, so the agent would lose every tool, not just this one. So it is
    // skipped, not left to be completed later like a pending credential.
    const credentialRef = resolveCredName(tdef.credentialRef);
    if (
      !(await relativeTemplateHasBase(db, storedUrlTemplate, credentialRef))
    ) {
      warnings.push({
        code: "httpToolUrlTemplateUnusable",
        params: { name: tdef.name },
        target: { kind: "tool", name: tdef.name },
      });
      continue;
    }
    // `createMany({ skipDuplicates })` rather than `create`: a concurrent writer can commit
    // between the pre-check and this insert, and a P2002 would abort the import's single
    // `runScopedOn` transaction and every statement after it.
    const { count } = await db.toolDefinition.createMany({
      data: [
        {
          tenantId,
          name,
          // label is required now; legacy exports without one fall back to the identifier.
          label,
          description: tdef.description
            ? clipDescription(tdef.description)
            : null,
          method,
          urlTemplate: storedUrlTemplate,
          allowedHosts: tdef.allowedHosts,
          headers: shapes.headers as Prisma.InputJsonValue,
          inputSchema: shapes.inputSchema as Prisma.InputJsonValue,
          // Through the runtime's own reader, like `appointment` below and for the same reason —
          // the import writes straight to the DB, so a hand-edited bundle would otherwise store a
          // template the runtime silently ignores and the editor reads back as a legacy schema.
          // `dropUnusable` because this path cannot refuse the way the service does.
          outputSchema: storableResponseTemplate(tdef.outputSchema, {
            dropUnusable: true,
          }) as Prisma.InputJsonValue,
          query: shapes.query as Prisma.InputJsonValue,
          body: shapes.body as Prisma.InputJsonValue,
          // Normalized like the shapes above, and for the same reason: the import writes straight to
          // the DB, so a hand-edited bundle would otherwise store a list the service would refuse.
          expectedStatuses: normalizeExpectedStatuses(tdef.expectedStatuses),
          // Read through the runtime's own reader, like the shapes above: a hand-edited bundle
          // otherwise stores a declaration the runtime would silently ignore.
          appointment: (readAppointmentDeclaration(tdef.appointment) ??
            Prisma.DbNull) as unknown as Prisma.InputJsonValue,
          ackEnabled: tdef.ackEnabled,
          ackMessage: tdef.ackMessage ?? null,
          // NOTE: clamped into the band rather than refused: the service refuses, but a bundle cannot
          // be refused over one number, and the clamped value is what the runtime would read anyway.
          maxResponseChars:
            tdef.maxResponseChars == null
              ? null
              : effectiveMaxResponseChars(tdef.maxResponseChars),
          credentialRef,
          enabled: true,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 0) {
      // Lost the race. The name is taken now, which is exactly the reuse the pre-check reports.
      landed();
      warnings.push({
        code: "httpToolReused",
        params: { name },
        target: { kind: "tool", name },
      });
      continue;
    }
    landed();
    // NOTE: Resolved after the integrations below exist, since the bundle's GENERIC instance may be
    // one this import is about to create. Only a tool this import CREATED is wired; a reused one keeps
    // whatever its operator gave it.
    if (tdef.conversationRefIntegration) {
      conversationRefWiring.push({
        tool: name,
        integration: tdef.conversationRefIntegration,
      });
    }
    // Both warnings below describe the row that was just written, so they wait for the insert to
    // report one: the reuse path above says nothing about a body or a credential it did not store.
    if (badBody) {
      warnings.push({
        code: "httpToolBodyIgnored",
        params: { name },
        target: { kind: "tool", name },
      });
    }
    if (tdef.credentialRef && !resolveCredName(tdef.credentialRef)) {
      warnings.push({
        code: "httpToolCredNotFound",
        params: { tool: tdef.name, credential: tdef.credentialRef },
        target: { kind: "tool", name },
      });
    }
  }

  // Bundle name → stored name, for the code tools this loop could not store under their own.
  const renamedCodeTools = new Map<string, string>();
  // One stored name per bundle name, for the reason the HTTP loop keeps one.
  const chosenCode = new Map<string, string>();
  for (const tdef of components.codeTools ?? []) {
    const name =
      chosenCode.get(tdef.name) ??
      (await storedToolName(
        tdef.name,
        taken,
        claimed,
        async (n) =>
          (await toolsUnderModelName(db, n)).httpIds.length > 0 ||
          bundledDocumentNames.has(n) ||
          (await documentHoldingToolName(db, n)) !== null,
      ));
    chosenCode.set(tdef.name, name);
    taken.add(name);
    const label = clipLabel(
      renamedLabel(tdef.name, name, blankFallback(tdef.label, name)),
    );
    // Recorded once a row under the new name EXISTS, and not before, for the reason the HTTP
    // loop's `landed` gives.
    const landed = (): void => {
      // Before the early return, for the reason the HTTP loop's `landed` gives.
      claimed.add(name);
      if (name === tdef.name) return;
      renamedCodeTools.set(tdef.name, name);
      warnings.push({
        code: "codeToolRenamed",
        params: { name: tdef.name, renamed: name },
        target: { kind: "codeTool", name },
      });
    };
    // By the model-facing name, for the reason the HTTP loop gives.
    // Same resolution the HTTP loop uses, for the reason it gives.
    const reuseCode = await toolUnderModelName(db, name, "code");
    // Taken, not free, for the reason the HTTP loop gives.
    if (reuseCode.kind === "ambiguous") {
      warnings.push({
        code: "codeToolAmbiguous",
        params: { name, n: reuseCode.ids.length },
        target: { kind: "codeTool", name },
      });
      continue;
    }
    const existing = reuseCode.kind === "one" ? reuseCode.id : null;
    if (existing) {
      landed();
      warnings.push({
        code: "codeToolReused",
        params: { name },
        target: { kind: "codeTool", name },
      });
      continue;
    }
    // The import writes straight to the DB (not via the service), so the schema is
    // canonicalized here the way the service canonicalizes it: a hand-edited bundle may carry a
    // JSON-Schema-shaped one, and the runtime reads the compact field map.
    const { shapes, warnings: schemaWarnings } = normalizeToolShapes({
      inputSchema: tdef.inputSchema,
    });
    // A schema that had to LOSE something to become the compact map (a nested shape, a union, an
    // enum of non-strings) changes what the model may send, and the operator reviewing an import is
    // exactly who has to hear it — the console shows these warnings next to the imported agent.
    for (const reason of schemaWarnings) {
      warnings.push({
        code: "toolSchemaAdjusted",
        params: { name, reason },
        target: { kind: "codeTool", name },
      });
    }
    // The same advisory check the console and the service run on a save. A body that does not parse
    // is stored on purpose — it is the operator's to fix, and refusing a whole bundle over it would
    // be worse — but the recipient has to LEARN of it here, not from a failed call in production.
    for (const w of await checkCodeToolSyntax(tdef.code)) {
      warnings.push({
        code: "codeToolBodyWarning",
        params: {
          name,
          reason:
            w.kind === "syntax"
              ? `line ${w.line}, column ${w.column}: ${w.message}`
              : "the code never returns a value",
        },
        target: { kind: "codeTool", name },
      });
    }
    // `createMany({ skipDuplicates })` for the reason the HTTP loop gives: a lost race on
    // `@@unique([tenantId, name])` would abort the import's transaction.
    const { count } = await db.codeToolDefinition.createMany({
      data: [
        {
          tenantId,
          name,
          label,
          // The column is required and the model reads it to decide when to call; a bundle that
          // carries none gets the label, which is the next best statement of what the tool is.
          description: clipDescription(blankFallback(tdef.description, label)),
          inputSchema: (shapes.inputSchema ?? {}) as Prisma.InputJsonValue,
          code: tdef.code,
          enabled: tdef.enabled ?? true,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 0) {
      // NOTE: lost the race. The name is taken now, which is exactly the reuse the pre-check
      // reports.
      landed();
      warnings.push({
        code: "codeToolReused",
        params: { name },
        target: { kind: "codeTool", name },
      });
      continue;
    }
    landed();
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
    // Same reason as the stdio check: this write bypasses createMcpConnection, which is where the
    // headers are judged.
    const credentialRef = resolveCredName(m.credentialRef);
    const headers = m.headers ?? {};
    const credEntry = credentialRef
      ? await readVaultRefFacts(db, credentialRef)
      : null;
    if (
      mcpHeadersProblem(
        headers,
        m.transport,
        credentialHeaderName(
          credentialRef !== null,
          credEntry?.kind,
          credEntry?.paramName,
        ),
      )
    ) {
      warnings.push({ code: "mcpInvalidHeaders", params: { name: m.name } });
      continue;
    }
    // `createMany({ skipDuplicates })` for the same reason as the loop above: a lost race on
    // `@@unique([tenantId, name])` would abort the import's transaction.
    const { count } = await db.mcpServerConnection.createMany({
      data: [
        {
          tenantId,
          name: m.name,
          transport: m.transport,
          url: m.url ?? null,
          command: m.command ?? null,
          credentialRef,
          headers: headers as Prisma.InputJsonValue,
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
    // `createMany({ skipDuplicates })` for the same reason as the loops above, on
    // `@@unique([tenantId, catalogType, name])`. `routeTokenHash` is unique too and covered by the
    // ON CONFLICT, but it is 32 fresh random bytes hashed, so a skip here is the name, in practice.
    const { count } = await db.integrationInstance.createMany({
      data: [
        {
          tenantId,
          catalogType: i.catalogType,
          name: i.name,
          config: config as Prisma.InputJsonValue,
          credentialRef: resolveCredName(i.credentialRef),
          // NOTE: A GENERIC route cannot be open: it is created with its catalog default and no
          // secret, which answers 401 until the operator picks one, rather than NONE, which would let
          // anyone holding a ref make the agent write to that customer.
          inboundAuthStrategy: getCatalogEntry(i.catalogType)
            ?.requiresInboundAuth
            ? (getCatalogEntry(i.catalogType)?.defaultInboundAuth ?? "NONE")
            : "NONE",
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

  // NOTE: `{{conversation_ref}}`: each tool this import created is wired to the GENERIC instance of
  // that name (created above, or reused). A missing one leaves the tool refusing every call, which is
  // said now rather than at the first conversation.
  for (const w of conversationRefWiring) {
    const inst = await db.integrationInstance.findFirst({
      where: { catalogType: "GENERIC", name: w.integration },
      select: { id: true },
    });
    if (!inst) {
      warnings.push({
        code: "httpToolConversationRefNotFound",
        params: { tool: w.tool, integration: w.integration },
        target: { kind: "tool", name: w.tool },
      });
      continue;
    }
    await db.toolDefinition.updateMany({
      where: { name: w.tool },
      data: { conversationRefIntegrationId: inst.id },
    });
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
    // Through the same reader the name reservation above used, so the two passes agree on
    // which templates are importable; disagreeing would move a tool off `send_<slug>` for a template
    // this loop then skips.
    const read = readBundledTemplate(tpl);
    if (!read.ok) {
      warnings.push({
        code: "documentTemplateInvalid",
        params: { name: tpl.name, reason: read.reason },
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
    const approvedName = read.name;
    // The destination may already have a TOOL under the name this template would publish. The
    // template is assembled first, so importing it would silently take that tool off the agents
    // that hold it — and the tool could no longer be saved under its own name either. Skipped with
    // a warning, the way a name another template holds is: a slug moved instead would change the
    // name prompts use to ask for this document (namespace.ts).
    const toolHolder = await toolHoldingName(db, tpl.slug);
    if (toolHolder) {
      warnings.push({
        code: "documentToolNameTaken",
        params: {
          name: tpl.name,
          tool: documentToolName(tpl.slug),
          holder: toolHolder.name,
        },
        target: { kind: "document", name: tpl.slug },
      });
      continue;
    }
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
    // `createMany({ skipDuplicates })` rather than `create`: both pre-checks can answer "free"
    // and a writer (a second import, a console save) commit before this insert, and a P2002 aborts
    // the ONE `runScopedOn` transaction the entire import runs in, losing the agent, tools and bases.
    // A `catch` around the insert cannot help, since the transaction is already dead; `ON CONFLICT
    // DO NOTHING` covers BOTH unique indexes on this table.
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
          blocks: read.content.blocks as unknown as Prisma.InputJsonValue,
          fields: read.content.fields as unknown as Prisma.InputJsonValue,
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
              // NOTE: `n` kept for the rolling-deploy overlap; see `unknownGrantSourceSkipped` above.
              params: { name: kb.name, count: docCount, n: docCount },
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
    // NOTE: The name the bundle carries, held to the rule the write holds it to: a blank one is a
    // base the agent cannot scope a search to, and a huge one eats the tool description's budget and
    // pushes the other bases out of what the model reads. The import writes through Prisma, past the
    // service's check, so it warns and skips here (the grants then report `kbGrantNotFound`). AFTER
    // the reuse branch above: a row already stored under the name is reused whatever the bundle says.
    if (!knowledgeBaseNameUsable(kb.name)) {
      warnings.push({
        code: "knowledgeBaseNameUnusable",
        // Clipped, and through the safe cutter: this warning fires precisely because the name may be
        // enormous, so echoing it whole is the same payload problem read back to the operator.
        params: { name: clipText(kb.name, 60) },
        target: { kind: "knowledge", name: kb.name },
      });
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
        ...(kb.stripContactFooters != null
          ? { stripContactFooters: kb.stripContactFooters }
          : {}),
      },
      select: { id: true },
    });
    if (kb.documents && kb.documents.length > 0) {
      // Recreate the source documents as UNINDEXED — NOT via createDocument (which would enqueue a RAG
      // ingest job). They stay unindexed until the operator triggers re-indexing (manual re-ingest).
      // An external id is unique per base, and a hand-edited bundle can repeat one: the first keeps
      // it and the rest arrive as ordinary documents, rather than the whole import failing.
      const seenExternal = new Set<string>();
      await db.knowledgeDocument.createMany({
        data: kb.documents.map((d) => {
          const externalId =
            d.externalId != null && !seenExternal.has(d.externalId)
              ? d.externalId
              : null;
          if (externalId !== null) seenExternal.add(externalId);
          return {
            tenantId,
            knowledgeBaseId: createdKb.id,
            title: d.title,
            sourceType: d.sourceType,
            fileName: d.fileName ?? null,
            mimeType: d.mimeType ?? null,
            content: d.content,
            externalId,
            sourceUrl: externalId !== null ? (d.sourceUrl ?? null) : null,
            status: "UNINDEXED",
          };
        }),
      });
    }
    if (kb.source) {
      // The source the base had, held to the write's rules (credentials, slug, locale, interval).
      // The address is not resolved here: every run asks the SSRF check before every page, and an
      // import is not where a resolver's answer at this minute should decide what gets stored.
      try {
        const parsed = await parseSourceInput(kb.source, async () => undefined);
        await db.knowledgeSource.create({
          data: {
            tenantId,
            knowledgeBaseId: createdKb.id,
            kind: parsed.kind,
            config: parsed.config as unknown as Prisma.InputJsonValue,
            intervalMinutes: parsed.intervalMinutes,
          },
        });
        await armSourceSync(db, tenantId, createdKb.id);
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        warnings.push({
          code: "knowledgeSourceUnusable",
          params: { name: clipText(kb.name, 60) },
          target: { kind: "knowledge", name: kb.name },
        });
      }
    }
    // A freshly created KB is silent (only reused ones warn). Imported-but-unindexed documents surface
    // through the editor's live "needs indexing" alert (config-health), not a one-shot import warning.
  }
  return { httpTools: renamedHttpTools, codeTools: renamedCodeTools };
}

// Cuts `settings.setLabels.protected` down to the ceiling, IN PLACE, and answers how many entries
// it dropped. Counted the way the reader counts (blanks, non-strings and duplicates never became
// guards), so the number in the warning is the number of guards the operator loses.
function clampProtectedLabelsInPlace(settings: unknown): number {
  return clampLabelListInPlace(settings, "protected", PROTECTED_LABELS_MAX);
}

// The allowed list, clamped for the same reasons: the console reloads it, and the reader honours
// only the first ones.
function clampAllowedLabelsInPlace(settings: unknown): number {
  return clampLabelListInPlace(settings, "allowed", ALLOWED_LABELS_MAX);
}

function clampLabelListInPlace(
  settings: unknown,
  key: "protected" | "allowed",
  max: number,
): number {
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    return 0;
  const block = (settings as Record<string, unknown>).setLabels;
  if (!block || typeof block !== "object" || Array.isArray(block)) return 0;
  const raw = (block as Record<string, unknown>)[key];
  if (!Array.isArray(raw)) return 0;
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const label = entry.trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    kept.push(label);
  }
  if (kept.length <= max) return 0;
  (block as Record<string, unknown>)[key] = kept.slice(0, max);
  return kept.length - max;
}

// The configured taxonomy, rendered as the sentence it became. A bundle exported before the label
// redesign carries `monitoring.labelGroups`, which the upgrade migration carries into
// `toolGuidance.set_labels`, so a restore keeps what an upgrade keeps. The text mirrors the
// migration's statement for statement (the two tests assert the same sentence for the same input).
// Exclusivity follows the reader's default, `bag.exclusive !== false`, so a loose value reads as
// exclusive rather than being coerced.
function taxonomySentence(groups: unknown): string | null {
  if (!Array.isArray(groups) || groups.length === 0) return null;
  const parts: string[] = [];
  for (const raw of groups) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const grp = raw as Record<string, unknown>;
    const name =
      typeof grp.name === "string" && grp.name.trim()
        ? grp.name.trim()
        : "sem nome";
    const rule =
      grp.exclusive === false
        ? " (pode usar mais de uma)"
        : " (escolha no máximo uma)";
    const values = Array.isArray(grp.values)
      ? grp.values.filter((v): v is string => typeof v === "string")
      : [];
    parts.push(
      `${name}${rule}: ${values.length ? values.join(", ") : "(sem valores)"}`,
    );
  }
  if (parts.length === 0) return null;
  return clipText(
    `Migrado da taxonomia anterior. Grupos de etiquetas desta conta: ${parts.join(". ")}.`,
    TOOL_INSTRUCTIONS_MAX,
  );
}

// Whether this bundle came from the classifier, asked of the settings BEFORE they are stripped. The
// old classifier applied labels without any label tool, so a watcher could carry a NATIVE grant
// without one; under the new design the migrated sentence does nothing without the tool. Step 1c of
// `20260910140000_drop_retired_label_settings` repairs stored rows; a bundle can be restored long
// after, so the same repair happens here.
function carriesRetiredTaxonomy(settings: unknown): boolean {
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    return false;
  const mon = (settings as Record<string, unknown>).monitoring;
  if (!mon || typeof mon !== "object" || Array.isArray(mon)) return false;
  const groups = (mon as Record<string, unknown>).labelGroups;
  return Array.isArray(groups) && groups.length > 0;
}

// Drops the retired `settings.labels` and `settings.monitoring.labelGroups` on the way in. The write
// boundary refuses them to tell an editing operator where the taxonomy went, but a bundle is a file
// exported under an older release, and failing a restore over a key that governs nothing gives the
// operator nothing to act on. (A RENAMED_NATIVE_TOOLS key is MOVED instead: it still governs.)
function stripRetiredLabelKeys(settings: unknown): unknown {
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    return settings;
  const bag = { ...(settings as Record<string, unknown>) };
  delete bag.labels;
  // CARRIED OVER BEFORE THE KEY GOES, and only where the operator has not written their own note:
  // their words win over ours, the same rule the migration follows.
  const monBag = bag.monitoring as Record<string, unknown> | undefined;
  const sentence =
    monBag && typeof monBag === "object" && !Array.isArray(monBag)
      ? taxonomySentence(monBag.labelGroups)
      : null;
  const guidance = bag.toolGuidance;
  const hasOwnNote =
    !!guidance &&
    typeof guidance === "object" &&
    !Array.isArray(guidance) &&
    (guidance as Record<string, unknown>).set_labels !== undefined;
  if (sentence && !hasOwnNote) {
    bag.toolGuidance = {
      ...(guidance && typeof guidance === "object" && !Array.isArray(guidance)
        ? (guidance as Record<string, unknown>)
        : {}),
      set_labels: sentence,
    };
  }
  const monitoring = bag.monitoring;
  const mon = monitoring as Record<string, unknown> | undefined;
  if (
    monitoring &&
    typeof monitoring === "object" &&
    !Array.isArray(monitoring) &&
    (mon?.labelGroups !== undefined || mon?.noteOnChange !== undefined)
  ) {
    const next = { ...(monitoring as Record<string, unknown>) };
    delete next.labelGroups;
    delete next.noteOnChange;
    bag.monitoring = next;
  }
  return bag;
}

// The prompt names tools too: a bundle exported before a rename tells the model to call a tool the
// catalog no longer has (`assign_label`). A WORD BOUNDARY, so only the identifier moves
// (`assign_labels` is somebody's own vocabulary), and skipped when the bundle grants a CUSTOM tool
// under the old name, since the prompt then means that tool. Returns how many mentions moved,
// because an upgrade that edited an operator's prose has to say so.
function renameNativeToolsInProse(
  text: string,
  customToolNames: ReadonlySet<string>,
): { text: string; renamed: number } {
  let out = text;
  let renamed = 0;
  for (const [from, to] of Object.entries(RENAMED_NATIVE_TOOLS)) {
    if (customToolNames.has(from)) continue;
    const re = new RegExp(`\\b${from}\\b`, "g");
    const hits = out.match(re);
    if (!hits) continue;
    renamed += hits.length;
    out = out.replace(re, to);
  }
  return { text: out, renamed };
}

// The two settings maps keyed by native tool NAME (`toolGuidance`, `toolPreconditions`), carried
// across a rename like the grant is. Left alone, a note vanishes, a guard goes inert while the editor
// still shows it, and the write boundary refuses the next settings save (it checks the KEY against
// the native catalog). The migration does this for stored rows; a bundle can arrive any time. The
// new key WINS when both are present: it is the operator's most recent word.
function renameNativeToolKeys(
  settings: unknown,
  renamed: RenamedComponents,
  // The names the bundle grants as HTTP or CODE tools. A legacy native name is only legacy while
  // nothing else answers to it: a bundle from an agent with its own tool under that name means that
  // tool by the key, and moving the guard to the native would leave the custom tool unguarded.
  customToolNames: ReadonlySet<string>,
): unknown {
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    return settings;
  const bag = settings as Record<string, unknown>;
  // Two moves, and the order matters. A bundle can carry BOTH a custom tool named `set_labels`
  // and the native under its old name; in one pass the native's rule finds `set_labels` taken and is
  // discarded, and the custom tool's rule stays on a key that now names the native. Settling the
  // custom rename first empties the key. The bundle's own name is the key (what `RenamedComponents`
  // maps), since the tool is renamed only because this import could not store it under that name.
  const stored = new Map<string, string>();
  for (const m of [renamed.httpTools, renamed.codeTools])
    for (const [from, to] of m) if (from !== to) stored.set(from, to);
  const moves: ((name: string) => string)[] = [
    (name) => stored.get(name) ?? name,
    (name) => (customToolNames.has(name) ? name : currentNativeToolName(name)),
  ];
  let out = bag;
  for (const key of ["toolGuidance", "toolPreconditions"] as const) {
    const map = bag[key];
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    let entries = map as Record<string, unknown>;
    let touched = false;
    for (const move of moves) {
      // Null-prototype, like every other reader of these bags: `__proto__` as a key on a plain
      // object mutates the prototype instead of storing a rule.
      const next = Object.create(null) as Record<string, unknown>;
      let movedHere = false;
      for (const [name, value] of Object.entries(entries)) {
        const to = move(name);
        if (to !== name) movedHere = true;
        // A key already carrying the destination name is not overwritten by the source's value:
        // it is the operator's most recent word, the same rule the migration applies.
        if (to !== name && Object.hasOwn(entries, to)) continue;
        next[to] = value;
      }
      if (movedHere) {
        entries = next;
        touched = true;
      }
    }
    if (touched) out = { ...out, [key]: entries };
  }
  return out;
}

async function buildGrantRows(
  db: ScopedDb,
  tenantId: bigint,
  agentId: bigint,
  tools: ExportedGrant[],
  warnings: ImportWarning[],
  // Bundle name → stored name, for a tool the import could not store under its own name.
  renamed: RenamedComponents,
  // The bundle carried a taxonomy: an explicit NATIVE allowlist then has to gain `set_labels`, or
  // the migrated guidance names a tool the restored agent does not have (`carriesRetiredTaxonomy`).
  carriedTaxonomy = false,
): Promise<Prisma.AgentToolSelectionCreateManyInput[]> {
  const rows: Prisma.AgentToolSelectionCreateManyInput[] = [];
  for (const g of tools) {
    switch (g.source) {
      case "NATIVE": {
        // A name this build's catalog does not carry is dropped, and said (a bundle from an
        // older release may name a retired native like `run_code`); failing the whole bundle would be
        // the trade this file rejects. The row lands even when nothing survives the filter: an
        // explicit empty allowlist means NO natives, and no row at all would mean ALL of them.
        const known = new Set<string>(NATIVE_TOOL_NAMES);
        // A RENAMED native is carried across rather than dropped (`currentNativeToolName`). The
        // migration repairs the rows that exist when it runs; a bundle is a file, and one exported
        // before the rename can be imported long after — restoring a backup would otherwise come
        // back missing the capability, which is the one thing a backup is for.
        const mapped = g.enabledTools.map(currentNativeToolName);
        for (const n of mapped) {
          if (!known.has(n)) {
            warnings.push({ code: "nativeToolUnknown", params: { name: n } });
          }
        }
        const enabled = new Set(mapped.filter((n) => known.has(n)));
        // ...plus the label tool when the taxonomy came with the bundle, which is the migration's
        // step 1c applied to a file. Only onto an EXPLICIT row: an agent with no native selection
        // is already allowed every native, and adding a row would NARROW what it can do.
        if (carriedTaxonomy) enabled.add("set_labels");
        rows.push({
          tenantId,
          agentId,
          source: "NATIVE",
          // ...and de-duplicated, because a bundle can name BOTH (exported from an agent that
          // carried the old grant beside a new one), and the allowlist must not list one twice.
          enabledTools: [...enabled],
          knowledgeBaseIds: [],
        });
        break;
      }
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
        // MERGED, NEVER APPENDED, because appending cannot work: the table carries
        // `CREATE UNIQUE INDEX ats_rag_uq ON agent_tool_selections (agent_id) WHERE source = 'RAG'`,
        // so a second row is refused by Postgres and the whole import dies on a constraint the
        // caller never named. `agentExportSchema` does not stop a payload from carrying two RAG
        // grants (nothing in the export vocabulary says "at most one"), and an export written by
        // hand or by an older build can. Merging is what makes such a payload importable at all,
        // and it loses nothing: one row holding both sets of bases is exactly what the console
        // would have produced from the same intent.
        const kbIds = kbs.map((k) => k.id);
        const existing = rows.find((r) => r.source === "RAG");
        if (existing) {
          const seenKb = new Set(existing.knowledgeBaseIds as bigint[]);
          existing.knowledgeBaseIds = [
            ...(existing.knowledgeBaseIds as bigint[]),
            ...kbIds.filter((id) => !seenKb.has(id)),
          ];
          const seenTool = new Set(existing.enabledTools as string[]);
          existing.enabledTools = [
            ...(existing.enabledTools as string[]),
            ...g.enabledTools.filter((t) => !seenTool.has(t)),
          ];
        } else {
          rows.push({
            tenantId,
            agentId,
            source: "RAG",
            enabledTools: g.enabledTools,
            knowledgeBaseIds: kbIds,
          });
        }
        break;
      }
      case "HTTP": {
        // Resolved by the MODEL-FACING name, like every other question about a tool name: the row
        // the loops just reused may be stored under an older spelling (`Foo` answering to `foo`),
        // and an exact lookup would drop the grant with `httpGrantNotFound` for a tool that is
        // right there (namespace.ts).
        const wanted = renamed.httpTools.get(g.tool) ?? g.tool;
        // WHICH row, not "is the name taken": a destination can hold `Foo` and `foo` from before
        // the unique index was case-insensitive, and binding the wrong one hands the agent another
        // endpoint with another credential. Ambiguity is reported, never resolved by picking.
        const match = await toolUnderModelName(db, wanted, "http");
        if (match.kind === "ambiguous") {
          warnings.push({
            code: "httpGrantAmbiguous",
            params: { name: g.tool, n: match.ids.length },
            target: { kind: "tool", name: g.tool },
          });
          break;
        }
        const td = match.kind === "one" ? { id: match.id } : null;
        if (!td) {
          warnings.push({
            code: "httpGrantNotFound",
            params: { name: g.tool },
            target: { kind: "tool", name: g.tool },
          });
          break;
        }
        // Two grants on one row are one grant: a bundle that carries a native-named component
        // twice grants it twice, and `ats_http_uq` would abort the whole import over the pair.
        if (
          rows.some((r) => r.source === "HTTP" && r.toolDefinitionId === td.id)
        ) {
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
      case "CODE": {
        // By the model-facing name, for the reason the HTTP arm gives.
        const wantedCode = renamed.codeTools.get(g.tool) ?? g.tool;
        const codeMatch = await toolUnderModelName(db, wantedCode, "code");
        if (codeMatch.kind === "ambiguous") {
          warnings.push({
            code: "codeGrantAmbiguous",
            params: { name: g.tool, n: codeMatch.ids.length },
            target: { kind: "codeTool", name: g.tool },
          });
          break;
        }
        const cd = codeMatch.kind === "one" ? { id: codeMatch.id } : null;
        if (!cd) {
          warnings.push({
            code: "codeGrantNotFound",
            params: { name: g.tool },
            target: { kind: "codeTool", name: g.tool },
          });
          break;
        }
        // NOTE: two grants on one row are one grant, for the reason the HTTP arm gives:
        // `ats_code_uq` would abort the whole import over the pair.
        if (
          rows.some(
            (r) => r.source === "CODE" && r.codeToolDefinitionId === cd.id,
          )
        ) {
          break;
        }
        rows.push({
          tenantId,
          agentId,
          source: "CODE",
          codeToolDefinitionId: cd.id,
          enabledTools: [],
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
