import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Avatar,
  Button,
  Input,
  RoleBadge,
  useToast,
} from "@/client/components";
import { useAuth } from "@/client/contexts/AuthContext";
import { useNavGuard } from "@/client/contexts/NavGuardContext";
import { useFieldRefusal } from "@/client/hooks/useFieldRefusal";
import { api } from "@/client/lib/api";
import { SettingsRow, SettingsSection } from "./SettingsSection";

const NAME_MAX_LENGTH = 100;
const NAME_FIELDS = ["name"] as const;

// What the name field should hold once a save of `submitted` comes back as `saved`. It is only
// normalized if it still holds what was submitted; an edit typed while the request was in flight is
// kept, and stays dirty.
export function nameAfterSave(
  current: string,
  submitted: string,
  saved: string,
): string {
  return current.trim() === submitted ? saved : current;
}

export function SettingsProfilePage() {
  const { t, i18n } = useTranslation();
  const { user, updateUser } = useAuth();
  const { showToast } = useToast();
  const nameId = useId();

  const savedName = user?.name ?? "";
  const [name, setName] = useState(savedName);
  const [saving, setSaving] = useState(false);
  const refusal = useFieldRefusal(NAME_FIELDS);
  const sentRef = useRef({ name });
  sentRef.current = { name: name.trim() };

  // Follow the stored value when it changes underneath (the /me refresh after a login, or a
  // save), but only while the field is untouched.
  const [lastSynced, setLastSynced] = useState(savedName);
  useEffect(() => {
    if (name === lastSynced && savedName !== lastSynced) {
      setName(savedName);
      setLastSynced(savedName);
    }
  }, [savedName, name, lastSynced]);

  const isDirty = name.trim() !== savedName;
  // Armed through a save too: the field stays editable, and an edit typed while the request is in
  // flight is not in it.
  useNavGuard(isDirty);

  if (!user) return null;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!isDirty || saving) return;
    setSaving(true);
    const submitted = name.trim();
    const sent = { name: submitted };
    const held = (e: unknown) =>
      refusal.capture(
        e,
        t("settings.profileSaveError", "Could not save your profile."),
        sent,
        sentRef.current,
      );
    try {
      const { data, error } = await api.api.auth.me.patch(sent);
      if (error || !data?.user) throw error;
      refusal.clear();
      // The saved value comes from the PATCH response itself, not from a refresh that can
      // fail after the save already succeeded.
      const saved = data.user.name ?? "";
      updateUser(data.user.id, { name: data.user.name });
      setLastSynced(saved);
      setName((current) => nameAfterSave(current, submitted, saved));
      showToast(t("settings.profileSaved", "Profile saved"), "success");
    } catch (e) {
      const toast = held(e);
      if (toast) showToast(toast, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-4">
        <Avatar name={user.name} email={user.email} size="lg" />
        <div className="min-w-0">
          <p className="truncate font-semibold text-lg text-text-primary">
            {user.name || user.email}
          </p>
          {user.name && (
            <p className="truncate text-sm text-text-muted">{user.email}</p>
          )}
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <SettingsSection
          title={t("settings.profile", "Profile")}
          description={t(
            "settings.profileDescription",
            "How you appear to other people in this app.",
          )}
          footer={
            <>
              {isDirty && (
                <Button
                  variant="ghost"
                  onClick={() => setName(savedName)}
                  disabled={saving}
                >
                  {t("common.discard", "Discard")}
                </Button>
              )}
              <Button type="submit" loading={saving} disabled={!isDirty}>
                {t("common.save", "Save")}
              </Button>
            </>
          }
        >
          <SettingsRow
            label={<label htmlFor={nameId}>{t("common.name", "Name")}</label>}
            description={t(
              "settings.nameHint",
              "Leave it empty to show your email instead.",
            )}
          >
            <div className="@lg:w-64">
              <Input
                id={nameId}
                value={name}
                maxLength={NAME_MAX_LENGTH}
                autoComplete="name"
                onChange={(e) => setName(e.target.value)}
                errorMessage={refusal.at("name", name.trim()) ?? undefined}
              />
            </div>
          </SettingsRow>
          <SettingsRow
            label={t("common.email", "Email")}
            description={t(
              "settings.emailHint",
              "Your email identifies the account and cannot be changed here.",
            )}
          >
            <span className="text-sm text-text-secondary">{user.email}</span>
          </SettingsRow>
          <SettingsRow
            label={t("common.role", "Role")}
            description={t("settings.roleHint", "Set by an administrator.")}
          >
            <RoleBadge role={user.role} />
          </SettingsRow>
          {user.createdAt && (
            <SettingsRow label={t("settings.memberSince", "Member since")}>
              <span className="text-sm text-text-secondary">
                {new Date(user.createdAt).toLocaleDateString(i18n.language, {
                  dateStyle: "long",
                })}
              </span>
            </SettingsRow>
          )}
        </SettingsSection>
      </form>
    </>
  );
}
