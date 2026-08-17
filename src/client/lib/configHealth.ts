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
  | "knowledge"
  | "embedding"
  | "redirect";

export interface ConfigIssue {
  key: ConfigIssueKey;
  // Deep-link target for credential issues (tab + section anchor). Absent for "knowledge" issues,
  // which open the knowledge-base documents modal instead of scrolling to a section.
  tab?: "general" | "behavior" | "channelRedirect";
  // The DOM anchor id of the section to scroll to (matches the section's `id`).
  sectionId?: string;
  // When true, the credential IS referenced but its secret has not been filled yet (a "pending"
  // vault entry). The fix is to fill it in the vault — not to pick another credential — so the
  // editor deep-links to the vault fill modal instead of scrolling to the section.
  pending?: boolean;
  // The pending vault entry id (parsed from the `vault:<id>` ref). Only set when `pending` is true.
  vaultId?: string;
  // For "knowledge" issues: the base that has imported-but-unindexed documents (and its name), so the
  // editor can open that base's documents modal.
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
}

export interface ConfigHealthInput {
  modelProvider: string;
  modelCredentialRef: string;
  // The agent model's EFFECTIVE endpoint, which the rewrite inherits while its provider is the
  // agent's own.
  modelBaseURL?: string;
  sttEnabled: boolean;
  sttCredentialRef: string;
  // TTS has no boolean toggle — any mode other than "never" means audio replies are on.
  ttsMode: string;
  ttsCredentialRef: string;
  // The speech rewrite's four overrides, passed WHOLE because the question they answer is answered
  // by the shared resolver, not re-derived here: which provider, whose key, which endpoint.
  ttsNormalize?: boolean;
  ttsNormalizeProvider?: string;
  ttsNormalizeCredentialRef?: string;
  ttsNormalizeBaseURL?: string;
  visionEnabled: boolean;
  visionCredentialRef: string;
  // Refs (`vault:<id>`) whose vault entry exists but is still pending (secret not filled in yet). A
  // feature wired to one of these is configured but cannot run until the operator fills it.
  pendingRefs?: Set<string>;
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

const VAULT_REF_PREFIX = "vault:";

// For one credentialed feature, decides which issue (if any) to raise:
//   - not enabled → none;
//   - enabled with NO ref → "missing" (the classic enabled-but-uncredentialed case);
//   - enabled with a ref that points to a PENDING vault entry → "pending" (referenced, not filled).
function credIssue(
  enabled: boolean,
  ref: string,
  pendingRefs: Set<string> | undefined,
): { pending: boolean; vaultId?: string } | null {
  if (!enabled) return null;
  if (!ref) return { pending: false };
  if (pendingRefs?.has(ref)) {
    return { pending: true, vaultId: ref.slice(VAULT_REF_PREFIX.length) };
  }
  return null;
}

// Returns the list of features that are enabled but cannot run: either no credential is set
// ("missing"), or the referenced credential is a pending vault entry whose secret is not filled yet
// ("pending"). An OpenAI-compatible model can authenticate via its base URL alone, so it is not
// flagged (mirrors the editor's `required={provider !== "openai-compatible"}`).
export function computeConfigIssues(input: ConfigHealthInput): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const pending = input.pendingRefs;
  const push = (
    base: ConfigIssue,
    res: { pending: boolean; vaultId?: string } | null,
  ): void => {
    if (!res) return;
    issues.push(
      res.pending ? { ...base, pending: true, vaultId: res.vaultId } : base,
    );
  };
  push(
    { key: "model", tab: "general", sectionId: "general-model" },
    credIssue(
      Boolean(
        input.modelProvider && input.modelProvider !== "openai-compatible",
      ),
      input.modelCredentialRef,
      pending,
    ),
  );
  push(
    { key: "stt", tab: "behavior", sectionId: "stt" },
    credIssue(input.sttEnabled, input.sttCredentialRef, pending),
  );
  push(
    { key: "tts", tab: "behavior", sectionId: "tts" },
    credIssue(input.ttsMode !== "never", input.ttsCredentialRef, pending),
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
          normalizeCredentialRef: input.ttsNormalizeCredentialRef,
          normalizeBaseURL: input.ttsNormalizeBaseURL,
        },
        {
          provider: input.modelProvider,
          model: "",
          baseURL: input.modelBaseURL ?? null,
        },
      )
    : null;
  const normalizeNeedsOwnKey =
    normalizeResolution !== null &&
    // Either the resolver refuses it for want of a credential, or one is configured and has to
    // resolve (REST and MCP accept a credential with no provider: same vendor, another account).
    (normalizeResolution.reason === "provider_without_credential" ||
      Boolean(input.ttsNormalizeCredentialRef));
  push(
    { key: "ttsNormalize", tab: "behavior", sectionId: "tts" },
    credIssue(
      normalizeNeedsOwnKey,
      input.ttsNormalizeCredentialRef ?? "",
      pending,
    ),
  );
  push(
    { key: "vision", tab: "behavior", sectionId: "vision" },
    credIssue(input.visionEnabled, input.visionCredentialRef, pending),
  );
  // Knowledge bases with documents awaiting indexing. Indexing needs the tenant's embedding credential,
  // so if that prerequisite is missing we raise ONE "embedding" issue (the root cause) instead of N
  // per-base "index me" prompts that would just fail: no ref → point at embedding settings; a
  // referenced-but-unfilled ref → the vault fill (pending). Only when embedding IS usable do we surface
  // the per-base "knowledge" issues (the operator just needs to click index).
  const kbsNeedingIndex = input.knowledgeBasesNeedingIndex ?? [];
  if (kbsNeedingIndex.length > 0) {
    const embRef = input.embeddingCredentialRef ?? "";
    if (!embRef) {
      issues.push({ key: "embedding" });
    } else if (input.pendingRefs?.has(embRef)) {
      issues.push({
        key: "embedding",
        pending: true,
        vaultId: embRef.slice(VAULT_REF_PREFIX.length),
      });
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
  return issues;
}
