import {
  canonicalVaultRef,
  VAULT_REF_PREFIX,
} from "@/client/lib/credentialRef";
import { editorTargetFor } from "@/client/lib/editorRefusal";
import { isValidHttpUrl } from "@/client/lib/validation";
import {
  hasModelFallback,
  readModelFallbackConfig,
} from "@/graph/fallback-settings";
import { modelConfigSchema } from "@/graph/model-config";
import { resolveModelOverride } from "@/graph/model-override";
import { collectOversizedTextChanges } from "@/modules/agents/text-caps";
import { readAvailabilityConfig } from "@/modules/availability/away";
import {
  type Schedule,
  scheduleCanClose,
} from "@/modules/business-hours/hours";
import { readMemoryConfig } from "@/modules/memory/settings";
import { readKnowledgeConfig } from "@/modules/rag/review-settings";
import { resolveNormalizeModel } from "@/modules/tts/normalize-model";
import {
  type CredentialUse,
  credentialServes,
} from "@/modules/vault/secret-types";

// What the vault answers about one ref beyond "it exists". Kept as a pair rather than two parallel
// maps because the two are read together and a caller that had one and not the other would be
// asking the half-question this module exists to stop asking.
export interface VaultRefFacts {
  kind: string | null;
  // Whether the stored value is the shape `kind` declares (secretValueFitsKind, computed server-side
  // so no secret crosses the wire). True for a pending entry, which has no value yet.
  valueFitsKind: boolean;
}

// Live configuration-health checks for the agent editor (item 1): detect features that are turned on
// but missing the credential they need to actually run. The common trigger is importing an agent —
// the import never carries secrets, so every credential ref comes back unset. Each issue carries a
// deep-link target (tab + section anchor) so the editor can offer a one-click "Go to" jump.

export type ConfigIssueKey =
  | "model"
  // The PRIMARY model failing to BUILD, which the credential check above cannot see: it asks whether
  // a configured provider has a key, and these are about the bag itself. Two keys because the fixes
  // differ — one is the configuration, the other is an address — and both states are storable:
  // `modelConfig` may be `{}` by design (validateModelConfigForWrite: "unconfigured — the agent
  // simply won't run until set"), an import stores whatever record the export carried, and an
  // openai-compatible bag with no endpoint passes every write boundary there is.
  | "modelNotRunnable"
  // Two spellings of one unreachable endpoint, because the operator's move differs: fill a field
  // that is required and empty, or correct one that is filled and undialable. The wording cannot
  // carry both — and it must not quote the value, since a base URL is one of the places a
  // credential gets pasted (the audit projection treats it that way already).
  | "modelNoEndpoint"
  | "modelBadEndpoint"
  | "stt"
  | "tts"
  | "ttsNormalize"
  | "memoryModel"
  // The knowledge suggestion reviewer's own model is set and cannot run: suggestions reach the
  // queue unreviewed, with nothing else saying so.
  | "suggestionReviewModel"
  | "modelFallback"
  | "vision"
  | "guardrails"
  | "guardrailsFailing"
  | "contactAuth"
  // Not a missing credential: two switches that cancel each other out. The unlock flow needs the
  // conversation to still be the bot's when the code arrives, and the handoff gives it away on the
  // first refusal.
  | "contactAuthUnlockHandoff"
  // Nor a missing credential: an enabled gate that neither answers the customer nor opens the
  // conversation, so a refusal reaches nobody.
  | "contactAuthSilentRefusal"
  | "contactAuthNoUrl"
  | "knowledge"
  | "embedding"
  | "redirect"
  // Two spellings of one collision, because the customer sees two different things and the operator
  // has two different fixes. "Both" is the duplicate: Chatwoot's inbox reply and the agent's away
  // message, back to back. "Chatwoot" is the contradiction: Chatwoot announces the closure and the
  // agent, which reads a schedule Chatwoot cannot see, serves the customer through it.
  | "outOfHoursBoth"
  | "outOfHoursChatwoot"
  | "textCap";

