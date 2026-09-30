import { type FormEvent, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Badge, Button, Input, useToast } from "@/client/components";
import { useAuth } from "@/client/contexts/AuthContext";
import {
  useConfirmLeave,
  useNavGuard,
} from "@/client/contexts/NavGuardContext";
import {
  type FieldRefusal,
  useFieldRefusal,
} from "@/client/hooks/useFieldRefusal";
import { api } from "@/client/lib/api";
import { afterLogout } from "@/client/lib/logout";
import { SettingsRow, SettingsSection } from "./SettingsSection";

const MIN_PASSWORD_LENGTH = 8;

// The two keys this form patches. A wrong current password is refused by name, which is the whole
// difference between "could not change the password" and a mark on the box that is wrong.
const PASSWORD_FIELDS = ["currentPassword", "newPassword"] as const;

function PasswordForm({ refusal }: { refusal: FieldRefusal }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const currentId = useId();
  const nextId = useId();
  const confirmId = useId();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);

  const sentRef = useRef({ currentPassword: current, newPassword: next });
  sentRef.current = { currentPassword: current, newPassword: next };

  useNavGuard(!!(current || next || confirm) && !saving);

  const tooShort = next.length > 0 && next.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== next;
  const canSubmit =
    !!current && next.length >= MIN_PASSWORD_LENGTH && confirm === next;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!canSubmit || saving) return;
    setSaving(true);
    const sent = { currentPassword: current, newPassword: next };
    // A refusal about one of the two boxes lands on it; anything else (409 when another request
    // changed the password first, whose sentence says to sign in again) is the toast.
    const held = (e: unknown) =>
      refusal.capture(
        e,
        t("settings.passwordChangeError", "Could not change the password."),
        sent,
        sentRef.current,
      );
    try {
      const { error } = await api.api.auth.password.patch(sent);
      if (error) throw error;
      refusal.clear();
      setCurrent("");
      setNext("");
      setConfirm("");
      setSubmitted(false);
      showToast(
        t(
          "settings.passwordChanged",
          "Password changed. Other sessions were signed out.",
        ),
        "success",
      );
    } catch (e) {
      const toast = held(e);
      if (toast) showToast(toast, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      <SettingsSection
        title={t("settings.password", "Password")}
        description={t(
          "settings.passwordDescription",
          "Changing it signs you out of every other session and device.",
        )}
        footer={
          <Button type="submit" loading={saving} disabled={!canSubmit}>
            {t("settings.changePassword", "Change password")}
          </Button>
        }
      >
        <SettingsRow
          label={
            <label htmlFor={currentId}>
              {t("settings.currentPassword", "Current password")}
            </label>
          }
        >
          <div className="@lg:w-64">
            <Input
              id={currentId}
              type="password"
              showPasswordToggle
              // NOTE: locked while the change is in flight; its success clears the form, which would
              // drop anything typed meanwhile.
              disabled={saving}
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              errorMessage={refusal.at("currentPassword", current) ?? undefined}
            />
          </div>
        </SettingsRow>
        <SettingsRow
          label={
            <label htmlFor={nextId}>
              {t("settings.newPassword", "New password")}
            </label>
          }
          description={t("settings.newPasswordHint", "At least 8 characters.")}
        >
          <div className="@lg:w-64">
            <Input
              id={nextId}
              type="password"
              showPasswordToggle
              disabled={saving}
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              errorMessage={
                refusal.at("newPassword", next) ??
                (tooShort && submitted
                  ? t(
                      "settings.newPasswordTooShort",
                      "Use at least 8 characters.",
                    )
                  : undefined)
              }
            />
          </div>
        </SettingsRow>
        <SettingsRow
          label={
            <label htmlFor={confirmId}>
              {t("settings.confirmNewPassword", "Confirm new password")}
            </label>
          }
        >
          <div className="@lg:w-64">
            <Input
              id={confirmId}
              type="password"
              showPasswordToggle
              disabled={saving}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              errorMessage={
                mismatch
                  ? t("auth.passwordsNoMatch", "Passwords do not match")
                  : undefined
              }
            />
          </div>
        </SettingsRow>
      </SettingsSection>
    </form>
  );
}

export function SettingsSecurityPage() {
  const { t } = useTranslation();
  const { user, providers, logout } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  // Signing out right next to a half-filled password form asks first.
  const confirmLeave = useConfirmLeave();
  // Only a /me answer says the account has no local password; until the refresh after a login
  // lands the field is absent, and the form stays usable (the endpoint refuses a Google-only
  // account with a clear sentence).
  const hasPassword = user?.hasPassword !== false;
  const refusal = useFieldRefusal(hasPassword ? PASSWORD_FIELDS : []);

  if (!user) return null;
  const googleAvailable = !!providers.google || !!user.googleLinked;

  const signOut = async () =>
    afterLogout(
      await logout(),
      () => navigate("/login"),
      () =>
        showToast(
          t("auth.logoutFailed", "Could not sign you out. Please try again."),
          "error",
        ),
    );

  return (
    <>
      {hasPassword ? (
        <PasswordForm refusal={refusal} />
      ) : (
        <SettingsSection title={t("settings.password", "Password")}>
          <SettingsRow
            label={t("settings.noPassword", "No password set")}
            description={t(
              "settings.noPasswordHint",
              "You sign in with Google, so there is no password to change. Your Google account's security settings protect this account.",
            )}
          />
        </SettingsSection>
      )}

      <SettingsSection
        title={t("settings.signInMethods", "Sign-in methods")}
        description={t(
          "settings.signInMethodsDescription",
          "The ways you can get into this account.",
        )}
      >
        <SettingsRow label={t("settings.methodPassword", "Email and password")}>
          <Badge variant={hasPassword ? "success" : "secondary"}>
            {hasPassword
              ? t("settings.methodActive", "Active")
              : t("settings.methodNotSet", "Not set")}
          </Badge>
        </SettingsRow>
        {googleAvailable && (
          <SettingsRow
            label="Google"
            description={t(
              "settings.googleHint",
              "Linked automatically the first time you sign in with Google using this email.",
            )}
          >
            <Badge variant={user.googleLinked ? "success" : "secondary"}>
              {user.googleLinked
                ? t("settings.methodLinked", "Linked")
                : t("settings.methodNotLinked", "Not linked")}
            </Badge>
          </SettingsRow>
        )}
      </SettingsSection>

      <SettingsSection title={t("settings.session", "Session")}>
        <SettingsRow
          label={t("settings.signOut", "Sign out")}
          description={t(
            "settings.signOutHint",
            "Ends the session in this browser.",
          )}
        >
          <Button
            variant="secondary"
            onClick={() => confirmLeave(() => void signOut())}
          >
            {t("settings.signOut", "Sign out")}
          </Button>
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
