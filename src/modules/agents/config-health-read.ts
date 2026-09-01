import type { PrismaClient } from "@/../generated/prisma/client";
import type { Locale } from "@/api/lib/i18n";
import { canonicalVaultRef, formatVaultRef } from "@/client/lib/credentialRef";
import { readModelFallbackConfig } from "@/graph/fallback-settings";
import { requireDbId } from "@/lib/db-id";
import type { TenantContext } from "@/lib/tenancy";
import {
  type ConfigIssue,
  computeConfigIssues,
} from "@/modules/agents/config-health";
import { configIssueTranslator } from "@/modules/agents/config-health-copy";
import { configIssueMessage } from "@/modules/agents/config-health-message";
import {
  type ConfigIssueSeverity,
  severityOf,
} from "@/modules/agents/config-health-severity";
import { getAgent, getAgentToolSelections } from "@/modules/agents/service";
import { readSchedule } from "@/modules/business-hours/service";
import { readChannelRedirectConfig } from "@/modules/channel-redirect/service";
import { listOutOfOfficeInboxes } from "@/modules/chatwoot/management";
import { readContactAuthConfig } from "@/modules/contact-auth/settings";
import {
  GUARDRAIL_HEALTH_WINDOW_HOURS,
  guardrailHealthWindowStart,
  readGuardrailHealth,
} from "@/modules/guardrails/health";
import { readGuardrailsConfig } from "@/modules/guardrails/settings";
import { readMemoryConfig } from "@/modules/memory/settings";
import { readSttConfig } from "@/modules/stt/settings";
import { getTenantSettings } from "@/modules/tenant-settings/service";
import { readTtsConfig } from "@/modules/tts/settings";
import { listVaultEntryInfos } from "@/modules/vault/service";
import { readVisionConfig } from "@/modules/vision/settings";

// "Is this agent's configuration healthy?", answered for a caller that is not the browser.
//
// The checks themselves are the console's, unchanged and shared (config-health.ts): an agent
// configured over MCP has to be judged by the same rules as one configured on the screen, or the two
// answers diverge and the operator has no way to tell which is lying. What this module adds is the
// half the editor got for free by being a page — it gathers the eight inputs those checks need, from
// the services that own them, instead of from a form.
//
// One difference from the editor is worth stating because it makes this reading STRICTER, not
// looser. The panel judges what the operator is typing next to what was last saved, and defers a few
// verdicts while the vault list is still in flight. Here there is no pending edit and no first
// paint: `knownRefs` is always loaded, so every deferral collapses and the answer is about the row
// as it stands.

export interface AgentConfigHealthIssue {
  key: ConfigIssue["key"];
  severity: ConfigIssueSeverity;
  // The same sentence the console shows for this issue, in the requested language.
  message: string;
  // Where the fix lives in the console, when the issue has a place there: the editor tab and the
  // section anchor. Absent for the two that open something else (a knowledge base's documents, the
  // tenant's embedding settings) and for a capped field with no control.
  tab?: string;
  sectionId?: string;
  // The credential is referenced but its secret was never filled (`pending`), or the vault does not
  // hold it at all (`unresolved`). Both are states a write can create and neither is visible to the
  // caller that created it.
  pending?: boolean;
  unresolved?: boolean;
  vaultId?: string;
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  // For a `textCap` issue: which field, what it holds, and what the reader keeps.
  field?: string;
  length?: number;
  max?: number;
}

// A check this answer does NOT account for, either because the reading failed or because the caller
// asked for the cheap variant. One word for both, because the consequence is the same: this is the
// list of things a clean answer is not vouching for. Both of them fail as an EMPTY result, which
// reads exactly like "nothing to report", so a caller acting on a clean answer has to be told.
export type UncheckedCheck = "chatwootOutOfOffice" | "guardrailHealth";

