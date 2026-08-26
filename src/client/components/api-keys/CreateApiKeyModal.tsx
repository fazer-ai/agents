import { Check, Copy } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  FormField,
  Input,
  Modal,
  type ModalController,
  useOnModalOpen,
} from "@/client/components";
import { useFieldRefusal } from "@/client/hooks/useFieldRefusal";
import { api } from "@/client/lib/api";

// The one name this modal sends, spelled the way the route refuses it (`refused body.displayName`).
const API_KEY_FIELDS = ["displayName"] as const;

// Modal to create a per-tenant API key. On success it reveals the plaintext token ONCE
// (copy-to-clipboard + a "shown only once" warning); the token is never retrievable again — only its
// hash is stored. `onCreated` refreshes the list.
export function CreateApiKeyModal({
  modal,
  onCreated,
}: {
  modal: ModalController;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const refusal = useFieldRefusal(modal.isOpen ? API_KEY_FIELDS : []);
  // The CURRENT value, readable from inside a request that started before it: the operator can type
  // while the create is out, and a refusal about a name they have already replaced belongs in the
  // banner rather than under a box that no longer holds it.
  const nameRef = useRef(displayName);
  nameRef.current = displayName;

  useOnModalOpen(modal, () => {
    // The component outlives the dialog, so a mark from the last session is still held here.
    refusal.clear();
    setDisplayName("");
    setToken(null);
    setCopied(false);
    setError("");
  });

  // Once the token is revealed the work is saved → the form is no longer dirty.
  const isDirty = !token && displayName.trim() !== "";

  const submit = async () => {
    setError("");
    setLoading(true);
    const sent = { displayName: displayName.trim() };
    const held = (e: unknown) =>
      refusal.capture(
        e,
        t("apiKeys.createFailed", "Could not create the API key"),
        sent,
        { displayName: nameRef.current.trim() },
      );
    try {
      const { data, error: apiError } = await api.api.v1["api-keys"].post(sent);
      if (apiError || !data) {
        setError(held(apiError) ?? "");
        return;
      }
      refusal.clear();
      setToken(data.token);
      onCreated();
    } catch (e) {
      setError(held(e) ?? "");
    } finally {
      setLoading(false);
    }
  };

  const copyToken = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      // Clipboard may be unavailable (insecure context); the token stays selectable.
    }
  };

  return (
    <Modal
      modal={modal}
      title={t("apiKeys.createTitle", "New API key")}
      size="md"
      unsavedChanges={isDirty}
    >
      {token ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-warning bg-warning-soft px-3 py-2 text-text-primary text-xs">
            {t(
              "apiKeys.tokenWarning",
              "Copy this key now. For security it is shown only once and cannot be retrieved again.",
            )}
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-lg border border-border bg-bg-tertiary px-3 py-2 font-mono text-text-primary text-xs">
              {token}
            </code>
            <Button size="sm" variant="secondary" onClick={copyToken}>
              {copied ? (
                <Check className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Copy className="h-4 w-4" aria-hidden="true" />
              )}
              {copied ? t("common.copied", "Copied") : t("common.copy", "Copy")}
            </Button>
          </div>
          <div className="flex justify-end">
            <Button onClick={modal.close}>{t("common.done", "Done")}</Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!loading && displayName.trim()) void submit();
          }}
        >
          {error && (
            <div className="rounded-lg border border-error bg-error-soft px-4 py-2 text-error text-sm">
              {error}
            </div>
          )}
          <FormField
            label={t("apiKeys.name", "Name")}
            required
            description={t(
              "apiKeys.nameHint",
              "A label to recognize this key later (e.g. the client or service that uses it).",
            )}
            error={refusal.at("displayName", displayName.trim())}
          >
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={loading}
              placeholder={t("apiKeys.namePlaceholder", "External integration")}
            />
          </FormField>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={modal.close}
              disabled={loading}
            >
              {t("common.cancel", "Cancel")}
            </Button>
            <Button
              type="submit"
              loading={loading}
              disabled={loading || !displayName.trim()}
            >
              {t("apiKeys.create", "Create key")}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
