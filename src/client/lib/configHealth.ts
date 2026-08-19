import {
  canonicalVaultRef,
  VAULT_REF_PREFIX,
} from "@/client/lib/credentialRef";
import { isValidHttpUrl } from "@/client/lib/validation";
import { collectOversizedTextChanges } from "@/modules/agents/text-caps";
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
  | "vision"
  | "guardrails"
  | "guardrailsFailing"
  | "knowledge"
  | "embedding"
  | "redirect"
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
  // The agent's model as STORED, with its EFFECTIVE endpoint (a credential that carries one wins
  // over the typed field). Separate from the pair above on purpose: the speech rewrite inherits
  // from the SAVED model, because the editor's tabs save independently and a Behavior save carries
  // none of General's pending edits.
  savedModelProvider: string;
  savedModelBaseURL?: string;
  // The saved model's credential, needed for one question only: whether an endpoint the rewrite
  // INHERITS could still arrive from that credential once the vault answers.
  savedModelCredentialRef?: string;
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
  const endpointStillOwed =
    !endpointsKnown &&
    Boolean(input.ttsNormalizeCredentialRef || input.savedModelCredentialRef);
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
  push(
    { key: "vision", tab: "behavior", sectionId: "vision" },
    credIssue(input.visionEnabled, input.visionCredentialRef, pending, known),
  );
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
  // Last: these are about text already in the row, not about a feature that cannot run, so they read
  // as the tail of the list rather than as the headline.
  issues.push(...textCapIssues(input.settings, input.guardrailsEnabled));
  return issues;
}
