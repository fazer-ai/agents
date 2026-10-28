import { KeyRound, Pencil, Trash2 } from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  ConfirmDialog,
  type ConfirmPayload,
  DataBoundary,
  FormField,
  GoogleSignInButton,
  Input,
  Modal,
  ModalCancelButton,
  type ModalController,
  useModalController,
  useOnModalOpen,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import {
  PasskeyAlreadyRegistered,
  PasskeyCancelled,
  passkeysSupported,
  registerPasskey,
} from "@/client/lib/passkey";
import { PASSKEYS_CHANGED_EVENT } from "@/client/lib/passkeyOffer";
import type { ApiErrorPayload } from "@/client/lib/types";
import { formatDateTime } from "@/client/lib/utils";
import { SettingsRow, SettingsSection } from "./SettingsSection";

type Passkey = NonNullable<
  Awaited<ReturnType<typeof api.api.auth.passkeys.get>>["data"]
>["passkeys"][number];

// Kept in step with PASSKEY_NAME_MAX_LENGTH on the server.
const NAME_MAX_LENGTH = 100;

type RenamePayload = { id: string; name: string | null; label: string };

// Adding a passkey asks for the credential the account already has, so
// a stolen session cannot plant one that outlives a password change: the
// current password, or, for an account without one, a fresh Google sign-in.
function AddPasskeyModal({
  modal,
  hasPassword,
  googleClientId,
  onAdded,
}: {
  modal: ModalController<void>;
  hasPassword: boolean;
  googleClientId: string | null;
  onAdded: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [googleCredential, setGoogleCredential] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  // `saving` stays set after a success, through the exit animation
  // (docs/modals.md); the ref closes the gap before React commits it.
  const submittingRef = useRef(false);

  useOnModalOpen(modal, () => {
    submittingRef.current = false;
    setName("");
    setPassword("");
    setGoogleCredential(null);
    setError("");
    setSaving(false);
  });

  const useGoogle = !hasPassword;
  const canSubmit = useGoogle ? !!googleCredential : password.length > 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setSaving(true);
    setError("");
    let done = false;
    try {
      await registerPasskey(
        useGoogle
          ? { googleCredential: googleCredential ?? undefined }
          : { password },
        name.trim() || undefined,
      );
      done = true;
      onAdded();
      modal.close();
    } catch (e) {
      // NOTE: closing the browser's dialog is not an error; the modal stays
      // open for another try.
      if (e instanceof PasskeyCancelled) return;
      if (e instanceof PasskeyAlreadyRegistered) {
        setError(
          t(
            "settings.passkeyAlreadyRegistered",
            "This device already has a passkey for this account. To add another, use another device or password manager.",
          ),
        );
        return;
      }
      // NOTE: a Google credential is spent by the failed proof; the button
      // has to be used again.
      if (useGoogle) setGoogleCredential(null);
      setError(
        apiErrorMessage(e) ||
          t(
            "settings.passkeyAddFailed",
            "The browser could not create the passkey. Try again; if it keeps failing, try another browser.",
          ),
      );
    } finally {
      if (!done) {
        submittingRef.current = false;
        setSaving(false);
      }
    }
  };

  return (
    <Modal
      modal={modal}
      title={t("settings.passkeyAddTitle", "Add a passkey")}
      description={
        useGoogle
          ? t(
              "settings.passkeyAddGoogleDescription",
              "Sign in with Google again to confirm it is you, then your browser asks for your fingerprint, face or device PIN.",
            )
          : t(
              "settings.passkeyAddPasswordDescription",
              "Enter your password to confirm it is you, then your browser asks for your fingerprint, face or device PIN.",
            )
      }
      busy={saving}
      unsavedChanges={name !== "" || password !== "" || !!googleCredential}
      footer={
        <div className="flex justify-end gap-2">
          <ModalCancelButton disabled={saving} />
          <Button
            size="sm"
            type="submit"
            form="passkey-add"
            loading={saving}
            disabled={!canSubmit}
          >
            {t("settings.passkeyCreate", "Create passkey")}
          </Button>
        </div>
      }
    >
      <form id="passkey-add" onSubmit={submit} className="space-y-4">
        <FormField label={t("settings.passkeyName", "Passkey name")}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={NAME_MAX_LENGTH}
            disabled={saving}
            placeholder={t(
              "settings.passkeyNamePlaceholder",
              "Name (optional)",
            )}
          />
        </FormField>
        {useGoogle ? (
          googleClientId ? (
            <div className="space-y-2">
              {googleCredential ? (
                <p role="status" className="text-success text-sm">
                  {t(
                    "settings.passkeyGoogleConfirmed",
                    "Google confirmed it is you. Create the passkey to continue.",
                  )}
                </p>
              ) : (
                <GoogleSignInButton
                  clientId={googleClientId}
                  onCredential={setGoogleCredential}
                  disabled={saving}
                  onError={() =>
                    setError(
                      t("auth.googleSignInFailed", "Google sign-in failed"),
                    )
                  }
                />
              )}
              {error && (
                <p role="alert" className="text-error text-sm">
                  {error}
                </p>
              )}
            </div>
          ) : (
            <p className="text-text-muted text-sm">
              {t(
                "settings.passkeyGoogleUnavailable",
                "Google sign-in is not available here, so there is no way to confirm it is you. Ask the administrator.",
              )}
            </p>
          )
        ) : (
          <FormField
            label={t("settings.currentPassword", "Current password")}
            error={error || null}
            required
          >
            <Input
              type="password"
              showPasswordToggle
              autoComplete="current-password"
              value={password}
              disabled={saving}
              onChange={(e) => {
                setPassword(e.target.value);
                setError("");
              }}
            />
          </FormField>
        )}
      </form>
    </Modal>
  );
}

