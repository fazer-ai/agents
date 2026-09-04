import type { PrismaClient } from "@/../generated/prisma/client";
import type { Locale } from "@/api/lib/i18n";
import logger from "@/api/lib/logger";
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
  SEVERITY_ORDER,
  severityOf,
} from "@/modules/agents/config-health-severity";
import {
  getAgent,
  listKnowledgeBasesNeedingIndex,
} from "@/modules/agents/service";
import { readSchedule } from "@/modules/business-hours/service";
import { readChannelRedirectConfig } from "@/modules/channel-redirect/service";
import { readOutOfOfficeInboxes } from "@/modules/chatwoot/management";
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
import { dialableBaseUrl, listVaultEntryInfos } from "@/modules/vault/service";
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
  // The credential exists and is filled, and its TYPE cannot serve this field. Its own state, not a
  // third spelling of the two above: the fix is to pick a different credential.
  wrongKind?: boolean;
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
// "configHealth" is the whole reading, and it appears only on the write path: there the reading is a
// courtesy attached to an operation that already succeeded, so it is allowed to be absent.
export type UncheckedCheck =
  | "chatwootOutOfOffice"
  | "guardrailHealth"
  | "configHealth";

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
  // The fourth question over the same list: an entry that exists and is filled can still be unable to
  // serve the field naming it, by its TYPE or by holding a value that type does not describe (issue
  // #471). Read from the same rows as the three above, so the four answers cannot disagree about
  // which refs the vault holds.
  const refFacts = new Map(
    vault.map((e) => [
      formatVaultRef(e.id),
      { kind: e.kind, valueFitsKind: e.valueFitsKind },
    ]),
  );
  // NOTE: the DIALABLE one, not the stored one. `listVaultInfos` reports the row as it is, so the
  // console can show a base URL sitting on a kind whose form never rendered the field; what the
  // runtime will actually use is the resolved value, and this block answers for the runtime.
  const baseUrlByRef = new Map(
    vault.map((e) => [
      formatVaultRef(e.id),
      dialableBaseUrl(e.kind, e.baseUrl),
    ]),
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

  const [tenantSettings, knowledgeBasesNeedingIndex, schedule] =
    await Promise.all([
      getTenantSettings(ctx, base),
      // Not `getAgentToolSelections`: that view is the editor's, and it loads the tenant's entire
      // tool catalog to draw a page. This reading happens on every agent write now, so it asks for
      // the two facts it uses instead (see the header on the function).
      listKnowledgeBasesNeedingIndex(ctx, agentId, base),
      agent.businessHoursId
        ? readSchedule(ctx, agent.businessHoursId, base)
        : Promise.resolve(null),
    ]);

  // The two readings that leave this process. Settled rather than awaited together so one failure
  // costs its own check and not the whole answer — and it is REPORTED, because both of them fail as
  // an empty result that is indistinguishable from a clean one.
  const live = opts.live !== false;
  const unchecked: UncheckedCheck[] = [];
  const [outOfOffice, guardrailHealth] = await Promise.all([
    live
      ? readOutOfOfficeInboxes(ctx, agentId, {}, base)
          .then((r) => {
            // A failure is absorbed INSIDE that reader — it answers with a short list, not a
            // rejection — so the catch below never sees the case this field exists to report. The
            // count is per BOUND INBOX and covers every way one can go unread (the account never
            // answered, its entry never came back, its out-of-hours fields were not readable), which
            // is what makes "no inbox answers out of hours" distinguishable from "the state of one
            // was never seen".
            if (r.unreadable > 0) unchecked.push("chatwootOutOfOffice");
            return r.inboxes;
          })
          .catch(() => {
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
    modelBaseURL,
    // The stored bag, verbatim: an import writes whatever record the export carried
    // (`agentExportSchema` takes an arbitrary one), so this is the only place its shape is judged.
    modelConfig,
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
    refFacts,
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
      ...(issue.wrongKind ? { wrongKind: true } : {}),
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

  // WORST FIRST, which `SEVERITY_ORDER` declares and nothing was applying. The console orders by
  // feature — its panel is a page you scan, and the section a warning belongs to is what you scroll
  // to — but a caller reading JSON has no page, and the first entries are the ones it prints or
  // stops on.
  //
  // Sorted HERE and not inside `computeConfigIssues`, so the editor keeps the order it renders in.
  // And stable by construction: `Array.prototype.sort` has been required to be stable since ES2019,
  // and every key has a severity (the Record is exhaustive by type), so there is no element the
  // comparator leaves unplaced — which is what keeps the feature order INSIDE each severity.
  out.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );

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
  // `null` when the reading itself could not be taken. Not `false`: nothing was found to be wrong,
  // nobody looked. `unchecked` then carries "configHealth" and the lists are empty.
  healthy: boolean | null;
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
  try {
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
  } catch (e) {
    // BEST-EFFORT, AND THE ASYMMETRY IS THE WHOLE POINT. Every caller runs this AFTER its mutation
    // has committed, so a throw here would replace a successful apply with an error — and the client
    // reading that error is an automated one whose next move is to retry, which duplicates a create,
    // a clone or an import, or applies an update twice. A reading nobody could take is worth less
    // than the write it would undo, so it is reported as absent rather than raised.
    //
    // Absent, not clean: `healthy: null` plus "configHealth" in `unchecked` says what the rest of
    // this field says everywhere else — this answer does not vouch for that.
    logger.warn(
      "config health after write could not be read (agent=%s): %s",
      String(agentId),
      e instanceof Error ? e.message : String(e),
    );
    return {
      configHealth: {
        healthy: null,
        counts: { blocking: 0, degraded: 0, advisory: 0 },
        issues: [],
        unchecked: ["configHealth"],
      },
    };
  }
}
