import * as ToastPrimitive from "@radix-ui/react-toast";
import { AlertCircle, CheckCircle, Info, X, XCircle } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/client/lib/utils";

type ToastType = "success" | "error" | "warning" | "info";

interface ToastItem {
  internalId: string;
  id?: string;
  message: string;
  type: ToastType;
  open: boolean;
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType, id?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return context;
}

const TOAST_DURATION = 5000;

const icons: Record<ToastType, ReactNode> = {
  success: <CheckCircle className="h-4 w-4" aria-hidden="true" />,
  error: <XCircle className="h-4 w-4" aria-hidden="true" />,
  warning: <AlertCircle className="h-4 w-4" aria-hidden="true" />,
  info: <Info className="h-4 w-4" aria-hidden="true" />,
};

const iconStyles: Record<ToastType, string> = {
  success: "text-success",
  error: "text-error",
  warning: "text-warning",
  info: "text-accent",
};

function generateInternalId(): string {
  // NOTE: randomUUID requires secure context (HTTPS / localhost). Fall back to Math.random for plain HTTP.
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

function ToastItemView({
  toast,
  onOpenChange,
}: {
  toast: ToastItem;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const assertive = toast.type === "error" || toast.type === "warning";

  return (
    <ToastPrimitive.Root
      open={toast.open}
      onOpenChange={onOpenChange}
      type={assertive ? "foreground" : "background"}
      className={cn(
        // NOTE: items-start so the icon stays on the first line of a multi-line message, and
        // whitespace-pre-line on the title so a "\n" in the message survives. The type is carried by
        // the icon alone: a colored border around the whole card read as an error even for a success.
        "flex items-start gap-2.5 rounded-lg border border-border-hover bg-bg-secondary py-2.5 pr-2 pl-3 shadow-lg",
        "data-[state=open]:slide-in-from-right-full data-[state=open]:animate-in",
        "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-right-full data-[state=closed]:animate-out",
        "data-[swipe=end]:slide-out-to-right-full data-[swipe=cancel]:translate-x-0 data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=end]:animate-out data-[swipe=cancel]:transition-transform",
      )}
    >
      {/* The icon and the close button each sit in a box exactly one line of the title tall (h-lh,
          with the title's own text size and leading), so they center on the first line whatever the
          density and however many lines the message wraps to. */}
      <span
        className={cn(
          iconStyles[toast.type],
          "flex h-lh shrink-0 items-center text-sm leading-snug",
        )}
      >
        {icons[toast.type]}
      </span>
      <ToastPrimitive.Title className="flex-1 whitespace-pre-line text-sm text-text-primary leading-snug">
        {toast.message}
      </ToastPrimitive.Title>
      <span className="flex h-lh shrink-0 items-center text-sm leading-snug">
        <ToastPrimitive.Close
          // t('common.dismiss', 'Dismiss')
          aria-label={t("common.dismiss", "Dismiss")}
          className="shrink-0 rounded-md p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </ToastPrimitive.Close>
      </span>
    </ToastPrimitive.Root>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const pendingTimeoutsRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    const timeouts = pendingTimeoutsRef.current;
    return () => {
      for (const id of timeouts) {
        window.clearTimeout(id);
      }
      timeouts.clear();
    };
  }, []);

  const handleOpenChange = useCallback((internalId: string, open: boolean) => {
    if (open) return;
    setToasts((prev) =>
      prev.map((t) =>
        t.internalId === internalId ? { ...t, open: false } : t,
      ),
    );
    const timeoutId = window.setTimeout(() => {
      pendingTimeoutsRef.current.delete(timeoutId);
      setToasts((prev) => prev.filter((t) => t.internalId !== internalId));
    }, 200);
    pendingTimeoutsRef.current.add(timeoutId);
  }, []);

  const showToast = useCallback(
    (message: string, type: ToastType = "info", id?: string) => {
      // NOTE: dedupe must be atomic against the latest state so back-to-back
      // calls in the same tick still collapse to a single toast. Using the
      // functional setState updater avoids a stale mirror via useRef.
      setToasts((prev) => {
        if (id) {
          const existing = prev.find((t) => t.id === id && t.open);
          if (existing) {
            // NOTE: regenerate internalId so the ToastPrimitive.Root remounts
            // (internalId is the React key) and Radix's auto-dismiss timer
            // resets. Without this, a keyed replacement near the 5s expiry
            // would disappear almost immediately.
            return prev.map((t) =>
              t.internalId === existing.internalId
                ? {
                    ...t,
                    internalId: generateInternalId(),
                    message,
                    type,
                    open: true,
                  }
                : t,
            );
          }
        }

        return [
          ...prev,
          {
            internalId: generateInternalId(),
            id,
            message,
            type,
            open: true,
          },
        ];
      });
    },
    [],
  );

  return (
    <ToastContext.Provider value={{ showToast }}>
      <ToastPrimitive.Provider duration={TOAST_DURATION} swipeDirection="right">
        {children}
        {toasts.map((toast) => (
          <ToastItemView
            key={toast.internalId}
            toast={toast}
            onOpenChange={(open) => handleOpenChange(toast.internalId, open)}
          />
        ))}
        <ToastPrimitive.Viewport className="fixed top-(--header-height) right-0 z-(--z-toast) flex w-full max-w-sm flex-col gap-2 p-4 outline-none md:max-w-[22rem]" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}
