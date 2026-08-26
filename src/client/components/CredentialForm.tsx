import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import {
  Check,
  ChevronDown,
  ExternalLink,
  PlugZap,
  Search,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/client/components/Button";
import {
  CredentialTestResult,
  type CredentialTestState,
} from "@/client/components/CredentialTestResult";
import { FormField } from "@/client/components/FormField";
import {
  GoogleOAuthSection,
  GoogleRedirectUriField,
} from "@/client/components/GoogleOAuthSection";
import { Input } from "@/client/components/Input";
import { ServiceLogo } from "@/client/components/icons/ServiceLogo";
import { McpOAuthSection } from "@/client/components/McpOAuthSection";
import { useUnsavedChanges } from "@/client/components/Modal";
import { Textarea } from "@/client/components/Textarea";
import { useToast } from "@/client/components/Toast";
import { providerLink } from "@/client/lib/affiliateLinks";
import { api } from "@/client/lib/api";
import {
  isTestableSecretType,
  SECRET_TYPE_IDS,
  secretTypeFields,
  secretTypeIsManagedBlob,
  secretTypeNeedsBase,
  secretTypeNeedsParamName,
  secretTypeRequiresBaseUrl,
  secretTypeService,
  secretTypeSupportsBaseUrl,
} from "@/client/lib/secretTypes";
import { cn } from "@/client/lib/utils";
import { isValidHttpUrl } from "@/client/lib/validation";

// Trim, 1..128 chars, no control characters (mirrors server validation).
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matches control chars to reject them
const NAME_RE = /^[^\x00-\x1f\x7f]{1,128}$/;

// Per-secret-type label. Magic comments register the dynamic keys for the extractor (also declared
// in VaultPanel for its list badge; duplicate declarations are deduped).
// t('vault.secretType.generic', 'Generic')
// t('vault.secretType.bearer_token', 'Bearer token')
// t('vault.secretType.chatwoot_api_token', 'Chatwoot')
// t('vault.secretType.header', 'Header')
// t('vault.secretType.basic_auth', 'Basic auth')
// t('vault.secretType.query', 'Query')
// t('vault.secretType.openai', 'OpenAI')
// t('vault.secretType.anthropic', 'Anthropic')
// t('vault.secretType.gemini', 'Google Gemini')
// t('vault.secretType.deepseek', 'DeepSeek')
// t('vault.secretType.openrouter', 'OpenRouter')
// t('vault.secretType.openai_compatible', 'OpenAI-compatible')
// t('vault.secretType.elevenlabs', 'ElevenLabs')
// t('vault.secretType.asaas', 'Asaas')
// t('vault.secretType.langfuse', 'Langfuse')
// t('vault.secretType.google_oauth', 'Google OAuth2')
// t('vault.secretType.mcp_oauth', 'MCP OAuth2')
// t('vault.secretType.mcp_env', 'MCP env var')

// Per-type description shown under the Type picker in create mode. Only the generic mechanism
// types have hints; service types (openai, anthropic, etc.) are self-explanatory.
// t('vault.secretTypeHint.generic', 'Stored as-is, with no automatic sending. For tools that reference the value manually.')
// t('vault.secretTypeHint.bearer_token', 'Sent on every request as the Authorization: Bearer header.')
// t('vault.secretTypeHint.header', 'Sent on every request as the header whose name you define.')
// t('vault.secretTypeHint.basic_auth', 'Sent as the Authorization: Basic header. The value must be user:password already base64-encoded.')
// t('vault.secretTypeHint.query', 'Sent as the query parameter whose name you define on the request URL.')
// t('vault.secretTypeHint.mcp_env', 'Injected as an environment variable into a stdio MCP process. Name it after the variable the process reads (e.g. API_TOKEN).')
const KIND_HINT_KEYS: Record<string, string> = {
  generic: "vault.secretTypeHint.generic",
  bearer_token: "vault.secretTypeHint.bearer_token",
  header: "vault.secretTypeHint.header",
  basic_auth: "vault.secretTypeHint.basic_auth",
  query: "vault.secretTypeHint.query",
  mcp_env: "vault.secretTypeHint.mcp_env",
};

// Type-picker display order: named services first (sorted by translated label at render), then the
// generic mechanisms in this fixed most-common-first order.
// t('vault.typeGroupServices', 'Services')
// t('vault.typeGroupGeneric', 'Generic')
const GENERIC_TYPE_ORDER: readonly string[] = [
  "bearer_token",
  "header",
  "query",
  "basic_auth",
  "generic",
];

// Parses a pasted Langfuse `.env` block into the credential's fields. Recognizes LANGFUSE_PUBLIC_KEY,
// LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL/LANGFUSE_HOST (each optionally `export `-prefixed and
// quoted). Returns null when NONE of the three are present, so the form can flag an unrecognized paste.
const LANGFUSE_ENV_RE =
  /^\s*(?:export\s+)?(LANGFUSE_[A-Z_]+)\s*=\s*["']?([^"'\n\r]+)["']?\s*$/;
export function parseLangfuseEnv(
  text: string,
): { publicKey?: string; secretKey?: string; baseUrl?: string } | null {
  const out: { publicKey?: string; secretKey?: string; baseUrl?: string } = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(LANGFUSE_ENV_RE);
    if (!m) continue;
    const key = m[1];
    const val = m[2]?.trim();
    if (!key || !val) continue;
    if (key === "LANGFUSE_PUBLIC_KEY") out.publicKey = val;
    else if (key === "LANGFUSE_SECRET_KEY") out.secretKey = val;
    else if (key === "LANGFUSE_BASE_URL" || key === "LANGFUSE_HOST")
      out.baseUrl = val;
  }
  return out.publicKey || out.secretKey || out.baseUrl ? out : null;
}