export interface ConfigIssue {
  key: ConfigIssueKey;
  // Deep-link target for credential issues (tab + section anchor). Absent for "knowledge" issues,
  // which open the knowledge-base documents modal instead of scrolling to a section, and for a
  // "textCap" issue on a field the editor has no control for.
  tab?:
    | "general"
    | "behavior"
    | "guardrails"
    | "channelRedirect"
    | "tools"
    | "knowledge";
  // The DOM anchor id of the section to scroll to (matches the section's `id`).
  sectionId?: string;
  // When true, the credential IS referenced but its secret has not been filled yet (a "pending"
  // vault entry). The fix is to fill it in the vault — not to pick another credential — so the
  // editor deep-links to the vault fill modal instead of scrolling to the section.
  pending?: boolean;
  // The pending vault entry id (parsed from the `vault:<id>` ref). Only set when `pending` is true.
  vaultId?: string;
  // When true, the credential is referenced but the vault does not hold it: it was deleted, or the
  // ref was written by something that does not check (REST stores it verbatim, and MCP speaks
  // NAMES, which no resolver matches). There is nothing to fill in, so this deep-links to the field
  // like a missing credential does.
  unresolved?: boolean;
  // When true, the credential exists and its secret is filled, and its TYPE cannot serve this field:
  // a multi-field or managed-blob entry where a plain API key is read, or one the catalog says never
  // travels outbound. The fix is a different credential, not filling this one in, so it deep-links to
  // the field like a missing credential does rather than to the vault fill modal.
  wrongKind?: boolean;
  // For "knowledge" issues: the base that has imported-but-unindexed documents (and its name), so the
  // editor can open that base's documents modal.
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  // For "textCap" issues: the dotted path of the field, what it holds, and what the reader keeps.
  field?: string;
  length?: number;
  max?: number;
  // For "guardrailsFailing": how many analyses could not run in the window, and when the last one
  // was. The count is what makes the warning actionable (one is a blip, forty is a dead screen) and
  // the timestamp is what lets an operator who just fixed it see the count stop.
  failures?: number;
  lastFailureAt?: string;
  // For the out-of-hours issues: the inboxes that answer out of hours from Chatwoot's side, by the
  // name CHATWOOT gives them. Named rather than counted because the fix is on the other product's
  // screen, and "two of your inboxes" does not tell anyone which two to open.
  inboxNames?: string[];
}

// Whether the warning row can offer an action. Everything else in this list has a fix the editor can
// reach — a section to scroll to, a vault entry to fill, a knowledge base to index — but a textCap
// issue for a note with no control in the console has nowhere to send anyone.
export function issueHasAction(issue: ConfigIssue): boolean {
  return issue.key !== "textCap" || Boolean(issue.tab);
}

function textCapIssues(
  settings: unknown,
  guardrailsEnabled: boolean | undefined,
): ConfigIssue[] {
  // Against nothing stored: every over-cap value in the bag is one the operator should know about,
  // which is the opposite question from the write boundary's (what does this write change).
  // NOTE: Where the field is edited comes from editorRefusal, the same map a REFUSAL about the path
  // routes on, so a warning and a refusal agree on where the field lives.
  return collectOversizedTextChanges(settings, undefined).map((o) => {
    const target = editorTargetFor(o.path, { guardrailsEnabled });
    return {
      key: "textCap" as const,
      ...(target ? { tab: target.tab, sectionId: target.sectionId } : {}),
      field: o.path,
      length: o.length,
      max: o.max,
    };
  });
}

