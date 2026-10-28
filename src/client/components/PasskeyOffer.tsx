import { KeyRound, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/client/components/Button";
import { useToast } from "@/client/components/Toast";
import { useAuth } from "@/client/contexts/AuthContext";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import {
  conditionalCreateAvailable,
  PasskeyAlreadyRegistered,
  PasskeyCancelled,
  passkeysSupported,
  registerPasskey,
  upgradeToPasskey,
} from "@/client/lib/passkey";
import {
  currentPasskeySession,
  decidePasskeyOffer,
  isCurrentPasskeyChange,
  markPasskeyOfferSeen,
  PASSKEYS_CHANGED_EVENT,
  passkeyOfferSeen,
} from "@/client/lib/passkeyOffer";

// Right after a password sign-in, for an account with no passkey (the
// server decides, GET /auth/passkeys/offer). First the browser's silent
// upgrade, where it exists; this card only when that made nothing. Never a
// modal, and both answers carry the same weight.
export function PasskeyOffer() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { user, passkeysEnabled } = useAuth();
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [creating, setCreating] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const startedRef = useRef(false);
  // a passkey was added elsewhere since this offer was asked for; the
  // decision still in flight must not show a card for it afterwards.
  const answeredRef = useRef(false);

  useEffect(() => {
    if (
      !user ||
      !passkeysEnabled ||
      startedRef.current ||
      !passkeysSupported()
    ) {
      return;
    }
    // NOTE: once per mount, and no cleanup that cancels: StrictMode runs the
    // effect twice and the second run returns here. The session check is the
    // sign-in counter, not the user object (a profile save replaces that) nor
    // this mount (a route change may remount the layout while the browser
    // still holds the upgrade).
    startedRef.current = true;
    const startedIn = currentPasskeySession();
    const isCurrent = () =>
      currentPasskeySession() === startedIn && !answeredRef.current;
    void decidePasskeyOffer({
      supported: passkeysSupported,
      seen: passkeyOfferSeen,
      markSeen: markPasskeyOfferSeen,
      isCurrent,
      fetchOffer: async () => {
        const { data } = await api.api.auth.passkeys.offer.get();
        return {
          offer: data?.offer === true,
          expiresAt: data?.expiresAt ? new Date(data.expiresAt) : null,
        };
      },
      conditionalAvailable: conditionalCreateAvailable,
      upgrade: upgradeToPasskey,
    }).then((outcome) => {
      if (outcome.kind === "card") setExpiresAt(outcome.expiresAt);
    });
  }, [user, passkeysEnabled]);

  // NOTE: a passkey added anywhere else (Settings, another path) answers the
  // offer: the account no longer qualifies.
  useEffect(() => {
    const answered = (event: Event) => {
      if (!isCurrentPasskeyChange(event)) return;
      answeredRef.current = true;
      setExpiresAt(null);
    };
    window.addEventListener(PASSKEYS_CHANGED_EVENT, answered);
    return () => window.removeEventListener(PASSKEYS_CHANGED_EVENT, answered);
  }, []);

  // NOTE: the card lives as long as the recent sign-in window: past it,
  // "Create passkey" would need the password again, which Settings asks for.
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setTimeout(
      () => setExpiresAt(null),
      Math.max(0, expiresAt.getTime() - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);

  if (!expiresAt) return null;

  const create = async () => {
    setCreating(true);
    try {
      await registerPasskey({});
      setExpiresAt(null);
      showToast(t("settings.passkeyAdded", "Passkey added."), "success");
    } catch (error) {
      if (error instanceof PasskeyCancelled) return;
      setExpiresAt(null);
      if (error instanceof PasskeyAlreadyRegistered) {
        showToast(
          t(
            "settings.passkeyAlreadyRegistered",
            "This device already has a passkey for this account. To add another, use another device or password manager.",
          ),
          "error",
        );
        return;
      }
      showToast(
        apiErrorMessage(error) ||
          t(
            "passkeyOffer.failed",
            "Could not create the passkey here. You can add one from Settings → Security.",
          ),
        "error",
      );
    } finally {
      setCreating(false);
    }
  };

  // The card stays until the refusal is saved. Hiding it on a failed
  // save would look recorded while the next sign-in offers it again, since
  // the cooldown lives on the account.
  const dismiss = async () => {
    setDismissing(true);
    try {
      const { error } = await api.api.auth.passkeys.offer.dismiss.post();
      if (error) throw error;
      setExpiresAt(null);
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t(
            "passkeyOffer.dismissFailed",
            "Could not save your answer. Try again.",
          ),
        "error",
      );
    } finally {
      setDismissing(false);
    }
  };

  // NOTE: floats where the toasts do (bottom right, full width at the bottom
  // on a phone, clear of the safe-area insets), but is not a toast: no timer,
  // nothing that would take it away while the person reads, and its own layer
  // so error toasts keep theirs. It never takes focus when it appears.
  // `data-floating-layer` tells the layout sweep it covers the page by design.
  return (
    <div className="pointer-events-none fixed right-0 bottom-0 z-(--z-floating-card) flex w-full max-w-sm flex-col p-4 pr-[calc(--spacing(4)+env(safe-area-inset-right))] pb-[calc(--spacing(4)+env(safe-area-inset-bottom))] md:max-w-[22rem]">
      <section
        aria-labelledby="passkey-offer-title"
        data-floating-layer
        className="pointer-events-auto flex flex-col gap-3 rounded-lg border border-border-hover bg-bg-secondary p-3 shadow-lg"
      >
        <div className="flex items-start gap-2.5">
          <span className="flex h-lh shrink-0 items-center text-accent text-sm leading-snug">
            <KeyRound className="size-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="passkey-offer-title"
              className="font-medium text-sm text-text-primary leading-snug"
            >
              {t("passkeyOffer.title", "Sign in faster next time?")}
            </h2>
            <p className="mt-0.5 text-sm text-text-secondary">
              {t(
                "passkeyOffer.description",
                "Save a passkey on this device and sign in with your fingerprint, face or screen lock instead of your password.",
              )}
            </p>
          </div>
          {/* The X is a "Not now": it records the refusal like the
              button does. Ignoring the card is what does not count. */}
          <span className="flex h-lh shrink-0 items-center text-sm leading-snug">
            <button
              type="button"
              onClick={() => void dismiss()}
              disabled={creating || dismissing}
              aria-label={t("passkeyOffer.close", "Close")}
              className="rounded-md p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </span>
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            loading={dismissing}
            disabled={creating}
            onClick={() => void dismiss()}
          >
            {t("passkeyOffer.notNow", "Not now")}
          </Button>
          <Button
            variant="secondary"
            loading={creating}
            disabled={dismissing}
            onClick={() => void create()}
          >
            {t("passkeyOffer.create", "Create passkey")}
          </Button>
        </div>
      </section>
    </div>
  );
}
