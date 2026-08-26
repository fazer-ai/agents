import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/client/components/Button";
import { CredentialPicker } from "@/client/components/CredentialPicker";
import { FormField } from "@/client/components/FormField";
import { Input } from "@/client/components/Input";
import {
  Modal,
  ModalCancelButton,
  type ModalController,
  useOnModalOpen,
} from "@/client/components/Modal";
import { Switch } from "@/client/components/Switch";
import { useFieldRefusal } from "@/client/hooks/useFieldRefusal";
import { api } from "@/client/lib/api";
import { cn } from "@/client/lib/utils";
import { isValidHttpUrl } from "@/client/lib/validation";
import { webhookEventLabel } from "@/client/lib/webhookEvents";

// Create/edit modal for an outbound webhook subscription. `events` is a checkbox group over the
// closed OUTBOUND_EVENTS set (passed in, fetched once by the page). `secretRef` is the NAME of a
// vault entry (never a raw secret), chosen via the shared CredentialPicker.

type SubscriptionsResponse = Awaited<
  ReturnType<typeof api.api.v1.webhooks.subscriptions.get>
>["data"];
export type WebhookSubscription =
  NonNullable<SubscriptionsResponse>["subscriptions"][number];

const labelCls = "mb-1 block font-medium text-sm text-text-primary";

export interface WebhookModalPayload {
  // Present when editing; absent when creating.
  subscription?: WebhookSubscription;
}

// The keys of the body this modal writes: the route refuses by them (`refused body.url`) and
// `requireVaultRef` names `secretRef`.
const WEBHOOK_FIELDS = ["url", "events", "secretRef"] as const;

export function WebhookSubscriptionModal({
  modal,
  events,
  onSaved,
}: {
  modal: ModalController<WebhookModalPayload>;
  events: readonly string[];
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const refusal = useFieldRefusal(modal.isOpen ? WEBHOOK_FIELDS : []);
  const enabledId = useId();
  const editing = modal.payload?.subscription;
  const [url, setUrl] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [secretRef, setSecretRef] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useOnModalOpen(modal, () => {
    // The component outlives the dialog, so a mark from the last session is still held here.
    refusal.clear();
    const sub = modal.payload?.subscription;
    setUrl(sub?.url ?? "");
    setSelected(new Set(sub?.events ?? []));
    setSecretRef(sub?.secretRef ?? "");
    setEnabled(sub?.enabled ?? true);
    setError("");
  });

  // What the inputs hold right now, in the server's vocabulary, and what the write sends. One
  // expression, because a refusal is matched against the value that was SENT.
  const current = {
    url,
    events: [...selected],
    secretRef: secretRef.trim() || null,
    enabled,
  };
  const currentRef = useRef(current);
  currentRef.current = current;

  const toggleEvent = (ev: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ev)) next.delete(ev);
      else next.add(ev);
      return next;
    });
  };

  const handleSubmit = async () => {
    setError("");
    setLoading(true);
    const body = { ...current };
    const held = (e: unknown) =>
      refusal.capture(
        e,
        t("webhooks.saveFailed", "Could not save the subscription"),
        body,
        currentRef.current,
      ) ?? "";
    try {
      const apiError = editing
        ? (
            await api.api.v1.webhooks
              .subscriptions({ id: editing.id })
              .patch(body)
          ).error
        : (await api.api.v1.webhooks.subscriptions.post(body)).error;
      if (apiError) {
        setError(held(apiError));
        return;
      }
      refusal.clear();
      onSaved();
      modal.close();
    } catch (e) {
      setError(held(e));
    } finally {
      setLoading(false);
    }
  };

  const urlInvalid = !isValidHttpUrl(url);
  const canSubmit = url.trim().length > 0 && !urlInvalid && selected.size > 0;

  // NOTE: dirty = any editable field diverges from its baseline (loaded subscription when editing,
  // empty/defaults when creating). `error`/`loading` are ephemeral and excluded.
  const baseUrl = editing?.url ?? "";
  const baseEvents = new Set<string>(editing?.events ?? []);
  const baseSecretRef = editing?.secretRef ?? "";
  const baseEnabled = editing?.enabled ?? true;
  const eventsEqual =
    selected.size === baseEvents.size &&
    [...selected].every((ev) => baseEvents.has(ev));
  const isDirty =
    url !== baseUrl ||
    !eventsEqual ||
    secretRef !== baseSecretRef ||
    enabled !== baseEnabled;

  return (
    <Modal
      modal={modal}
      size="md"
      unsavedChanges={isDirty}
      title={
        editing
          ? t("webhooks.editTitle", "Edit subscription")
          : t("webhooks.createTitle", "New subscription")
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!loading && canSubmit) void handleSubmit();
        }}
      >
        {error && (
          <div className="rounded-lg border border-error bg-error-soft px-4 py-2 text-error text-sm">
            {error}
          </div>
        )}

        <div>
          <label htmlFor="wh-url" className={labelCls}>
            {t("webhooks.url", "Endpoint URL")}
          </label>
          <Input
            id="wh-url"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
            disabled={loading}
            placeholder="https://example.com/hooks/agents"
            helperText={t(
              "webhooks.urlHint",
              "Must be a public HTTPS URL. Private and metadata addresses are blocked.",
            )}
          />
          {urlInvalid && url.trim() ? (
            <p className="mt-1 text-error text-xs">
              {t("common.invalidUrl", "Must be a valid http(s) URL.")}
            </p>
          ) : (
            refusal.at("url", current.url) && (
              <p className="mt-1 text-error text-xs">
                {refusal.at("url", current.url)}
              </p>
            )
          )}
        </div>

        <fieldset>
          <legend className={labelCls}>{t("webhooks.events", "Events")}</legend>
          {refusal.at("events", current.events) && (
            <p className="mb-1 text-error text-xs">
              {refusal.at("events", current.events)}
            </p>
          )}
          <div className="flex flex-col gap-1">
            {events.map((ev) => {
              const checked = selected.has(ev);
              return (
                <label
                  key={ev}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors",
                    {
                      "border-accent bg-accent-soft text-text-primary": checked,
                      "border-border text-text-secondary hover:bg-bg-hover":
                        !checked,
                    },
                  )}
                >
                  <input
                    type="checkbox"
                    className="accent-accent"
                    checked={checked}
                    disabled={loading}
                    onChange={() => toggleEvent(ev)}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm">{webhookEventLabel(ev, t)}</span>
                    <span className="font-mono text-text-muted text-xs">
                      {ev}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <FormField
          label={t("webhooks.secretRef", "Signing secret (optional)")}
          group
          description={t(
            "webhooks.secretRefHint",
            "Signs each delivery (HMAC) so your endpoint can verify it. Leave blank for unsigned.",
          )}
          error={refusal.at("secretRef", current.secretRef)}
        >
          <CredentialPicker
            value={secretRef}
            onChange={setSecretRef}
            disabled={loading}
            ariaLabel={t("webhooks.secretRef", "Signing secret (optional)")}
          />
        </FormField>

        <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
          <label
            htmlFor={enabledId}
            data-clickable={loading ? undefined : "true"}
            className="font-medium text-sm text-text-primary"
          >
            {t("webhooks.enabled", "Enabled")}
          </label>
          <Switch
            id={enabledId}
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={loading}
          />
        </div>

        <div className="flex justify-end gap-2">
          <ModalCancelButton disabled={loading} />
          <Button
            type="submit"
            loading={loading}
            disabled={loading || !canSubmit}
          >
            {t("common.save", "Save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