interface CredentialFormProps {
  mode: "create" | "update";
  // "Fill" a pending entry: a real secret value becomes MANDATORY (a rename-only save is rejected),
  // so completing the credential actually promotes it to active. Inert for managed-blob/OAuth kinds,
  // whose secret is supplied by the connect flow, not a typed value.
  requireValue?: boolean;
  initialName?: string;
  // Stable numeric id of the entry being updated (present only in update mode).
  initialId?: string;
  // Preselected secret type (the picker passes the context's compatible type so a new OpenAI key
  // is typed correctly without the operator choosing).
  initialKind?: string;
  // Pre-populated base URL (from the saved entry, passed by VaultPanel/CredentialPicker on update).
  initialBaseUrl?: string;
  // Pre-populated param name (from the saved entry, passed on update).
  initialParamName?: string;
  // ref is the stable `vault:<id>` reference of the saved entry (so the picker can select it).
  onSaved: (ref: string, name: string, kind: string | null) => void;
  onCancel: () => void;
}

// Shared credential editor: name + type + value, with the test-on-save block (probe the typed
// value before committing). Used by the Vault panel and by the CredentialPicker's inline "+ New
// credential" flow, so the test UX lives in exactly one place.
export function CredentialForm({
  mode,
  requireValue,
  initialName,
  initialId,
  initialKind,
  initialBaseUrl,
  initialParamName,
  onSaved,
  onCancel,
}: CredentialFormProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const typeLabel = (id: string) =>
    // biome-ignore lint/plugin/no-dynamic-i18n-key: secret-type keys registered via magic comments above
    t(`vault.secretType.${id}`, id);
  // Create mode seeds the name with the (generic) type label so the field is never blank; an
  // operator who hasn't customized it gets it re-synced to the picked provider on type change
  // (see the picker's onSelect). Update mode always receives the saved name, so the fallback is inert.
  const [name, setName] = useState(
    initialName ?? typeLabel(initialKind ?? "generic"),
  );
  const [kind, setKind] = useState(initialKind ?? "generic");
  // Plain string value (for non-multi-field types).
  const [value, setValue] = useState("");
  // Multi-field values keyed by field key (for types like langfuse).
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl ?? "");
  const [paramName, setParamName] = useState(initialParamName ?? "");
  // Whether the operator has engaged each conditional field. Gates the "required" errors so they
  // never fire just because a freshly picked type exposes an empty required field (the name is
  // pre-seeded, so it can't double as the "form started" signal). Reset whenever the type changes.
  const [baseUrlTouched, setBaseUrlTouched] = useState(false);
  const [paramNameTouched, setParamNameTouched] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<CredentialTestState>(null);
  const [saving, setSaving] = useState(false);
  // Langfuse-only: paste a `.env` block instead of filling the fields one by one. Defaults on for
  // langfuse (the easiest path); the operator can switch to the manual fields and back.
  const [langfusePaste, setLangfusePaste] = useState(
    initialKind === "langfuse",
  );
  const [envText, setEnvText] = useState("");
  const [envError, setEnvError] = useState(false);
  const [typeOpen, setTypeOpen] = useState(false);
  const [typeSearch, setTypeSearch] = useState("");
  const typeSearchRef = useRef<HTMLInputElement>(null);
  // For google_oauth create flow: after a successful create, stay open in connect mode (transition
  // to "update" internally so GoogleOAuthSection can use the saved id) until "Done" is clicked.
  const [savedIdForOAuth, setSavedIdForOAuth] = useState<string | null>(null);
  // savedRef stores the `ref` and `name` produced by the create so onSaved is called on "Done".
  const savedOAuthPayloadRef = useRef<{
    ref: string;
    name: string;
    kind: string | null;
  } | null>(null);

  // Post-create connect mode (google_oauth): the entry is saved, so the form renders exactly like
  // update mode (type locked, masked placeholders, "leave blank to keep" hints) — only the footer
  // differs ("Done" instead of Cancel/Save).
  const isPostCreateConnectMode = savedIdForOAuth !== null;
  const isUpdate = mode === "update" || isPostCreateConnectMode;
  const nameValid = NAME_RE.test(name.trim()) && name.trim().length > 0;
  const renaming = isUpdate && name.trim() !== (initialName ?? "");

  const fields = secretTypeFields(kind);
  const hasFields = !!fields && fields.length > 0;
  const needsParamName = secretTypeNeedsParamName(kind);
  const supportsBaseUrl = secretTypeSupportsBaseUrl(kind);
  const requiresBaseUrl = secretTypeRequiresBaseUrl(kind);
  // Managed-blob kinds (mcp_oauth) carry no value/field inputs: the secret is a server-managed JSON
  // blob created empty and populated by the connect flow. The form needs only name + baseUrl.
  const isManagedBlob = secretTypeIsManagedBlob(kind);
  const provLink = providerLink(kind);

  // For multi-field types: all fields must be either all filled or all empty (no partial).
  const allFieldsFilled =
    hasFields && fields.every((f) => !!fieldValues[f.key]?.trim());
  const anyFieldFilled =
    hasFields && fields.some((f) => !!fieldValues[f.key]?.trim());
  // The "value" for save purposes: for multi-field types it's the filled object, for plain types
  // it's the string. Used to determine whether a new value was typed.
  const hasNewValue = hasFields ? allFieldsFilled : !!value;

  // Create: name + value required. Update: value optional (blank keeps the current secret), so a
  // rename alone is a valid save. The type is locked once created.
  const paramNameMissing = needsParamName && !paramName.trim();
  const baseUrlMissing = requiresBaseUrl && !baseUrl.trim();
  const baseUrlInvalid = supportsBaseUrl && !isValidHttpUrl(baseUrl);
  const partialFields = hasFields && anyFieldFilled && !allFieldsFilled;
  const paramNameChanged =
    isUpdate && paramName.trim() !== (initialParamName ?? "");
  const baseUrlChanged = isUpdate && baseUrl.trim() !== (initialBaseUrl ?? "");
  // Filling a pending entry forces a real new secret (a rename-only save would leave it unfilled).
  // Managed-blob/OAuth kinds are exempt: their secret comes from the connect flow, not a typed value.
  const mustProvideValue = !!requireValue && !isManagedBlob;
  const canSave =
    nameValid &&
    !paramNameMissing &&
    !baseUrlMissing &&
    !baseUrlInvalid &&
    !partialFields &&
    (mustProvideValue
      ? hasNewValue
      : isUpdate
        ? renaming || hasNewValue || paramNameChanged || baseUrlChanged
        : isManagedBlob || hasNewValue);

  // google_oauth: whether the connect button may fire. Ready when the credential has a usable Client
  // ID + Client secret — both typed now (create), or already stored on a saved entry with no partial
  // edit. The connect action persists them before starting OAuth (see ensureSavedForConnect), so no
  // separate save/close/reopen step.
  const hasSavedOAuthEntry =
    savedIdForOAuth != null || (mode === "update" && !!initialId);
  const connectReady =
    kind === "google_oauth" &&
    nameValid &&
    (hasSavedOAuthEntry ? !partialFields : allFieldsFilled);

  // Unsaved-changes guard.
  // In post-create connect mode (google_oauth), the entry was already saved; nothing is dirty.
  useUnsavedChanges(
    !isPostCreateConnectMode &&
      (renaming ||
        hasNewValue ||
        kind !== (initialKind ?? "generic") ||
        baseUrl !== (initialBaseUrl ?? "") ||
        paramName !== (initialParamName ?? "")),
  );

  useEffect(() => {
    if (typeOpen) {
      // NOTE: rAF defers until after Radix positions the floating panel and its own focus logic runs.
      const id = requestAnimationFrame(() => typeSearchRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [typeOpen]);

  // Build the value to send for multi-field types. Sent VERBATIM, like the single-value path: the
  // server refuses a secret that begins or ends in whitespace rather than repairing it (#338), and
  // trimming here would hide that refusal from the console while the MCP surface still got it.
  function buildMultiFieldValue(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const f of fields ?? []) {
      result[f.key] = fieldValues[f.key] ?? "";
    }
    return result;
  }

  // Effective base URL for test calls: the persisted one (typed by the user in this form).
  const effectiveBaseUrl = baseUrl.trim() || null;

  // Probe the typed value (pre-save) via POST /test.
  async function probeTypedValue(): Promise<CredentialTestState> {
    try {
      const { data, error: err } = await api.api.v1.vault.test.post({
        kind,
        value,
        baseURL: secretTypeNeedsBase(kind) ? effectiveBaseUrl : null,
        paramName: needsParamName ? paramName.trim() || null : null,
      });
      const r = data as
        | { testable?: boolean; ok?: boolean; code?: string; status?: number }
        | null
        | undefined;
      if (err || !r || r.testable === false) {
        return { kind: "fail", code: "unreachable" };
      }
      return r.ok
        ? { kind: "ok" }
        : { kind: "fail", code: r.code ?? "unreachable", status: r.status };
    } catch {
      return { kind: "fail", code: "unreachable" };
    }
  }

  // Probe the stored credential by id (update mode, no new value typed).
  async function probeStoredCredential(): Promise<CredentialTestState> {
    if (!initialId) return { kind: "fail", code: "unreachable" };
    try {
      const { data, error: err } = await api.api.v1
        .vault({ id: initialId })
        .test.post({
          baseURL: secretTypeNeedsBase(kind) ? effectiveBaseUrl : null,
        });
      const r = data as
        | { testable?: boolean; ok?: boolean; code?: string; status?: number }
        | null
        | undefined;
      if (err || !r || r.testable === false) {
        return { kind: "fail", code: "unreachable" };
      }
      return r.ok
        ? { kind: "ok" }
        : { kind: "fail", code: r.code ?? "unreachable", status: r.status };
    } catch {
      return { kind: "fail", code: "unreachable" };
    }
  }

  async function testCredential() {
    setTesting(true);
    setTestResult(null);
    try {
      // In update mode without a new value, test the stored credential.
      const result =
        isUpdate && !value
          ? await probeStoredCredential()
          : await probeTypedValue();
      setTestResult(result);
    } finally {
      setTesting(false);
    }
  }

  // Whether the Test button should be enabled (multi-field types are not testable).
  const baseUrlSatisfied = !secretTypeNeedsBase(kind) || !!effectiveBaseUrl;
  const canTestTyped = !!value && baseUrlSatisfied;
  const canTestStored = isUpdate && !value && !!initialId && baseUrlSatisfied;
  const testEnabled = canTestTyped || canTestStored;

  // Apply a pasted .env to the langfuse fields (publicKey/secretKey → fieldValues, baseUrl → state).
  function onEnvChange(text: string) {
    setEnvText(text);
    setTestResult(null);
    if (!text.trim()) {
      setEnvError(false);
      return;
    }
    const parsed = parseLangfuseEnv(text);
    if (!parsed) {
      setEnvError(true);
      return;
    }
    setEnvError(false);
    setFieldValues((prev) => ({
      ...prev,
      ...(parsed.publicKey !== undefined
        ? { publicKey: parsed.publicKey }
        : {}),
      ...(parsed.secretKey !== undefined
        ? { secretKey: parsed.secretKey }
        : {}),
    }));
    if (parsed.baseUrl !== undefined) setBaseUrl(parsed.baseUrl);
  }

  const canTestLangfuse = !!(
    fieldValues.publicKey?.trim() && fieldValues.secretKey?.trim()
  );

  // Langfuse credentials are multi-field with no auto-injection, so the generic /test probe doesn't
  // cover them — they go through a dedicated endpoint that hits Langfuse's GET /api/public/projects.
  async function testLangfuse() {
    setTesting(true);
    setTestResult(null);
    try {
      const { data, error: err } = await api.api.v1[
        "tenant-settings"
      ].langfuse.test.post({
        publicKey: (fieldValues.publicKey ?? "").trim(),
        secretKey: (fieldValues.secretKey ?? "").trim(),
        baseUrl: baseUrl.trim() || null,
      });
      if (err || !data) {
        setTestResult({ kind: "fail", code: "unreachable" });
        return;
      }
      setTestResult(
        data.ok
          ? { kind: "ok" }
          : {
              kind: "fail",
              code:
                data.reason === "invalid_credentials"
                  ? "unauthorized"
                  : "unreachable",
              status: data.status,
            },
      );
    } finally {
      setTesting(false);
    }
  }

  function mapSaveError(
    status: number | undefined,
    apiMessage?: string,
  ): string {
    if (status === 409)
      return t(
        "vault.nameInUse",
        "A secret with this name and type already exists.",
      );
    if (status === 400 && apiMessage) return apiMessage;
    return t("vault.saveError", "Could not save the secret.");
  }

  async function save(skipTest = false) {
    if (!canSave) return;

    // Probe only when there is a typed plain-string value to test (rename-only updates skip the
    // probe; multi-field types are not testable).
    const needsProbe =
      !skipTest &&
      !hasFields &&
      !!value &&
      isTestableSecretType(kind) &&
      (!secretTypeNeedsBase(kind) || !!effectiveBaseUrl);

    if (needsProbe) {
      if (testResult?.kind !== "ok") {
        setTesting(true);
        setTestResult(null);
        let result: CredentialTestState;
        try {
          result = await probeTypedValue();
        } finally {
          setTesting(false);
        }
        setTestResult(result);
        if (result?.kind !== "ok") return;
      }
    }

    setSaving(true);
    try {
      if (isUpdate) {
        if (!initialId) throw new Error("missing id");
        // Build the effective value to send (only when new content is typed).
        const newValue = hasFields
          ? allFieldsFilled
            ? buildMultiFieldValue()
            : undefined
          : value || undefined;
        const { data, error: err } = await api.api.v1
          .vault({ id: initialId })
          .put({
            name: renaming ? name.trim() : undefined,
            value: newValue,
            // PUT schema: baseUrl is Optional(Nullable(String)); paramName is Optional(String).
            baseUrl: supportsBaseUrl ? baseUrl.trim() || null : undefined,
            paramName: needsParamName
              ? paramName.trim() || undefined
              : undefined,
          });
        if (err || !data) {
          const apiErr = err as {
            status?: number;
            value?: { error?: string };
          } | null;
          showToast(
            mapSaveError(apiErr?.status, apiErr?.value?.error),
            "error",
          );
          return;
        }
        showToast(t("vault.saved", "Secret saved."), "success");
        onSaved(data.ref, name.trim(), kind === "generic" ? null : kind);
      } else {
        const newValue = hasFields
          ? buildMultiFieldValue()
          : isManagedBlob
            ? {}
            : value;
        const { data, error: err } = await api.api.v1.vault.post({
          name: name.trim(),
          value: newValue,
          kind: kind === "generic" ? null : kind,
          // POST schema: baseUrl/paramName are Optional(String) — no null allowed; omit when empty.
          baseUrl: supportsBaseUrl ? baseUrl.trim() || undefined : undefined,
          paramName: needsParamName ? paramName.trim() || undefined : undefined,
        });
        if (err || !data) {
          const apiErr = err as {
            status?: number;
            value?: { error?: string };
          } | null;
          showToast(
            mapSaveError(apiErr?.status, apiErr?.value?.error),
            "error",
          );
          return;
        }
        showToast(t("vault.saved", "Secret saved."), "success");
        // google_oauth / mcp_oauth: stay open to show the connect section after create. Store the
        // payload so "Done" can call onSaved once the operator has (optionally) connected.
        if (kind === "google_oauth" || kind === "mcp_oauth") {
          savedOAuthPayloadRef.current = {
            ref: data.ref,
            name: name.trim(),
            kind,
          };
          setSavedIdForOAuth(data.id);
          // Clear field values so they don't trigger the unsaved-changes guard.
          setFieldValues({});
        } else {
          onSaved(data.ref, name.trim(), kind === "generic" ? null : kind);
        }
      }
    } catch {
      showToast(t("vault.saveError", "Could not save the secret."), "error");
    } finally {
      setSaving(false);
    }
  }

  // Persists the google_oauth credential right before the OAuth popup, so connecting is one click
  // (no save → close → reopen). Creates the entry on first connect, or saves edited Client ID/secret
  // on a saved one; returns the entry id, or null when the save fails. Does NOT call onSaved (the
  // modal stays open for the connect flow; "Done" finalizes it).
  async function ensureSavedForConnect(): Promise<string | null> {
    const existingId =
      savedIdForOAuth ?? (mode === "update" ? initialId : null);
    if (partialFields) {
      showToast(
        t(
          "vault.allFieldsRequired",
          "Fill in all fields to update the credential.",
        ),
        "error",
      );
      return null;
    }
    // Already saved and nothing new typed → connect with the stored Client ID/secret.
    if (existingId && !anyFieldFilled) return existingId;
    setSaving(true);
    try {
      if (!existingId) {
        const { data, error: err } = await api.api.v1.vault.post({
          name: name.trim(),
          value: buildMultiFieldValue(),
          kind,
          baseUrl: supportsBaseUrl ? baseUrl.trim() || undefined : undefined,
          paramName: needsParamName ? paramName.trim() || undefined : undefined,
        });
        if (err || !data) {
          const apiErr = err as {
            status?: number;
            value?: { error?: string };
          } | null;
          showToast(
            mapSaveError(apiErr?.status, apiErr?.value?.error),
            "error",
          );
          return null;
        }
        savedOAuthPayloadRef.current = {
          ref: data.ref,
          name: name.trim(),
          kind,
        };
        setSavedIdForOAuth(data.id);
        setFieldValues({});
        return data.id;
      }
      const { data, error: err } = await api.api.v1
        .vault({ id: existingId })
        .put({
          name: renaming ? name.trim() : undefined,
          value: buildMultiFieldValue(),
          baseUrl: supportsBaseUrl ? baseUrl.trim() || null : undefined,
          paramName: needsParamName ? paramName.trim() || undefined : undefined,
        });
      if (err || !data) {
        const apiErr = err as {
          status?: number;
          value?: { error?: string };
        } | null;
        showToast(mapSaveError(apiErr?.status, apiErr?.value?.error), "error");
        return null;
      }
      setFieldValues({});
      return existingId;
    } catch {
      showToast(t("vault.saveError", "Could not save the secret."), "error");
      return null;
    } finally {
      setSaving(false);
    }
  }

  const matchesTypeSearch = (id: string) => {
    if (!typeSearch) return true;
    const q = typeSearch.toLowerCase();
    return (
      id.toLowerCase().includes(q) || typeLabel(id).toLowerCase().includes(q)
    );
  };
  const serviceTypes = SECRET_TYPE_IDS.filter(
    (id) => !GENERIC_TYPE_ORDER.includes(id),
  )
    .filter(matchesTypeSearch)
    .sort((a, b) => typeLabel(a).localeCompare(typeLabel(b)));
  const genericTypes = GENERIC_TYPE_ORDER.filter(matchesTypeSearch);
  const noTypeResults = serviceTypes.length === 0 && genericTypes.length === 0;

  // The Save button label changes to "Save anyway" after a failed test — but only for a failure the
  // operator can decide to ignore. `surrounding_whitespace` is the write's own verdict, not a
  // connectivity one, so saving anyway is refused by createVaultEntry/updateVaultEntry every time:
  // offering it advertises an action that cannot succeed (#338).
  const testFailedRecoverably =
    testResult?.kind === "fail" && testResult.code !== "surrounding_whitespace";
  const saveLabel = testFailedRecoverably
    ? t("vault.saveAnyway", "Save anyway")
    : t("common.save", "Save");
  const onSaveClick = testFailedRecoverably ? () => save(true) : () => save();

  // Param-name placeholder depends on the kind.
  const paramNamePlaceholder =
    kind === "header"
      ? "X-API-Key"
      : kind === "mcp_env"
        ? "API_TOKEN"
        : "api_key";

  return (
    <div className="flex flex-col gap-4">
      <FormField
        label={t("vault.name", "Name")}
        error={
          name && !NAME_RE.test(name.trim())
            ? t("vault.invalidName", "Must be between 1 and 128 characters.")
            : null
        }
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("vault.namePlaceholder", "my-api-key")}
        />
      </FormField>
      <FormField
        label={t("vault.type", "Type")}
        group
        description={
          isUpdate
            ? t(
                "vault.typeHintLocked",
                "The type can't be changed after creation.",
              )
            : KIND_HINT_KEYS[kind]
              ? // biome-ignore lint/plugin/no-dynamic-i18n-key: hint keys registered via magic comments above
                t(KIND_HINT_KEYS[kind])
              : undefined
        }
      >
        <DropdownMenuPrimitive.Root
          open={typeOpen}
          onOpenChange={(next) => {
            setTypeOpen(next);
            // NOTE: reset on OPEN, not close — clearing on close re-renders the full list while
            // the Radix exit animation still shows the content (visible flicker).
            if (next) setTypeSearch("");
          }}
        >
          <DropdownMenuPrimitive.Trigger asChild disabled={isUpdate}>
            <button
              type="button"
              disabled={isUpdate}
              aria-label={t("vault.type", "Type")}
              className="flex w-full items-center gap-2 rounded-lg border border-border bg-bg-tertiary py-2 pr-3 pl-3 text-sm text-text-primary focus:border-border-focus focus:outline-none disabled:opacity-60"
            >
              <ServiceLogo
                service={secretTypeService(kind)}
                className="h-4 w-4 shrink-0 text-text-secondary"
              />
              <span className="flex-1 truncate text-left">
                {/* biome-ignore lint/plugin/no-dynamic-i18n-key: secret-type keys registered via magic comments above */}
                {t(`vault.secretType.${kind}`, kind)}
              </span>
              <ChevronDown
                aria-hidden="true"
                className="h-4 w-4 shrink-0 text-text-muted"
              />
            </button>
          </DropdownMenuPrimitive.Trigger>

          <DropdownMenuPrimitive.Portal>
            <DropdownMenuPrimitive.Content
              align="start"
              sideOffset={6}
              style={{
                zIndex: "calc(var(--z-modal) + 5)",
                minWidth: "var(--radix-dropdown-menu-trigger-width)",
              }}
              className="data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 max-h-72 overflow-y-auto rounded-lg border border-border bg-bg-secondary p-1 shadow-lg data-[state=closed]:animate-out data-[state=open]:animate-in"
            >
              <div className="mb-1 flex items-center gap-1.5 border-border border-b px-2 py-1.5">
                <Search
                  className="pointer-events-none h-4 w-4 shrink-0 text-text-muted"
                  aria-hidden="true"
                />
                <input
                  ref={typeSearchRef}
                  type="text"
                  value={typeSearch}
                  onChange={(e) => setTypeSearch(e.target.value)}
                  onKeyDown={(e) => {
                    // NOTE: Block typeahead for printable characters so the menu's native typeahead
                    // doesn't steal keystrokes; navigation keys pass through to keep arrow/esc working.
                    if (
                      e.key.length === 1 ||
                      e.key === "Backspace" ||
                      e.key === "Delete"
                    ) {
                      e.stopPropagation();
                    }
                  }}
                  placeholder={t(
                    "vault.searchTypePlaceholder",
                    "Search types…",
                  )}
                  aria-label={t("vault.searchTypePlaceholder", "Search types…")}
                  className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
                />
              </div>

              {(
                [
                  ["vault.typeGroupServices", serviceTypes],
                  ["vault.typeGroupGeneric", genericTypes],
                ] as const
              ).map(([groupKey, ids]) =>
                ids.length === 0 ? null : (
                  <div key={groupKey}>
                    <div className="px-2 pt-1.5 pb-0.5 font-medium text-[11px] text-text-muted uppercase tracking-wide">
                      {/* biome-ignore lint/plugin/no-dynamic-i18n-key: both group keys declared below */}
                      {t(groupKey)}
                    </div>
                    {ids.map((id) => (
                      <DropdownMenuPrimitive.Item
                        key={id}
                        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-secondary outline-none transition-colors data-[highlighted]:bg-bg-hover data-[highlighted]:text-text-primary"
                        onSelect={() => {
                          // Re-sync the name to the new provider's label only if the operator
                          // hasn't typed their own (blank or still equal to the old type's label).
                          const nameIsPristine =
                            name.trim() === "" || name === typeLabel(kind);
                          setKind(id);
                          if (nameIsPristine) setName(typeLabel(id));
                          setValue("");
                          setFieldValues({});
                          setTestResult(null);
                          setBaseUrlTouched(false);
                          setParamNameTouched(false);
                          setLangfusePaste(id === "langfuse");
                          setEnvText("");
                          setEnvError(false);
                        }}
                      >
                        <ServiceLogo
                          service={secretTypeService(id)}
                          className="h-4 w-4 shrink-0 text-text-secondary"
                        />
                        <span className="flex-1 truncate">
                          {/* biome-ignore lint/plugin/no-dynamic-i18n-key: secret-type keys registered via magic comments above */}
                          {t(`vault.secretType.${id}`, id)}
                        </span>
                        <Check
                          aria-hidden="true"
                          className={cn("h-3.5 w-3.5 shrink-0", {
                            invisible: kind !== id,
                          })}
                        />
                      </DropdownMenuPrimitive.Item>
                    ))}
                  </div>
                ),
              )}

              {typeSearch && noTypeResults && (
                <div className="px-2 py-1.5 text-sm text-text-muted">
                  {t("vault.noTypeResults", "No types match your search.")}
                </div>
              )}
            </DropdownMenuPrimitive.Content>
          </DropdownMenuPrimitive.Portal>
        </DropdownMenuPrimitive.Root>
      </FormField>

      {needsParamName && (
        <FormField
          label={
            kind === "mcp_env"
              ? t("vault.envVarName", "Environment variable name")
              : t("vault.paramName", "Parameter name")
          }
          description={
            kind === "header"
              ? t(
                  "vault.paramNameHintHeader",
                  "Name of the request header the value is injected into.",
                )
              : kind === "mcp_env"
                ? t(
                    "vault.paramNameHintEnv",
                    "Name of the environment variable the stdio MCP process reads the secret from.",
                  )
                : t(
                    "vault.paramNameHintQuery",
                    "Name of the query parameter the value is injected into.",
                  )
          }
          error={
            paramNameMissing && paramNameTouched
              ? t("vault.paramNameRequired", "Parameter name is required.")
              : null
          }
        >
          <Input
            value={paramName}
            onChange={(e) => setParamName(e.target.value)}
            onBlur={() => setParamNameTouched(true)}
            placeholder={paramNamePlaceholder}
          />
        </FormField>
      )}

      {kind === "langfuse" && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-text-muted text-xs">
            {langfusePaste
              ? t(
                  "vault.langfuseEnvHint",
                  "Paste the keys from your Langfuse .env.",
                )
              : t("vault.langfuseManualHint", "Fill each field by hand.")}
          </span>
          <button
            type="button"
            className="shrink-0 font-normal text-accent text-xs hover:underline"
            onClick={() => {
              setLangfusePaste((v) => !v);
              setEnvError(false);
            }}
          >
            {langfusePaste
              ? t("vault.langfuseManualFields", "Fill fields manually")
              : t("vault.langfusePasteEnv", "Paste .env")}
          </button>
        </div>
      )}

      {supportsBaseUrl && !langfusePaste && (
        <FormField
          label={t("vault.baseUrl", "Base URL")}
          required={requiresBaseUrl}
          description={
            kind === "langfuse"
              ? t("vault.baseUrlHintLangfuse", "Enter your Langfuse host URL.")
              : kind === "mcp_oauth"
                ? t(
                    "vault.baseUrlHintMcp",
                    "The MCP server URL. Its OAuth configuration is discovered automatically.",
                  )
                : requiresBaseUrl
                  ? undefined
                  : t(
                      "vault.baseUrlHint",
                      "Used as the base for requests and connection tests. Optional.",
                    )
          }
          error={
            baseUrlMissing && baseUrlTouched
              ? t("vault.baseUrlRequired", "Base URL is required.")
              : baseUrlInvalid && baseUrl.trim()
                ? t("common.invalidUrl", "Must be a valid http(s) URL.")
                : null
          }
        >
          <Input
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              setTestResult(null);
            }}
            onBlur={() => setBaseUrlTouched(true)}
            placeholder={
              kind === "langfuse"
                ? "https://cloud.langfuse.com"
                : kind === "mcp_oauth"
                  ? "https://servidor.exemplo.com/mcp"
                  : "https://api.exemplo.com"
            }
          />
        </FormField>
      )}

      {/* Redirect URI ABOVE the Client ID/secret fields: the operator copies it into the Google Cloud
          Console to CREATE the OAuth client, which is what produces the id + secret typed below. */}
      {kind === "google_oauth" && <GoogleRedirectUriField />}

      {!isManagedBlob &&
        (langfusePaste ? (
          // Langfuse .env paste: one textarea, parsed into the keys + base URL on change.
          <FormField
            label={t("vault.langfuseEnvLabel", "Langfuse .env")}
            error={
              envError
                ? t(
                    "vault.langfuseEnvError",
                    "Couldn't recognize the format. Expected LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL.",
                  )
                : null
            }
          >
            <Textarea
              rows={4}
              className="font-mono text-xs"
              value={envText}
              onChange={(e) => onEnvChange(e.target.value)}
              placeholder={
                'LANGFUSE_PUBLIC_KEY="pk-lf-..."\nLANGFUSE_SECRET_KEY="sk-lf-..."\nLANGFUSE_BASE_URL="https://cloud.langfuse.com"'
              }
            />
            {!envError && envText.trim() && (
              <p className="mt-1 text-text-muted text-xs">
                {t(
                  "vault.langfuseEnvOk",
                  "Keys detected. Switch to manual fields to review, or test and save.",
                )}
              </p>
            )}
          </FormField>
        ) : hasFields ? (
          // Multi-field types (e.g. langfuse): one input per field instead of the single value textarea.
          <div className="flex flex-col gap-4">
            {fields?.map((f) => (
              <FormField
                key={f.key}
                label={
                  // biome-ignore lint/plugin/no-dynamic-i18n-key: field keys registered via magic comments below
                  t(`vault.field.${f.key}`, f.key)
                }
                description={
                  isUpdate
                    ? t(
                        "vault.valueHintUpdate",
                        "Leave blank to keep the current value.",
                      )
                    : t(
                        "vault.valueHint",
                        "Stored encrypted and never shown again.",
                      )
                }
              >
                {f.masked ? (
                  <Input
                    type="password"
                    showPasswordToggle
                    placeholder={isUpdate ? "••••••••" : undefined}
                    value={fieldValues[f.key] ?? ""}
                    onChange={(e) => {
                      setFieldValues({
                        ...fieldValues,
                        [f.key]: e.target.value,
                      });
                      setTestResult(null);
                    }}
                  />
                ) : (
                  <Input
                    placeholder={isUpdate ? "••••••••" : undefined}
                    value={fieldValues[f.key] ?? ""}
                    onChange={(e) => {
                      setFieldValues({
                        ...fieldValues,
                        [f.key]: e.target.value,
                      });
                      setTestResult(null);
                    }}
                  />
                )}
              </FormField>
            ))}
            {partialFields && (
              <p className="text-error text-xs">
                {t(
                  "vault.allFieldsRequired",
                  "Fill in all fields to update the credential.",
                )}
              </p>
            )}
          </div>
        ) : (
          // Plain string value for all other types.
          <FormField
            label={t("vault.value", "Value")}
            description={
              isUpdate
                ? t(
                    "vault.valueHintUpdate",
                    "Leave blank to keep the current value.",
                  )
                : t(
                    "vault.valueHint",
                    "Stored encrypted and never shown again.",
                  )
            }
          >
            <Input
              type="password"
              showPasswordToggle
              placeholder={isUpdate ? "••••••••" : undefined}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setTestResult(null);
              }}
            />
          </FormField>
        ))}

      {provLink &&
        (provLink.kind === "affiliate" ? (
          <p className="text-text-muted text-xs">
            {t(
              "vault.affiliatePrompt",
              "Don't have an {{service}} account yet?",
              {
                service: typeLabel(kind),
              },
            )}{" "}
            <a
              href={provLink.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-accent hover:underline"
            >
              {t(
                "vault.affiliateCreate",
                "Create one through our link to help us out",
              )}
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          </p>
        ) : (
          <p className="text-text-muted text-xs">
            {t("vault.getKeyPrompt", "Need an API key?")}{" "}
            <a
              href={provLink.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-accent hover:underline"
            >
              {t("vault.getKeyLink", "Get yours at {{service}}", {
                service: typeLabel(kind),
              })}
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          </p>
        ))}

      {/* Test block: only for testable plain-string types (multi-field types like langfuse are not
          testable). The base URL field for needsBase types is now the persistent baseUrl above. */}
      {!hasFields && isTestableSecretType(kind) && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={testCredential}
              loading={testing}
              disabled={!testEnabled}
            >
              <PlugZap className="h-4 w-4" aria-hidden="true" />
              {t("vault.test", "Test connection")}
            </Button>
            <CredentialTestResult result={testResult} />
          </div>
        </div>
      )}

      {/* Langfuse test: multi-field, so it uses a dedicated endpoint (the generic /test doesn't cover
          it). Works in both paste and manual mode — both populate publicKey/secretKey + base URL. */}
      {kind === "langfuse" && (
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={testLangfuse}
            loading={testing}
            disabled={!canTestLangfuse}
          >
            <PlugZap className="h-4 w-4" aria-hidden="true" />
            {t("vault.test", "Test connection")}
          </Button>
          <CredentialTestResult result={testResult} />
        </div>
      )}

      {/* Google OAuth connect section — shown for google_oauth in create AND update. Connecting saves
          the credential first (ensureSavedForConnect), so there's no save → close → reopen step. */}
      {kind === "google_oauth" && (
        <GoogleOAuthSection
          entryId={savedIdForOAuth ?? initialId ?? null}
          canConnect={connectReady}
          onEnsureSaved={ensureSavedForConnect}
        />
      )}

      {/* MCP OAuth connect section — shown in update mode (or after a successful create). */}
      {kind === "mcp_oauth" &&
        (savedIdForOAuth !== null || (isUpdate && !!initialId)) && (
          <McpOAuthSection entryId={(savedIdForOAuth ?? initialId) as string} />
        )}

      {savedIdForOAuth !== null ? (
        // Post-create connect mode: "Done" fires onSaved; "Cancel" also fires onSaved so the caller
        // refreshes the list (entry was already created).
        <div className="flex justify-end gap-2">
          <Button
            onClick={() => {
              const p = savedOAuthPayloadRef.current;
              if (p) onSaved(p.ref, p.name, p.kind);
            }}
          >
            {t("common.done", "Done")}
          </Button>
        </div>
      ) : (
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={onCancel}
            disabled={testing || saving}
          >
            {t("common.cancel", "Cancel")}
          </Button>
          <Button
            onClick={onSaveClick}
            loading={testing || saving}
            disabled={!canSave || testing || saving}
          >
            {saveLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

// Magic comments for multi-field key labels (used via dynamic t() calls above).
// t('vault.field.publicKey', 'Public key')
// t('vault.field.secretKey', 'Secret key')
// t('vault.field.clientId', 'Client ID')
// t('vault.field.clientSecret', 'Client secret')