export interface AgentConfigHealth {
  agentId: string;
  agentName: string;
  // No blocking and no degraded issue. Advisory ones do not make an agent unhealthy: nothing is off,
  // and the operator has already been given the choice.
  healthy: boolean;
  counts: Record<ConfigIssueSeverity, number>;
  issues: AgentConfigHealthIssue[];
  unchecked: UncheckedCheck[];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export interface ReadAgentConfigHealthOptions {
  base?: PrismaClient;
  // The language the sentences come back in. Defaults to English, which is what every non-browser
  // surface here speaks; the REST route passes the request's own.
  locale?: Locale;
  // Formats the timestamp inside the guardrail-failure sentence. Absent → the raw ISO value, which
  // is what a JSON caller wants and what the console would rather render itself.
  formatWhen?: (iso: string) => string;
  // Whether to take the two readings that leave this process: Chatwoot's out-of-hours replies, and
  // the guardrail failure count. Default true. `false` is for the caller that runs this on every
  // write — a request to Chatwoot per agent write would put another product's latency (and its
  // outages) inside an unrelated operation. Both then land in `unchecked`, so the omission travels
  // with the answer instead of being invisible in it.
  live?: boolean;
}

export async function readAgentConfigHealth(
  ctx: TenantContext,
  agentId: bigint,
  opts: ReadAgentConfigHealthOptions = {},
): Promise<AgentConfigHealth> {
  const base = opts.base;
  const agent = await getAgent(ctx, agentId, base);
  const settings = agent.settings;

  // The vault list, which answers three different questions about the same six refs: does the entry
  // exist, is its secret filled, and does it carry a base URL that outranks the typed one. Same list
  // the console loads, read here through the service instead of the wire.
  const vault = await listVaultEntryInfos(ctx, base);
  const knownRefs = new Set(vault.map((e) => formatVaultRef(e.id)));
  const pendingRefs = new Set(
    vault
      .filter((e) => e.status === "pending")
      .map((e) => formatVaultRef(e.id)),
  );
  const baseUrlByRef = new Map(
    vault.map((e) => [formatVaultRef(e.id), e.baseUrl]),
  );
  const vaultBaseUrl = (ref: string | null | undefined): string | null => {
    const canonical = canonicalVaultRef(ref ?? "");
    return canonical === null ? null : (baseUrlByRef.get(canonical) ?? null);
  };

  const modelConfig = agent.modelConfig;
  const modelProvider = str(modelConfig.provider);
  const modelCredentialRef = str(modelConfig.credentialRef);
  // The endpoint the runtime will actually dial: a credential that carries one wins over the typed
  // field, exactly as `loadAgentConfig` reads it.
  const modelBaseURL =
    vaultBaseUrl(modelCredentialRef) ?? str(modelConfig.baseURL);

  const stt = readSttConfig(settings);
  const tts = readTtsConfig(settings);
  const vision = readVisionConfig(settings);
  const contactAuth = readContactAuthConfig(settings);
  const guardrails = readGuardrailsConfig(settings);
  const memory = readMemoryConfig(settings);
  const redirect = readChannelRedirectConfig(settings);

  const [tenantSettings, selections, schedule] = await Promise.all([
    getTenantSettings(ctx, base),
    getAgentToolSelections(ctx, agentId, base),
    agent.businessHoursId
      ? readSchedule(ctx, agent.businessHoursId, base)
      : Promise.resolve(null),
  ]);

  const ragGrant = selections.grants.find((g) => g.source === "RAG");
  const selectedKbIds = new Set(ragGrant?.knowledgeBaseIds ?? []);
  const knowledgeBasesNeedingIndex = selections.catalog.knowledgeBases
    .filter((k) => selectedKbIds.has(k.id) && k.unindexedCount > 0)
    .map((k) => ({ id: k.id, name: k.name }));

  // The two readings that leave this process. Settled rather than awaited together so one failure
  // costs its own check and not the whole answer — and it is REPORTED, because both of them fail as
  // an empty result that is indistinguishable from a clean one.
  const live = opts.live !== false;
  const unchecked: UncheckedCheck[] = [];
  const [outOfOffice, guardrailHealth] = await Promise.all([
    live
      ? listOutOfOfficeInboxes(ctx, agentId, {}, base).catch(() => {
          unchecked.push("chatwootOutOfOffice");
          return [] as { id: string; name: string }[];
        })
      : Promise.resolve([] as { id: string; name: string }[]),
    // Only asked when the screen is on: with guardrails off there is no count to interpret, and the
    // editor does not ask either. That case is NOT unchecked — there is nothing to check.
    live && guardrails.enabled
      ? readGuardrailHealth(
          ctx,
          agentId,
          guardrailHealthWindowStart(),
          base,
        ).catch(() => {
          unchecked.push("guardrailHealth");
          return null;
        })
      : Promise.resolve(null),
  ]);
  if (!live) {
    unchecked.push("chatwootOutOfOffice");
    if (guardrails.enabled) unchecked.push("guardrailHealth");
  }

  const issues = computeConfigIssues({
    settings,
    agentEnabled: agent.enabled,
    // Saved and "being edited" are the same value here: nothing is being typed. The pair stays in
    // the input because the console needs it, and collapsing it is what makes this reading answer
    // about the row rather than about a form.
    modelProvider,
    modelCredentialRef,
    savedModelProvider: modelProvider,
    savedModelBaseURL: modelBaseURL,
    savedModelCredentialRef: modelCredentialRef,
    savedMemoryCredentialBaseURL: vaultBaseUrl(memory.compaction.credentialRef),
    savedModelFallbackCredentialBaseURL: vaultBaseUrl(
      readModelFallbackConfig(settings).credentialRef,
    ),
    sttEnabled: stt.enabled,
    sttCredentialRef: stt.credentialRef ?? "",
    ttsMode: tts.mode,
    ttsCredentialRef: tts.credentialRef ?? "",
    ttsNormalize: tts.normalize,
    ttsNormalizeProvider: tts.normalizeProvider ?? "",
    ttsNormalizeModel: tts.normalizeModel ?? "",
    ttsNormalizeCredentialRef: tts.normalizeCredentialRef ?? "",
    ttsNormalizeBaseURL:
      vaultBaseUrl(tts.normalizeCredentialRef) ?? tts.normalizeBaseURL ?? "",
    visionEnabled: vision.enabled,
    visionCredentialRef: vision.credentialRef ?? "",
    contactAuthEnabled: contactAuth.enabled,
    contactAuthUrl: contactAuth.url ?? "",
    contactAuthCredentialRef: contactAuth.credentialRef ?? "",
    contactAuthIncludeMessageText: contactAuth.includeMessageText,
    contactAuthHandoffEnabled: contactAuth.handoffEnabled,
    contactAuthDenyMessage: contactAuth.denyMessage ?? "",
    guardrailsEnabled: guardrails.enabled,
    guardrailsCredentialRef: guardrails.credentialRef ?? "",
    guardrailsFailures: guardrailHealth?.failures,
    guardrailsLastFailureAt: guardrailHealth?.lastAt,
    pendingRefs,
    knownRefs,
    knowledgeBasesNeedingIndex,
    embeddingCredentialRef: tenantSettings.embedding.credentialRef ?? "",
    redirectEnabled: redirect.enabled,
    redirectEntryInboxId:
      redirect.entryInboxId === null ? "" : String(redirect.entryInboxId),
    redirectWidgetInboxId: redirect.widgetInboxId,
    outOfOfficeInboxes: outOfOffice,
    savedSchedule: schedule,
  });

  const translate = configIssueTranslator(opts.locale ?? "en");
  const counts: Record<ConfigIssueSeverity, number> = {
    blocking: 0,
    degraded: 0,
    advisory: 0,
  };
  const out: AgentConfigHealthIssue[] = issues.map((issue) => {
    const severity = severityOf(issue.key);
    counts[severity] += 1;
    return {
      key: issue.key,
      severity,
      message: configIssueMessage(issue, {
        translate,
        guardrailWindowHours: GUARDRAIL_HEALTH_WINDOW_HOURS,
        guardrailLastError: guardrailHealth?.lastError ?? "",
        ...(opts.formatWhen ? { formatWhen: opts.formatWhen } : {}),
      }),
      ...(issue.tab ? { tab: issue.tab } : {}),
      ...(issue.sectionId ? { sectionId: issue.sectionId } : {}),
      ...(issue.pending ? { pending: true } : {}),
      ...(issue.unresolved ? { unresolved: true } : {}),
      ...(issue.vaultId ? { vaultId: issue.vaultId } : {}),
      ...(issue.knowledgeBaseId
        ? { knowledgeBaseId: issue.knowledgeBaseId }
        : {}),
      ...(issue.knowledgeBaseName
        ? { knowledgeBaseName: issue.knowledgeBaseName }
        : {}),
      ...(issue.field ? { field: issue.field } : {}),
      ...(issue.length !== undefined ? { length: issue.length } : {}),
      ...(issue.max !== undefined ? { max: issue.max } : {}),
    };
  });

  return {
    agentId: agent.id,
    agentName: agent.name,
    healthy: counts.blocking === 0 && counts.degraded === 0,
    counts,
    issues: out,
    unchecked,
  };
}

// What a WRITE reports back about the state it just left behind.
//
// A read tool answers "how am I doing" to a caller who thought to ask. This answers it to the caller
// who did not — at the moment the operator could still fix it in the same breath, which is the point
// in the whole loop where the fix is cheapest. The write that creates the classic bad state (wiring
// a credential whose secret was never filled) is precisely the one that has no idea it did.
//
// Two deliberate reductions, both from the same rule that `healthy` uses:
//
//   * no live readings (`live: false`), so a write never waits on Chatwoot or pays its outages;
//   * ADVISORY issues are left out of `issues`. They are choices the operator has already made, not
//     damage this write did, and a write that answers with all of them trains its caller to skip the
//     block. They are still counted, so the caller can see there is more and call the read tool.
//
// Always present, even when everything is fine: a field that disappears when healthy cannot be told
// apart from a tool that never checked.
export interface ConfigHealthAfterWrite {
  healthy: boolean;
  counts: Record<ConfigIssueSeverity, number>;
  issues: AgentConfigHealthIssue[];
  unchecked: UncheckedCheck[];
}

// The id is taken as EITHER spelling because half the write tools hold the bigint they parsed from
// the caller and the other half only have the DTO they just produced, whose `id` is a string. One
// parse here, through the tree's own bounded one, beats a `BigInt(...)` at each of those call sites.
export async function configHealthAfterWrite(
  ctx: TenantContext,
  agentId: bigint | string,
  base?: PrismaClient,
): Promise<{ configHealth: ConfigHealthAfterWrite }> {
  const id = typeof agentId === "bigint" ? agentId : requireDbId(agentId);
  const health = await readAgentConfigHealth(ctx, id, {
    ...(base ? { base } : {}),
    live: false,
  });
  return {
    configHealth: {
      healthy: health.healthy,
      counts: health.counts,
      issues: health.issues.filter((i) => i.severity !== "advisory"),
      unchecked: health.unchecked,
    },
  };
}