export interface ConfigHealthInput {
  // The agent's settings AS STORED. The question here is about the row, not about the pending edit:
  // a field the operator is typing into already shows its own counter, and a warning that reacted to
  // keystrokes would flicker while they type.
  settings?: unknown;
  // The agent's model as the operator is EDITING it: this pair answers "does the model have a key",
  // which is a question about what the General tab is about to save.
  modelProvider: string;
  modelCredentialRef: string;
  // The endpoint that model would DIAL, with the credential's own base URL winning over the typed
  // field exactly as `loadAgentConfig` reads it. Only openai-compatible needs one, and it is the
  // one provider that authenticates by URL rather than by key — so for it, this is the field a
  // missing-credential check would otherwise be standing in for.
  modelBaseURL?: string;
  // The model bag AS IT WILL BE STORED, judged by the runtime's own schema. Required, since a bag
  // nobody validated is the case this exists for. The three fields above are projections of it,
  // derived by both callers from the same state (the endpoint is resolved against the vault).
  modelConfig: unknown;
  // The agent's own on/off, AS SAVED. Required rather than optional, and read by exactly one check:
  // the out-of-hours collision is the only line in this panel that claims something about what the
  // CUSTOMER receives. Every other line describes the configuration ("on, but no key"), which stays
  // true of an agent nobody has switched on; a disabled agent, though, says nothing to anybody, so
  // both spellings of that collision would be false. Required because the only thing that could
  // catch a caller dropping it is the compiler — no test mounts the editor.
  agentEnabled: boolean;
  // The agent's model as STORED, with its EFFECTIVE endpoint (a credential that carries one wins
  // over the typed field). Separate from the pair above on purpose: the speech rewrite inherits
  // from the SAVED model, because the editor's tabs save independently and a Behavior save carries
  // none of General's pending edits.
  savedModelProvider: string;
  savedModelBaseURL?: string;
  // The saved model's credential, needed for one question only: whether an endpoint the rewrite
  // INHERITS could still arrive from that credential once the vault answers.
  savedModelCredentialRef?: string;
  // The base URL carried by the SAVED summariser credential, which outranks the endpoint typed into
  // the bag exactly as it does at runtime (`loadAgentConfig` reads it from the vault). Without it
  // this check calls a summariser that runs perfectly well `endpoint_unusable` the moment the vault
  // answers, and misses the opposite case — a credential endpoint on a vendor that never sends one.
  // Null until the vault list lands, which is what the deferral below is for.
  savedMemoryCredentialBaseURL?: string | null;
  // The same, for the saved suggestion reviewer credential.
  savedSuggestionReviewCredentialBaseURL?: string | null;
  savedModelFallbackCredentialBaseURL?: string | null;
  sttEnabled: boolean;
  sttCredentialRef: string;
  // TTS has no boolean toggle — any mode other than "never" means audio replies are on.
  ttsMode: string;
  ttsCredentialRef: string;
  // The speech rewrite's four overrides, passed WHOLE because the question they answer is answered
  // by the shared resolver, not re-derived here: which provider and model, whose key, which
  // endpoint. The model id is here for the same reason the credential is — it belongs to the vendor
  // it was picked from, and a bag that does not name that vendor is refused.
  ttsNormalize?: boolean;
  ttsNormalizeProvider?: string;
  ttsNormalizeModel?: string;
  ttsNormalizeCredentialRef?: string;
  ttsNormalizeBaseURL?: string;
  visionEnabled: boolean;
  visionCredentialRef: string;
  // The contact authorization gate. Its credential is OPTIONAL (a public or IP-fenced endpoint
  // needs none), so an absent ref raises nothing; a ref that is pending or gone does, because the
  // gate fails closed and the agent goes silent for every contact.
  contactAuthEnabled?: boolean;
  contactAuthCredentialRef?: string;
  // The endpoint itself. `readContactAuthConfig` normalizes a missing or malformed URL to null and
  // leaves `enabled` alone, so the pair is storable — and the gate then refuses every message.
  contactAuthUrl?: string;
  // A local rule answers and no endpoint stage follows it, so the endpoint-only warnings are about a
  // request that is never made. False when the operator asked the endpoint after the rule: then the
  // endpoint is asked about what the rule allows, and its warnings are about a real request.
  contactAuthRuleOnly?: boolean;
  // The two sides of the unlock-vs-handoff contradiction, plus the copy: an enabled gate that
  // neither speaks nor hands over leaves a refused customer with nothing at all.
  contactAuthIncludeMessageText?: boolean;
  contactAuthHandoffEnabled?: boolean;
  contactAuthDenyMessage?: string;
  // Guardrails run on a model of their own, and theirs is the one credential whose failure is not
  // just a feature going quiet: `loadAgentConfig` fails open, so the analysis is skipped and every
  // message is delivered as if it had been screened and approved.
  guardrailsEnabled?: boolean;
  guardrailsCredentialRef?: string;
  // What the screen actually DID, read back from the execution log (modules/guardrails/health.ts):
  // how many analyses could not run in the recent window, and when the last one was. Configuration
  // alone cannot see this half. A model id the vendor retired, a parameter it rejects on every call
  // and a chronic timeout are all valid configuration until the call is made, and the pass is
  // fail-open, so each one delivers messages as if they had been reviewed. Absent or 0 raises
  // nothing: the count has to have arrived from the server to mean anything.
  guardrailsFailures?: number;
  guardrailsLastFailureAt?: string | null;
  // Refs (`vault:<id>`) whose vault entry exists but is still pending (secret not filled in yet). A
  // feature wired to one of these is configured but cannot run until the operator fills it.
  pendingRefs?: Set<string>;
  // Every ref the vault currently holds, so a ref that resolves to nothing can be told apart from
  // one that resolves. `null`/absent means the list has NOT loaded, and that has to be its own value
  // rather than an empty set: the vault arrives a request after the first paint, and an empty set
  // would read as "nothing resolves" and flag every credential on the page for that one paint.
  // Under-reporting for a moment is the safe direction here; over-reporting trains the operator to
  // ignore the panel.
  knownRefs?: Set<string> | null;
  // What each ref in `knownRefs` IS: an entry can exist, be filled and still not serve a field, by its
  // type or by a value that type does not describe. `null`/absent means the vault has not answered yet,
  // as for `knownRefs`.
  refFacts?: Map<string, VaultRefFacts> | null;
  // Knowledge bases this agent uses that still have documents awaiting indexing (status UNINDEXED),
  // e.g. right after an import that bundled the source text. Each becomes a "knowledge" issue — unless
  // the embedding prerequisite below is missing, in which case a single "embedding" issue is raised.
  knowledgeBasesNeedingIndex?: { id: string; name: string }[];
  // The tenant's embedding credential ref (`vault:<id>` or a name), or "" if embedding is unconfigured.
  // Indexing a knowledge base needs it; when it is missing or pending, the KB "needs indexing" prompts
  // roll up into one "embedding" issue that points at the real fix.
  embeddingCredentialRef?: string;
  // WhatsApp→web-chat redirect: enabled but missing one of the two required inboxes → it cannot run.
  redirectEnabled?: boolean;
  redirectEntryInboxId?: string;
  redirectWidgetInboxId?: number | null;
  // The agent's bound inboxes on which Chatwoot sends an out-of-hours reply of its own, read live by
  // the server (chatwoot/management.ts). Absent or empty raises nothing, and the two cases are
  // deliberately the same value: a Chatwoot that could not be read reports no inboxes, and a warning
  // invented by an outage is worse than one that arrives a page load late.
  outOfOfficeInboxes?: { id: string; name: string }[];
  // The schedule the agent is bound to AS SAVED, or null for "always on". Needed to answer which of
  // the two collisions this is: the away message is gated by the same schedule that gates replies, so
  // an agent that never closes never sends it however the block is configured.
  savedSchedule?: Schedule | null;
}

