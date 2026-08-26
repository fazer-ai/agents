import {
  canonicalVaultRef,
  VAULT_REF_PREFIX,
} from "@/client/lib/credentialRef";
import { isValidHttpUrl } from "@/client/lib/validation";
import {
  hasModelFallback,
  readModelFallbackConfig,
} from "@/graph/fallback-settings";
import { resolveModelOverride } from "@/graph/model-override";
import { collectOversizedTextChanges } from "@/modules/agents/text-caps";
import { readAvailabilityConfig } from "@/modules/availability/away";
import {
  type Schedule,
  scheduleCanClose,
} from "@/modules/business-hours/hours";
import { readMemoryConfig } from "@/modules/memory/settings";
import { resolveNormalizeModel } from "@/modules/tts/normalize-model";

// Live configuration-health checks for the agent editor (item 1): detect features that are turned on
// but missing the credential they need to actually run. The common trigger is importing an agent —
// the import never carries secrets, so every credential ref comes back unset. Each issue carries a
// deep-link target (tab + section anchor) so the editor can offer a one-click "Go to" jump.

export type ConfigIssueKey =
  | "model"
  | "stt"
  | "tts"
  | "ttsNormalize"
  | "memoryModel"
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
  tab?: "general" | "behavior" | "guardrails" | "channelRedirect" | "tools";
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

