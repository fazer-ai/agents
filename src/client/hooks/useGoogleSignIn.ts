import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useAuth } from "@/client/contexts/AuthContext";
import { api } from "@/client/lib/api";
import type { ApiErrorPayload } from "@/client/lib/types";

interface UseGoogleSignInOptions {
  onError: (message: string) => void;
}

interface UseGoogleSignInResult {
  pending: boolean;
  signIn: (credential: string) => Promise<void>;
}

export function useGoogleSignIn({
  onError,
}: UseGoogleSignInOptions): UseGoogleSignInResult {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { login } = useAuth();
  const [pending, setPending] = useState(false);
  // Synchronous lock so two rapid credential callbacks cannot both pass
  // the guard before React commits the `pending` state update.
  const inFlightRef = useRef(false);

  const signIn = async (credential: string) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPending(true);
    try {
      const { data, error: apiError } = await api.api.auth.google.post({
        credential,
      });
      if (apiError) {
        onError(
          (apiError.value as ApiErrorPayload)?.error ||
            t("auth.googleSignInFailed", "Google sign-in failed"),
        );
        return;
      }
      if (data?.user) {
        login(data.user);
        navigate("/");
      }
    } catch {
      onError(t("auth.googleSignInFailed", "Google sign-in failed"));
    } finally {
      inFlightRef.current = false;
      setPending(false);
    }
  };

  return { pending, signIn };
}