// The four ways one credentialed feature can be unrunnable. Every credential ref on the agent goes
// through this one function, all ten of them: a rule that reaches half its fields is worse than no
// rule, because the half it misses now reads as checked.
type CredVerdict =
  | { kind: "missing" }
  | { kind: "pending"; vaultId: string }
  | { kind: "unresolved" }
  | { kind: "wrongKind" };

// What the vault has answered so far, as the three questions this module asks of a ref. Grouped
// because they travel together and are read together: a ref is judged against all three or none, and
// passing them one by one had already produced ten call sites of the same four arguments.
interface VaultView {
  pending: Set<string> | undefined;
  known: Set<string> | null | undefined;
  // What the vault knows about each ref in `known` beyond its existence: the kind it declares, and
  // whether its stored value is the shape that kind describes. Both, because the runtime asks both
  // and a panel that asks fewer calls an agent healthy on a configuration the turn refuses. Absent
  // (not merely empty) until the vault answers, exactly like `known`: an empty map would read as
  // "nothing fits" and flag every credential on the page for one paint.
  facts: Map<string, VaultRefFacts> | null | undefined;
}

// For one credentialed feature, decides which issue (if any) to raise:
//   - not enabled → none;
//   - enabled with NO ref → "missing" (the classic enabled-but-uncredentialed case);
//   - enabled with a ref that points to a PENDING vault entry → "pending" (referenced, not filled);
//   - enabled with a ref the vault does not hold → "unresolved" (deleted, or never resolvable).
// "pending" and "unresolved" are mutually exclusive (a pending entry is also a known ref), and they
// stay separate verdicts because the fixes differ: fill the secret in place, or pick another key.
function credIssue(
  enabled: boolean,
  ref: string,
  use: CredentialUse,
  vault: VaultView,
): CredVerdict | null {
  if (!enabled) return null;
  if (!ref) return { kind: "missing" };
  const canonical = canonicalVaultRef(ref);
  if (canonical !== null && vault.pending?.has(canonical)) {
    return {
      kind: "pending",
      vaultId: canonical.slice(VAULT_REF_PREFIX.length),
    };
  }
  // A ref no id can be read out of is unresolvable on its own terms, but it is still only REPORTED
  // once the vault has answered: one panel that stays quiet until it knows is easier to trust than
  // one that is right about a rare case and wrong about every field for a paint.
  if (vault.known && (canonical === null || !vault.known.has(canonical))) {
    return { kind: "unresolved" };
  }
  // NOTE: Present, filled, and unable to serve this field: its TYPE cannot supply what the field reads,
  // or its VALUE is not its type's shape. Both are what `tryResolveApiKeyEntry` refuses at the turn.
  // Only once the vault has answered, like `unresolved`.
  if (canonical !== null && vault.facts) {
    const facts = vault.facts.get(canonical);
    if (facts !== undefined && !credentialServes(facts, use)) {
      return { kind: "wrongKind" };
    }
  }
  return null;
}

// Whether an endpoint the vault has not answered for yet could still arrive for this model override,
// which decides whether a refusal is a verdict or a paint too early. The agent's credential counts
// only when the override INHERITS the agent's provider (naming none inherits): another vendor's host
// cannot come from the agent's key.
function endpointCouldStillArrive(
  endpointsKnown: boolean,
  override: { provider?: string | null; credentialRef?: string | null },
  agent: { provider?: string | null; credentialRef?: string | null },
): boolean {
  if (endpointsKnown) return false;
  if (override.credentialRef) return true;
  const inherits = !override.provider || override.provider === agent.provider;
  return inherits && Boolean(agent.credentialRef);
}

// Whether the endpoint this model would DIAL is missing or undialable. Only `openai-compatible`
// (required) and `openrouter` (optional) read `baseURL` in `createChatModel`. The schema accepts
// `llama:8080`, and `isValidHttpUrl` accepts "" on purpose, so emptiness is judged here.
function endpointVerdict(
  provider: string,
  baseURL: string,
): "missing" | "invalid" | null {
  const stated = baseURL.trim();
  if (provider === "openai-compatible") {
    if (!stated) return "missing";
    return isValidHttpUrl(stated) ? null : "invalid";
  }
  if (provider === "openrouter") {
    // Optional: no endpoint is the DEFAULT and is correct. One that was typed still has to work,
    // because `cfg.baseURL || OPENROUTER_BASE_URL` hands the typed value straight to the client.
    return stated && !isValidHttpUrl(stated) ? "invalid" : null;
  }
  return null;
}