// Where a capped field is edited, by the path the walker reports. A path with no entry has no control
// in the editor: `toolGuidance` accepts a note for all thirteen native tools and only three of them
// have a field, so the rest can only have been written through REST or MCP. Those still get a
// warning — being cut in silence is the whole defect — just without a place to send the operator.
const TEXT_CAP_TARGETS: Array<{
  match: RegExp;
  tab: NonNullable<ConfigIssue["tab"]>;
  sectionId: string;
}> = [
  { match: /^handoff\.instructions$/, tab: "tools", sectionId: "tools-native" },
  { match: /^kanban\.instructions$/, tab: "tools", sectionId: "tools-native" },
  {
    match:
      /^toolGuidance\.(set_custom_attribute|assign_label|update_kanban_task)$/,
    tab: "tools",
    sectionId: "tools-native",
  },
  {
    match: /^guardrails\.customPolicy$/,
    tab: "guardrails",
    sectionId: "gr-policy",
  },
  { match: /^guardrails\.input\./, tab: "guardrails", sectionId: "gr-input" },
  { match: /^guardrails\.output\./, tab: "guardrails", sectionId: "gr-output" },
  { match: /^vision\.extractionPrompt$/, tab: "behavior", sectionId: "vision" },
  { match: /^followUp\.steps\[/, tab: "behavior", sectionId: "proactive" },
];

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
  return collectOversizedTextChanges(settings, undefined).map((o) => {
    const target = TEXT_CAP_TARGETS.find((t) => t.match.test(o.path));
    // The guardrails sections other than gr-model are rendered only while guardrails are ON, so with
    // them off the anchor is not in the DOM and the jump silently does nothing. gr-model is always
    // mounted and holds the switch that brings the rest back.
    const sectionId =
      target?.tab === "guardrails" && !guardrailsEnabled
        ? "gr-model"
        : target?.sectionId;
    return {
      key: "textCap" as const,
      ...(target ? { tab: target.tab, sectionId } : {}),
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

// The three ways one credentialed feature can be unrunnable. Every credential ref on the agent goes
// through this one function, all six of them: a rule that reaches half its fields is worse than no
// rule, because the half it misses now reads as checked.
type CredVerdict =
  | { kind: "missing" }
  | { kind: "pending"; vaultId: string }
  | { kind: "unresolved" };

// For one credentialed feature, decides which issue (if any) to raise:
//   - not enabled → none;
//   - enabled with NO ref → "missing" (the classic enabled-but-uncredentialed case);
//   - enabled with a ref that points to a PENDING vault entry → "pending" (referenced, not filled);
//   - enabled with a ref the vault does not hold → "unresolved" (deleted, or never resolvable).
// "pending" and "unresolved" are mutually exclusive for any list-derived input, since a pending
// entry EXISTS and is therefore also a known ref — the order below is for the reader, nothing
// depends on it: swapping the two branches changes no test, which is why this note replaced a claim
// that it did. What matters is that they stay separate verdicts, because the fixes differ — fill
// the secret in place, or pick a different key.
function credIssue(
  enabled: boolean,
  ref: string,
  pendingRefs: Set<string> | undefined,
  knownRefs: Set<string> | null | undefined,
): CredVerdict | null {
  if (!enabled) return null;
  if (!ref) return { kind: "missing" };
  const canonical = canonicalVaultRef(ref);
  if (canonical !== null && pendingRefs?.has(canonical)) {
    return {
      kind: "pending",
      vaultId: canonical.slice(VAULT_REF_PREFIX.length),
    };
  }
  // A ref no id can be read out of is unresolvable on its own terms, but it is still only REPORTED
  // once the vault has answered: one panel that stays quiet until it knows is easier to trust than
  // one that is right about a rare case and wrong about every field for a paint.
  if (knownRefs && (canonical === null || !knownRefs.has(canonical))) {
    return { kind: "unresolved" };
  }
  return null;
}

// Returns the list of features that are enabled but cannot run: no credential is set ("missing"),
// the referenced credential is a pending vault entry whose secret is not filled yet ("pending"), or
// the referenced credential is not in the vault at all ("unresolved"). An OpenAI-compatible model
// can authenticate via its base URL alone, so it is not flagged (mirrors the editor's
// `required={provider !== "openai-compatible"}`).
// WHETHER AN ENDPOINT THE VAULT HAS NOT ANSWERED FOR YET COULD STILL ARRIVE FOR THIS OVERRIDE, which
// is what decides whether a refusal is a verdict or a paint too early. Three model overrides ask it
// (the speech rewrite, the summariser and the fallback provider), and it was written out three times
// as "either credential is unread", which is right about the override's own key and wrong about the
// agent's.
//
// The agent's credential can only ever carry the endpoint for an override that INHERITS the agent's
// destination. Once the operator names a different provider the request goes to a different vendor,
// and nothing on the agent's key can supply that vendor's host — so waiting on it means the panel
// stays silent about a configuration that is definitely unrunnable, for as long as the vault is
// unavailable. Measured, on the fallback and on the summariser alike: an `openai-compatible`
// override with no address, on an agent that has a credential, reported NOTHING while `knownRefs`
// was null.
//
// An override that names no provider at all is the inheriting case by definition, which is how the
// two blocks whose default is "run this on the agent's model" keep the wait they need.
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

export function computeConfigIssues(input: ConfigHealthInput): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const pending = input.pendingRefs;
  const known = input.knownRefs;
  const push = (base: ConfigIssue, res: CredVerdict | null): void => {
    if (!res) return;
    if (res.kind === "pending") {
      issues.push({ ...base, pending: true, vaultId: res.vaultId });
    } else if (res.kind === "unresolved") {
      issues.push({ ...base, unresolved: true });
    } else {
      issues.push(base);
    }
  };
  // An OpenAI-compatible model authenticates through its base URL, so it needs no credential at all
  // (mirrors the editor's `required={provider !== "openai-compatible"}`). That exempts the ABSENT
  // credential and nothing else: a ref that IS set is resolved by `loadAgentConfig` before the
  // provider is ever consulted, and a ref that does not resolve returns null for the whole agent,
  // which is silence on every message rather than one feature going quiet.
  push(
    { key: "model", tab: "general", sectionId: "general-model" },
    credIssue(
      Boolean(input.modelProvider) &&
        (input.modelProvider !== "openai-compatible" ||
          Boolean(input.modelCredentialRef)),
      input.modelCredentialRef,
      pending,
      known,
    ),
  );
  push(
    { key: "stt", tab: "behavior", sectionId: "stt" },
    credIssue(input.sttEnabled, input.sttCredentialRef, pending, known),
  );
  push(
    { key: "tts", tab: "behavior", sectionId: "tts" },
    credIssue(
      input.ttsMode !== "never",
      input.ttsCredentialRef,
      pending,
      known,
    ),
  );
  // The speech rewrite. Both ways it fails are SILENT at runtime (best-effort: the audio still goes
  // out, unrewritten), so the editor is the only place they surface.
  //
  // Which configurations need a key of their own is not decided here: it is asked of the same
  // resolver the runtime uses, or the two drift. They already had, twice — a keyless
  // openai-compatible endpoint authenticates by its URL and needs no credential at all, and an
  // unsupported provider name needs a fix rather than a key.
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
  // One of the resolver's refusals is not a verdict on the bag alone: an endpoint the bag does not
  // state can arrive on a CREDENTIAL, and credential endpoints are read from the same vault list
  // that lands a request after the first paint. Until it does, an endpoint that is merely unread
  // looks absent, and announcing that a runnable rewrite cannot run is the false alarm the
  // null-until-loaded rule exists to prevent.
  //
  // So it waits, and only where waiting can change the answer. A missing vault list is not a
  // momentary state: a failed load leaves it missing until a mutation or a reload, so deferring a
  // verdict no credential could rescue would not delay that warning, it would delete it. Three
  // things have to be true at once, and each rules out a permanent problem:
  //
  //   * the vault has not answered — otherwise every endpoint is already known;
  //   * some credential is in play that could carry one: the rewrite's own, or the agent's, whose
  //     endpoint the rewrite inherits with the rest of its model.
  //
  // A stated endpoint does NOT settle it, which is worth writing down because the opposite reads as
  // obvious: a credential's own base URL WINS over the typed field, here and in the runtime alike
  // (`credentialBaseUrl ?? mc.baseURL`), so a credential still unread can replace an undialable
  // string with a working host. What settles it is having no credential to hear from, which is the
  // case in the reviewer's example — a keyless openai-compatible rewrite pointed at `llama:8080`.
  const endpointsKnown = known !== null;
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
        pending,
        known,
      ),
    );
  }
  // The attendance summariser's own model, when one is configured. Same resolver, same reasons, one
  // difference worth stating: this failure is not silent the way the rewrite's is — the job fails and
  // retries to DEAD with the reason on its line — but nothing in the console says so, and what is
  // lost is the contact's memory rather than one reply's delivery. An attendance that ends while this
  // is broken stays raw forever; nothing goes back for it.
  //
  // Read from the SAVED bag for the same reason the rewrite reads the saved model: the Behavior tab
  // carries none of General's pending edits, so a verdict against an unsaved provider is a verdict
  // against a configuration that will not exist when this block lands.
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
        pending,
        known,
      ),
    );
  }
  // The second provider behind the agent's own, judged exactly like the summariser above and for a
  // sharper reason: it is the one override whose whole purpose is to work on the day the primary
  // does not. A fallback that cannot be built is indistinguishable from having named none, and the
  // day it is asked for is the day nobody is watching a console.
  //
  // What made it worth a line of its own is the credential: this path is one of the eight in
  // `SETTINGS_CREDENTIAL_PATHS`, so an import or a transfer rewrites it to a PENDING ref that
  // carries no secret, and a deleted vault entry leaves it UNRESOLVED. Without an entry here both
  // read on screen as a configured fallback with no warning and no fill action, while the runtime
  // refuses to build it.
  //
  // No `enabled` flag to consult, unlike the summariser: `hasModelFallback` is the flag, and the two
  // halves of it are what the write boundary refuses to store apart.
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
        pending,
        known,
      ),
    );
  }
  push(
    { key: "vision", tab: "behavior", sectionId: "vision" },
    credIssue(input.visionEnabled, input.visionCredentialRef, pending, known),
  );
  // NOTE: gated on the ref being present, so "missing" can never fire for this feature: enabled
  // without a credential is a legitimate configuration here, unlike the blocks above.
  push(
    { key: "contactAuth", tab: "behavior", sectionId: "contactAuth" },
    credIssue(
      Boolean(input.contactAuthEnabled) &&
        Boolean(input.contactAuthCredentialRef),
      input.contactAuthCredentialRef ?? "",
      pending,
      known,
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
  if (input.contactAuthEnabled && !(input.contactAuthUrl ?? "").trim()) {
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
    pending,
    known,
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
      pending,
      known,
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