function RenamePasskeyModal({
  modal,
  onRenamed,
}: {
  modal: ModalController<RenamePayload>;
  onRenamed: (id: string, name: string | null) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  // `saving` stays set after a success, through the exit animation,
  // so a second Save cannot run (docs/modals.md); the ref closes the gap
  // before React commits the state.
  const submittingRef = useRef(false);

  useOnModalOpen(modal, () => {
    submittingRef.current = false;
    setName(modal.payload?.name ?? "");
    setError("");
    setSaving(false);
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const target = modal.payload;
    if (!target || submittingRef.current) return;
    submittingRef.current = true;
    setSaving(true);
    setError("");
    const next = name.trim() || null;
    let done = false;
    try {
      const { error: apiError } = await api.api.auth
        .passkeys({ passkeyId: target.id })
        .patch({ name: next });
      if (apiError) {
        setError(
          (apiError.value as ApiErrorPayload | null)?.error ||
            t("settings.passkeyRenameFailed", "Could not rename the passkey."),
        );
        return;
      }
      done = true;
      onRenamed(target.id, next);
      modal.close();
    } catch {
      setError(
        t("settings.passkeyRenameFailed", "Could not rename the passkey."),
      );
    } finally {
      if (!done) {
        submittingRef.current = false;
        setSaving(false);
      }
    }
  };

  return (
    <Modal
      modal={modal}
      title={t("settings.passkeyRenameTitle", "Rename passkey")}
      description={t(
        "settings.passkeyRenameDescription",
        "A name you will recognize in this list. Leave it empty to show where the passkey is kept.",
      )}
      busy={saving}
      unsavedChanges={name !== (modal.payload?.name ?? "")}
      footer={
        <div className="flex justify-end gap-2">
          <ModalCancelButton disabled={saving} />
          <Button
            size="sm"
            type="submit"
            form="passkey-rename"
            loading={saving}
          >
            {t("common.save", "Save")}
          </Button>
        </div>
      }
    >
      <form id="passkey-rename" onSubmit={submit}>
        <FormField
          label={t("settings.passkeyName", "Passkey name")}
          error={error || null}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={NAME_MAX_LENGTH}
            // NOTE: locked while the save runs; its success closes the
            // dialog, which would drop anything typed meanwhile.
            disabled={saving}
            placeholder={modal.payload?.label}
          />
        </FormField>
      </form>
    </Modal>
  );
}

export function SecurityPasskeysSection({
  hasPassword,
  googleClientId,
  otherWayIn,
  onCountChange,
}: {
  hasPassword: boolean;
  googleClientId: string | null;
  // NOTE: a password, or a Google identity this deployment still signs in.
  otherWayIn: boolean;
  onCountChange: (count: number | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const confirm = useModalController<ConfirmPayload>();
  const rename = useModalController<RenamePayload>();
  const addModal = useModalController();
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [supported] = useState(passkeysSupported);

  // only the latest read writes the state: a slow initial read must
  // not land after an add and drop the new passkey from the list.
  const readRef = useRef(0);
  const load = useCallback(async () => {
    const read = ++readRef.current;
    const latest = () => read === readRef.current;
    setLoading(true);
    try {
      const { data, error } = await api.api.auth.passkeys.get();
      if (!latest()) return;
      if (error || !data) {
        setErrorStatus(error?.status ?? 0);
        return;
      }
      setErrorStatus(null);
      setPasskeys(data.passkeys);
    } catch {
      if (latest()) setErrorStatus(0);
    } finally {
      if (latest()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // NOTE: a passkey made by the offer after sign-in, or by the browser's
  // silent upgrade, while this list is on screen.
  useEffect(() => {
    const reload = () => void load();
    window.addEventListener(PASSKEYS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(PASSKEYS_CHANGED_EVENT, reload);
  }, [load]);

  useEffect(() => {
    onCountChange(loading || errorStatus !== null ? null : passkeys.length);
  }, [onCountChange, loading, errorStatus, passkeys.length]);

  // the server refuses to remove the last way in; the button says so
  // before anyone tries.
  const isLastWayIn = !otherWayIn && passkeys.length <= 1;

  const unnamed = t("settings.passkeyUnnamed", "Passkey");
  const labelOf = (p: Passkey) =>
    p.name ??
    t("settings.passkeyDefaultLabel", "{{provider}}, added {{date}}", {
      provider: p.provider ?? unnamed,
      date: formatDateTime(p.createdAt, i18n.language),
    });

  const added = () => {
    showToast(t("settings.passkeyAdded", "Passkey added."), "success");
    // NOTE: the passkey is saved; a failure to reload the list shows in the
    // DataBoundary, not as a failed add. registerPasskey announced it too,
    // which reloads the list again and closes an open offer card.
    void load();
  };

  const remove = (p: Passkey) => {
    const label = labelOf(p);
    confirm.open({
      title: t("settings.passkeyRemoveTitle", "Remove passkey?"),
      message: t(
        "settings.passkeyRemoveMessage",
        "{{name}} will no longer sign in to this account.",
        { name: label },
      ),
      confirmLabel: t("settings.passkeyRemove", "Remove"),
      danger: true,
      onConfirm: async () => {
        const { error } = await api.api.auth
          .passkeys({ passkeyId: p.id })
          .delete()
          .catch(() => ({ error: { status: 0, value: null } }));
        // NOTE: a 404 is a passkey already removed (in another tab): the list
        // catches up instead of reporting a failure.
        if (error && error.status !== 404) {
          const message =
            apiErrorMessage(error) ||
            t("settings.passkeyRemoveFailed", "Could not remove the passkey.");
          // NOTE: the dialog stays open on a throw; the toast says why.
          showToast(message, "error");
          throw new Error(message);
        }
        setPasskeys((current) => current.filter((x) => x.id !== p.id));
        showToast(
          t("settings.passkeyRemoved", "{{name}} removed.", { name: label }),
          "success",
        );
        // NOTE: a pending read (an add's reload) would bring the removed
        // passkey back; a new read supersedes it.
        void load();
      },
    });
  };

  return (
    <>
      {/* No <form> around the section: the modals' forms are portaled
        out of the DOM but not out of React's tree, so their submit would
        bubble into an outer form's onSubmit. */}
      <SettingsSection
        title={t("settings.passkeys", "Passkeys")}
        description={t(
          "settings.passkeysDescription",
          "Sign in with your fingerprint, face or device PIN instead of a password.",
        )}
        footer={
          supported ? (
            <Button onClick={() => addModal.open()}>
              <KeyRound className="size-4" aria-hidden />
              {t("settings.passkeyAdd", "Add passkey")}
            </Button>
          ) : undefined
        }
      >
        <DataBoundary
          loading={loading}
          error={errorStatus !== null}
          errorStatus={errorStatus ?? undefined}
          errorLabel={t(
            "settings.passkeysLoadError",
            "Could not load your passkeys.",
          )}
          onRetry={() => void load()}
          isEmpty={passkeys.length === 0}
          empty={
            <SettingsRow
              label={t("settings.passkeysEmpty", "No passkeys yet")}
              description={
                supported
                  ? t(
                      "settings.passkeysEmptyHint",
                      "Add one to sign in without typing a password.",
                    )
                  : t(
                      "settings.passkeysUnsupported",
                      "This browser does not support passkeys.",
                    )
              }
            />
          }
        >
          {passkeys.map((p) => {
            const label = labelOf(p);
            const created = formatDateTime(p.createdAt, i18n.language);
            return (
              <SettingsRow
                key={p.id}
                label={label}
                description={
                  <>
                    {/* An unnamed passkey already shows its provider in the label. */}
                    {p.name && p.provider && (
                      <span className="block">{p.provider}</span>
                    )}
                    {p.lastUsedAt
                      ? t(
                          "settings.passkeyMetaUsed",
                          "Added {{created}}, last used {{used}}",
                          {
                            created,
                            used: formatDateTime(p.lastUsedAt, i18n.language),
                          },
                        )
                      : t(
                          "settings.passkeyMeta",
                          "Added {{created}}, never used",
                          { created },
                        )}
                    {isLastWayIn && (
                      <span className="block">
                        {t(
                          "settings.passkeyLastWayIn",
                          "This is the only way into your account right now, so it cannot be removed until you add another.",
                        )}
                      </span>
                    )}
                  </>
                }
              >
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    aria-label={t(
                      "settings.passkeyRenameNamed",
                      "Rename {{name}}",
                      { name: label },
                    )}
                    onClick={() =>
                      rename.open({ id: p.id, name: p.name, label })
                    }
                  >
                    <Pencil className="size-4" aria-hidden />
                    {t("settings.passkeyRename", "Rename")}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={isLastWayIn}
                    aria-label={t(
                      "settings.passkeyRemoveNamed",
                      "Remove {{name}}",
                      { name: label },
                    )}
                    onClick={() => remove(p)}
                  >
                    <Trash2 className="size-4" aria-hidden />
                    {t("settings.passkeyRemove", "Remove")}
                  </Button>
                </div>
              </SettingsRow>
            );
          })}
        </DataBoundary>
      </SettingsSection>
      <ConfirmDialog modal={confirm} />
      <AddPasskeyModal
        modal={addModal}
        hasPassword={hasPassword}
        googleClientId={googleClientId}
        onAdded={added}
      />
      <RenamePasskeyModal
        modal={rename}
        onRenamed={(id, next) =>
          setPasskeys((current) =>
            current.map((p) => (p.id === id ? { ...p, name: next } : p)),
          )
        }
      />
    </>
  );
}