export function computeConfigIssues(input: ConfigHealthInput): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const vault: VaultView = {
    pending: input.pendingRefs,
    known: input.knownRefs,
    facts: input.refFacts,
  };
  const push = (base: ConfigIssue, res: CredVerdict | null): void => {
    if (!res) return;
    if (res.kind === "pending") {
      issues.push({ ...base, pending: true, vaultId: res.vaultId });
    } else if (res.kind === "unresolved") {
      issues.push({ ...base, unresolved: true });
    } else if (res.kind === "wrongKind") {
      issues.push({ ...base, wrongKind: true });
    } else {
      issues.push(base);
    }
  };
  // Can the primary model be built at all, asked of the runtime's own two authorities: the
  // schema `parseModelConfig` throws on every turn, and the endpoint `createChatModel` needs (which
  // may arrive on the credential, so the schema cannot judge it).
  const modelTarget = {
    key: "modelNotRunnable",
    tab: "general",
    sectionId: "general-model",
  } as const;
  if (!modelConfigSchema.safeParse(input.modelConfig).success) {
    issues.push({ ...modelTarget });
  } else {
    const endpoint = endpointVerdict(
      input.modelProvider,
      input.modelBaseURL ?? "",
    );
    // Wait while the vault is unread and a credential is set: the credential's base URL WINS over
    // the typed field (here and at runtime), so it may still replace an undialable string.
    const owed = vault.known === null && Boolean(input.modelCredentialRef);
    if (endpoint !== null && !owed) {
      issues.push({
        ...modelTarget,
        key: endpoint === "invalid" ? "modelBadEndpoint" : "modelNoEndpoint",
      });
    }
  }
  // NOTE: An OpenAI-compatible model authenticates by its base URL, so only its ABSENT credential is
  // exempt: a set ref that does not resolve silences the whole agent.
  push(
    { key: "model", tab: "general", sectionId: "general-model" },
    credIssue(
      Boolean(input.modelProvider) &&
        (input.modelProvider !== "openai-compatible" ||
          Boolean(input.modelCredentialRef)),
      input.modelCredentialRef,
      "apiKey",
      vault,
    ),
  );
  push(
    { key: "stt", tab: "behavior", sectionId: "stt" },
    credIssue(input.sttEnabled, input.sttCredentialRef, "apiKey", vault),
  );
  push(
    { key: "tts", tab: "behavior", sectionId: "tts" },
    credIssue(
      input.ttsMode !== "never",
      input.ttsCredentialRef,
      "apiKey",
      vault,
    ),
  );
  // The speech rewrite fails SILENTLY at runtime (the audio goes out unrewritten), so this panel
  // is the only place it surfaces. Whether it needs a key is asked of the runtime's own resolver.
  const normalizeOn = Boolean(input.ttsNormalize) && input.ttsMode !== "never";
  const normalizeResolution = normalizeOn
    ? resolveNormalizeModel(
        {
          normalizeProvider: input.ttsNormalizeProvider,
          normalizeModel: input.ttsNormalizeModel,
          normalizeCredentialRef: input.ttsNormalizeCredentialRef,
          normalizeBaseURL: input.ttsNormalizeBaseURL,
        },
        // The SAVED model, never the one the General tab is holding: the two tabs save separately,
        // so a rewrite validated against an unsaved provider is validated against a configuration
        // that will not exist when the Behavior block lands.
        {
          provider: input.savedModelProvider,
          model: "",
          baseURL: input.savedModelBaseURL ?? null,
        },
        // The editor's strictness, not the runtime's, because this check exists FOR the bags the
        // editor never validated: `llama:8080` is a string, so the runtime's "is there anything
        // there" says yes and the rewrite dies at the first audio reply instead of here.
        { isUsableBaseURL: isValidHttpUrl },
      )
    : null;
  // Two independent ways the rewrite goes quiet, and they need different answers. The resolver
  // REFUSING is a settled fact — for ANY of its reasons, not only the ones about the credential: a
  // provider name we do not support and a missing endpoint kill the rewrite just as silently, and
  // the editor cannot save either one, so the bags that carry them arrive over REST and MCP and this
  // is the only place they are ever seen. The issue is raised whether or not a ref is present,
  // because a present-but-unusable ref is the whole problem. A resolvable configuration can still be
  // waiting on a vault entry nobody filled in, which is the ordinary pending case.
  const normalizeIssue: ConfigIssue = {
    key: "ttsNormalize",
    tab: "behavior",
    sectionId: "tts",
  };
  // An endpoint can arrive on a CREDENTIAL the vault has not answered for, so the verdict waits,
  // but only where a credential could carry one: a failed vault load may never recover, and waiting
  // then would delete the warning. A typed endpoint does not settle it (the credential's URL wins).
  const endpointsKnown = vault.known !== null;
  const endpointStillOwed = endpointCouldStillArrive(
    endpointsKnown,
    {
      provider: input.ttsNormalizeProvider,
      credentialRef: input.ttsNormalizeCredentialRef,
    },
    {
      provider: input.savedModelProvider,
      credentialRef: input.savedModelCredentialRef,
    },
  );
  const refusalHolds =
    normalizeResolution !== null &&
    !normalizeResolution.runnable &&
    !(endpointStillOwed && normalizeResolution.reason === "endpoint_unusable");
  if (refusalHolds) {
    // The refusal is a verdict on the BAG, so it holds whatever the vault says about the credential
    // itself, and it is what the operator has to act on first. One issue, not two.
    issues.push(normalizeIssue);
  } else {
    push(
      normalizeIssue,
      credIssue(
        normalizeResolution !== null &&
          Boolean(input.ttsNormalizeCredentialRef),
        input.ttsNormalizeCredentialRef ?? "",
        "apiKey",
        vault,
      ),
    );
  }
  // The attendance summariser's own model. Its job dies with the reason on its line, but nothing
  // in the console says so, and an attendance that ends while it is broken is never summarised. Read
  // against the SAVED model, like the rewrite.
  const compaction = readMemoryConfig(input.settings).compaction;
  const compactionOverridden =
    compaction.provider !== null ||
    compaction.model !== null ||
    compaction.credentialRef !== null ||
    compaction.baseURL !== null;
  // Nothing configured is not a configuration that can fail: it IS the agent's model, and an agent
  // model that cannot run is the "model" issue above. Raising a second line for it would tell the
  // operator to fix the summariser when the thing to fix is the agent.
  const compactionResolution =
    compaction.enabled && compactionOverridden
      ? resolveModelOverride(
          {
            provider: compaction.provider,
            model: compaction.model,
            credentialRef: compaction.credentialRef,
            baseURL: compaction.baseURL,
          },
          {
            provider: input.savedModelProvider,
            model: "",
            baseURL: input.savedModelBaseURL ?? null,
          },
          {
            ownCredentialBaseURL: input.savedMemoryCredentialBaseURL ?? null,
            isUsableBaseURL: isValidHttpUrl,
          },
        )
      : null;
  const compactionIssue: ConfigIssue = {
    key: "memoryModel",
    tab: "behavior",
    sectionId: "memory",
  };
  // The same wait as the rewrite's, for the same reason: an endpoint can still arrive on a
  // credential the vault has not answered for yet, and announcing a runnable summariser as broken is
  // the false alarm the null-until-loaded rule exists to prevent.
  const compactionEndpointOwed = endpointCouldStillArrive(
    endpointsKnown,
    { provider: compaction.provider, credentialRef: compaction.credentialRef },
    {
      provider: input.savedModelProvider,
      credentialRef: input.savedModelCredentialRef,
    },
  );
  const compactionRefusalHolds =
    compactionResolution !== null &&
    !compactionResolution.runnable &&
    !(
      compactionEndpointOwed &&
      compactionResolution.reason === "endpoint_unusable"
    );
  if (compactionRefusalHolds) {
    issues.push(compactionIssue);
  } else {
    push(
      compactionIssue,
      credIssue(
        compactionResolution !== null && Boolean(compaction.credentialRef),
        compaction.credentialRef ?? "",
        "apiKey",
        vault,
      ),
    );
  }
  // The suggestion reviewer's own model, judged like the summariser. Unset is the agent's model and
  // never an issue of its own.
  const review = readKnowledgeConfig(input.settings).suggestionReview;
  const reviewOverridden =
    review.provider !== null ||
    review.model !== null ||
    review.credentialRef !== null ||
    review.baseURL !== null;
  const reviewResolution = reviewOverridden
    ? resolveModelOverride(
        review,
        {
          provider: input.savedModelProvider,
          model: "",
          baseURL: input.savedModelBaseURL ?? null,
        },
        {
          ownCredentialBaseURL:
            input.savedSuggestionReviewCredentialBaseURL ?? null,
          isUsableBaseURL: isValidHttpUrl,
        },
      )
    : null;
  const reviewIssue: ConfigIssue = {
    key: "suggestionReviewModel",
    tab: "knowledge",
    sectionId: "kb-review",
  };
  const reviewEndpointOwed = endpointCouldStillArrive(
    endpointsKnown,
    { provider: review.provider, credentialRef: review.credentialRef },
    {
      provider: input.savedModelProvider,
      credentialRef: input.savedModelCredentialRef,
    },
  );
  if (
    reviewResolution !== null &&
    !reviewResolution.runnable &&
    !(reviewEndpointOwed && reviewResolution.reason === "endpoint_unusable")
  ) {
    issues.push(reviewIssue);
  } else {
    push(
      reviewIssue,
      credIssue(
        reviewResolution !== null && Boolean(review.credentialRef),
        review.credentialRef ?? "",
        "apiKey",
        vault,
      ),
    );
  }
  // The fallback provider, judged like the summariser: one that cannot be built is the same as
  // none, found out on the day the primary fails. Its credential can be PENDING after an import or
  // UNRESOLVED after a delete. `hasModelFallback` is its on switch.
  const fallback = readModelFallbackConfig(input.settings);
  const fallbackResolution = hasModelFallback(fallback)
    ? resolveModelOverride(
        {
          provider: fallback.provider,
          model: fallback.model,
          credentialRef: fallback.credentialRef,
          baseURL: fallback.baseURL,
        },
        {
          provider: input.savedModelProvider,
          model: "",
          baseURL: input.savedModelBaseURL ?? null,
        },
        {
          ownCredentialBaseURL:
            input.savedModelFallbackCredentialBaseURL ?? null,
          isUsableBaseURL: isValidHttpUrl,
        },
      )
    : null;
  const fallbackIssue: ConfigIssue = {
    key: "modelFallback",
    tab: "behavior",
    sectionId: "modelFallback",
  };
  // The same wait the two overrides above take: an endpoint can still arrive on a credential the
  // vault has not answered for yet, and calling a runnable fallback broken is the false alarm the
  // null-until-loaded rule exists to prevent.
  const fallbackEndpointOwed = endpointCouldStillArrive(
    endpointsKnown,
    { provider: fallback.provider, credentialRef: fallback.credentialRef },
    {
      provider: input.savedModelProvider,
      credentialRef: input.savedModelCredentialRef,
    },
  );
  const fallbackRefusalHolds =
    fallbackResolution !== null &&
    !fallbackResolution.runnable &&
    !(
      fallbackEndpointOwed && fallbackResolution.reason === "endpoint_unusable"
    );
  if (fallbackRefusalHolds) {
    issues.push(fallbackIssue);
  } else {
    push(
      fallbackIssue,
      credIssue(
        fallbackResolution !== null && Boolean(fallback.credentialRef),
        fallback.credentialRef ?? "",
        "apiKey",
        vault,
      ),
    );
  }
  push(
    { key: "vision", tab: "behavior", sectionId: "vision" },
    credIssue(input.visionEnabled, input.visionCredentialRef, "apiKey", vault),
  );
  // NOTE: gated on the ref being present, so "missing" can never fire for this feature: enabled
  // without a credential is a legitimate configuration here, unlike the blocks above.
  push(
    { key: "contactAuth", tab: "behavior", sectionId: "contactAuth" },
    credIssue(
      Boolean(input.contactAuthEnabled) &&
        !input.contactAuthRuleOnly &&
        Boolean(input.contactAuthCredentialRef),
      input.contactAuthCredentialRef ?? "",
      // The one field here that is not an API key: the gate resolves it through
      // `resolveInjectableCredentialEntry`, which hands back a fresh access token for the
      // managed-OAuth kinds. A `google_oauth` entry is correct configuration here and a warning
      // about it would be the panel contradicting a feature that works.
      "injectable",
      vault,
    ),
  );
  // The unlock flow and the handoff want opposite things from the same refusal. Forwarding the
  // message text exists so the customer can send an access code and be let in on their NEXT message;
  // the handoff opens the conversation and assigns it, and an open conversation is no longer the
  // bot's, so that next message never reaches the gate. The first refusal is then the last one, and
  // the copy asking for a code is asking for something that can no longer be read. Neither switch is
  // wrong on its own, so this is said rather than silently resolved.
  if (
    input.contactAuthEnabled &&
    !input.contactAuthRuleOnly &&
    input.contactAuthIncludeMessageText &&
    input.contactAuthHandoffEnabled
  ) {
    issues.push({
      key: "contactAuthUnlockHandoff",
      tab: "behavior",
      sectionId: "contactAuth",
    });
  }
  // An enabled gate with no endpoint to ask. The URL reader normalizes anything it cannot parse to
  // null and keeps `enabled` as it found it, so REST, MCP and an import can store the pair; the
  // runtime then fails closed on EVERY message with `not_configured`. That is the loudest failure
  // this feature has (the agent answers nobody) and the quietest to diagnose, because nothing about
  // a blank field says the gate in front of it is armed.
  // A local rule is the other way to reach a verdict, and with one alone the endpoint is never asked.
  // A rule with the endpoint asked after it still needs the endpoint: what the rule allows is refused.
  if (
    input.contactAuthEnabled &&
    !input.contactAuthRuleOnly &&
    !(input.contactAuthUrl ?? "").trim()
  ) {
    issues.push({
      key: "contactAuthNoUrl",
      tab: "behavior",
      sectionId: "contactAuth",
    });
  }
  // The other end of the same switchboard: a gate that refuses, says nothing and hands nobody the
  // conversation. The customer's message goes unanswered with no sign that anything happened, and
  // the only record is a private note somebody has to go and read. Both switches are legitimate on
  // their own — silence suits an unknown number, and no-handoff suits the unlock flow — so this is
  // said rather than forced: the fix is a deny message, or the handoff, and the operator picks.
  if (
    input.contactAuthEnabled &&
    !(input.contactAuthDenyMessage ?? "").trim() &&
    !input.contactAuthHandoffEnabled
  ) {
    issues.push({
      key: "contactAuthSilentRefusal",
      tab: "behavior",
      sectionId: "contactAuth",
    });
  }
  const guardrailsCred = credIssue(
    Boolean(input.guardrailsEnabled),
    input.guardrailsCredentialRef ?? "",
    "apiKey",
    vault,
  );
  push(
    { key: "guardrails", tab: "guardrails", sectionId: "gr-model" },
    guardrailsCred,
  );
  // The credentialed guardrail that still could not run: same consequence (messages delivered
  // unscreened), a cause no ref check can reach. Suppressed while the credential verdict above is
  // live, and not for tidiness: with no credential the runtime never builds the model and writes no
  // failure rows at all, so a count arriving next to a credential issue can only be a leftover from
  // before that credential broke. Fixing the ref is the move either way.
  if (
    input.guardrailsEnabled &&
    !guardrailsCred &&
    (input.guardrailsFailures ?? 0) > 0
  ) {
    issues.push({
      key: "guardrailsFailing",
      tab: "guardrails",
      sectionId: "gr-model",
      failures: input.guardrailsFailures,
      ...(input.guardrailsLastFailureAt
        ? { lastFailureAt: input.guardrailsLastFailureAt }
        : {}),
    });
  }
  // Knowledge bases with documents awaiting indexing. Indexing needs the tenant's embedding credential,
  // so if that prerequisite is missing we raise ONE "embedding" issue (the root cause) instead of N
  // per-base "index me" prompts that would just fail: no ref → point at embedding settings; a
  // referenced-but-unfilled ref → the vault fill (pending). Only when embedding IS usable do we surface
  // the per-base "knowledge" issues (the operator just needs to click index).
  const kbsNeedingIndex = input.knowledgeBasesNeedingIndex ?? [];
  if (kbsNeedingIndex.length > 0) {
    // The tenant's embedding key is the sixth ref that can dangle, and it fails exactly like the
    // other five — hence the same verdict function rather than a second reading of the same three
    // states. Only when it IS usable do the per-base "index me" prompts make sense.
    const embedding = credIssue(
      true,
      input.embeddingCredentialRef ?? "",
      // Not `apiKey`: this field's reader takes `{ apiKey, baseURL }` as well as the plain string,
      // so holding its value to the kind here would put a warning on a working configuration. The
      // KIND rule is the same one — a `google_oauth` entry is still flagged.
      "embeddingKey",
      vault,
    );
    if (embedding) {
      push({ key: "embedding" }, embedding);
    } else {
      for (const kb of kbsNeedingIndex) {
        issues.push({
          key: "knowledge",
          knowledgeBaseId: kb.id,
          knowledgeBaseName: kb.name,
        });
      }
    }
  }
  // Redirect is on but one of its two required inboxes is unset → the funnel is inert. Deep-link to the
  // Redirect tab's entry section so the operator can complete it (the runtime already no-ops meanwhile).
  if (
    input.redirectEnabled &&
    (!input.redirectEntryInboxId || input.redirectWidgetInboxId == null)
  ) {
    issues.push({
      key: "redirect",
      tab: "channelRedirect",
      sectionId: "cr-entry",
    });
  }
  // Chatwoot answers out of hours on an inbox this agent is bound to. Unlike every other check here
  // this one is not about a feature that cannot run: both features run, and it is the customer who
  // gets the wrong experience — two messages, or a closure notice followed by service.
  //
  // Which of the two is decided by the agent's SAVED availability block, never by what the operator
  // is typing: a warning that changed while a message is half-written would be describing a
  // configuration that does not exist yet. The same reading the runtime uses, because a second
  // reading of the same bag is a second answer waiting to happen.
  const outOfOffice = input.outOfOfficeInboxes ?? [];
  if (input.agentEnabled && outOfOffice.length > 0) {
    const away = readAvailabilityConfig(input.settings);
    // The switch and the copy are only two thirds of it. The away message rides the SAME gate that
    // silences replies, so an agent whose schedule never closes — none picked, or one with no windows
    // — sends nothing out of hours no matter what the block says, and calling that the duplicate
    // would describe two messages where the customer gets a closure notice and then normal service.
    // The condition is asked of the schedule module rather than restated here, because a console that
    // re-derives the gate's rule is a console that will disagree with it.
    const agentAlsoReplies =
      scheduleCanClose(input.savedSchedule) &&
      away.enabled &&
      away.awayMessage.trim() !== "";
    issues.push({
      key: agentAlsoReplies ? "outOfHoursBoth" : "outOfHoursChatwoot",
      tab: "behavior",
      // The section holds both halves of the answer: the schedule the agent follows and the switch
      // for its own message. Neither is the whole fix — Chatwoot's side is the other product's
      // screen — but every move the operator can make from this console starts there.
      sectionId: "availability",
      inboxNames: outOfOffice.map((i) => i.name),
    });
  }
  // Last: these are about text already in the row, not about a feature that cannot run, so they read
  // as the tail of the list rather than as the headline.
  issues.push(...textCapIssues(input.settings, input.guardrailsEnabled));
  return issues;
}
