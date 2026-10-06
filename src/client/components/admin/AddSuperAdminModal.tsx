import { Check, Copy } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/client/components/Button";
import { Input } from "@/client/components/Input";
import {
  Modal,
  type ModalController,
  useOnModalOpen,
} from "@/client/components/Modal";
import { useAuth } from "@/client/contexts/AuthContext";
import { useFieldRefusal } from "@/client/hooks/useFieldRefusal";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";

// A fleet administrator makes another person one, in two steps so the password asked for is never
// read as the other person's: first the email, then a confirmation that says what will happen
// (promote an existing account now, or mint a one-day invitation link) and takes the ACTING admin's
// password. The lookup between the steps is only a preview; the server decides on submit.
const labelCls = "mb-1 block font-medium text-sm text-text-primary";

const FIELDS = ["password"] as const;

type Step =
  | { kind: "email"; already?: string }
  | { kind: "confirm"; email: string; existing: boolean }
  | { kind: "promoted"; email: string }
  | { kind: "invited"; email: string; link: string };

export function AddSuperAdminModal({
  modal,
  onDone,
}: {
  modal: ModalController;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { user: me } = useAuth();
  const [step, setStep] = useState<Step>({ kind: "email" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const refusal = useFieldRefusal(
    modal.isOpen && step.kind === "confirm" ? FIELDS : [],
  );

  const current = { email: email.trim(), password };
  const currentRef = useRef(current);
  currentRef.current = current;

  const isDirty =
    (step.kind === "email" || step.kind === "confirm") && email.trim() !== "";

  useOnModalOpen(modal, () => {
    refusal.clear();
    setStep({ kind: "email" });
    setEmail("");
    setPassword("");
    setCopied(false);
    setError("");
  });

  // The fleet's user list already answers whether the email has an account; an exact match only,
  // since the search is a substring filter.
  const handleContinue = async () => {
    const wanted = email.trim().toLowerCase();
    setError("");
    setLoading(true);
    try {
      const { data, error: apiError } = await api.api.admin.users.get({
        query: { search: wanted },
      });
      if (apiError || !data) {
        setError(
          apiErrorMessage(apiError) ||
            t("superAdmin.failed", "Could not add the super admin"),
        );
        return;
      }
      const rows = data.users.filter((u) => u.email.toLowerCase() === wanted);
      if (rows.some((u) => u.role === "SUPER_ADMIN")) {
        setStep({ kind: "email", already: wanted });
        return;
      }
      setPassword("");
      setStep({ kind: "confirm", email: wanted, existing: rows.length > 0 });
    } finally {
      setLoading(false);
    }
  };

  // The email the confirmation NAMED, not the raw field: the step shows the normalized one.
  const handleConfirm = async (confirmed: string) => {
    setError("");
    setLoading(true);
    const body = { email: confirmed, password };
    const held = (e: unknown) =>
      refusal.capture(
        e,
        t("superAdmin.failed", "Could not add the super admin"),
        body,
        currentRef.current,
      ) ?? "";
    try {
      const { data, error: apiError } =
        await api.api.admin["super-admins"].post(body);
      if (apiError) {
        setError(held(apiError));
        return;
      }
      refusal.clear();
      if (data?.result === "promoted") {
        setStep({ kind: "promoted", email: data.user.email });
        onDone();
      } else if (data?.result === "invited") {
        setStep({
          kind: "invited",
          email: data.invite.email,
          link: data.invite.acceptUrl,
        });
        onDone();
      }
    } catch (e) {
      setError(held(e));
    } finally {
      setLoading(false);
    }
  };

  const copyLink = async () => {
    if (step.kind !== "invited") return;
    try {
      await navigator.clipboard.writeText(step.link);
      setCopied(true);
    } catch {
      // Clipboard may be unavailable (insecure context); the link stays selectable.
    }
  };

  const errorBox = error && (
    <div className="rounded-lg border border-error bg-error-soft px-4 py-2 text-error text-sm">
      {error}
    </div>
  );

  return (
    <Modal
      modal={modal}
      title={t("superAdmin.title", "Add super admin")}
      size="md"
      unsavedChanges={isDirty}
    >
      {step.kind === "email" && (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!loading && email.trim()) void handleContinue();
          }}
        >
          <p className="text-sm text-text-secondary">
            {t(
              "superAdmin.hint",
              "A super admin administers the whole installation: every tenant, user and setting.",
            )}
          </p>
          {errorBox}
          {step.already && (
            <p className="text-sm text-text-primary">
              {t(
                "superAdmin.alreadySuperAdmin",
                "{{email}} is already a super admin.",
                { email: step.already },
              )}
            </p>
          )}
          <div>
            <label htmlFor="super-admin-email" className={labelCls}>
              {t("superAdmin.email", "Email of the person")}
            </label>
            <Input
              id="super-admin-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={loading}
              placeholder={t("auth.emailPlaceholder", "you@example.com")}
            />
          </div>
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
              disabled={loading || !email.trim()}
            >
              {t("common.continue", "Continue")}
            </Button>
          </div>
        </form>
      )}

      {step.kind === "confirm" && (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!loading && password) void handleConfirm(step.email);
          }}
        >
          <p className="text-sm text-text-primary">
            {step.existing
              ? t(
                  "superAdmin.confirmExisting",
                  "{{email}} already has an account and gets access to every tenant, as a super admin, as soon as you confirm.",
                  { email: step.email },
                )
              : t(
                  "superAdmin.confirmInvite",
                  "{{email}} has no account yet. When you confirm, you get a single-use invitation link, valid for 24 hours, to send them.",
                  { email: step.email },
                )}
          </p>
          {errorBox}
          <div>
            <label htmlFor="super-admin-password" className={labelCls}>
              {t("superAdmin.confirmPassword", "Confirm with your password")}
            </label>
            <Input
              id="super-admin-password"
              type="password"
              autoComplete="current-password"
              showPasswordToggle
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={loading}
              placeholder="••••••••"
              helperText={t(
                "superAdmin.passwordHelp",
                "The password of your account ({{email}}), to confirm it is you granting this access.",
                { email: me?.email ?? "" },
              )}
            />
            {refusal.at("password", current.password) && (
              <p className="mt-1 text-error text-xs">
                {refusal.at("password", current.password)}
              </p>
            )}
          </div>
          <div className="flex justify-between gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setError("");
                setStep({ kind: "email" });
              }}
              disabled={loading}
            >
              {t("common.back", "Back")}
            </Button>
            <Button
              type="submit"
              loading={loading}
              disabled={loading || !password}
            >
              {step.existing
                ? t("superAdmin.promoteNow", "Promote now")
                : t("superAdmin.createInvite", "Create invitation")}
            </Button>
          </div>
        </form>
      )}

      {(step.kind === "promoted" || step.kind === "invited") && (
        <div className="space-y-4">
          {step.kind === "promoted" ? (
            <p className="text-sm text-text-secondary">
              {t(
                "superAdmin.promoted",
                "{{email}} is now a super admin and reaches every tenant. If they stop being one, they go back to the tenant access they already had.",
                { email: step.email },
              )}
            </p>
          ) : (
            <>
              <p className="text-sm text-text-secondary">
                {t(
                  "superAdmin.invited",
                  "Send this link to {{email}}. It works once, for 24 hours, and whoever accepts it becomes a super admin. It is shown only once.",
                  { email: step.email },
                )}
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-text-primary text-xs">
                  {step.link}
                </code>
                <Button size="sm" variant="secondary" onClick={copyLink}>
                  {copied ? (
                    <Check className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Copy className="h-4 w-4" aria-hidden="true" />
                  )}
                  {copied
                    ? t("common.copied", "Copied")
                    : t("common.copy", "Copy")}
                </Button>
              </div>
            </>
          )}
          <div className="flex justify-end">
            <Button onClick={modal.close}>{t("common.done", "Done")}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
