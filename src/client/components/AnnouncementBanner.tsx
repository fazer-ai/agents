import { Info, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useUpdates } from "@/client/contexts/UpdatesContext";
import { cn, isSafeHttpUrl } from "@/client/lib/utils";

// Per-browser dismissal, keyed by announcement id so a NEW announcement (different id) reappears. UI
// preference, not product data — consistent with @app:theme / @app:sidebar-* (prefix chosen: @agents:).
const DISMISS_PREFIX = "@agents:announcement-dismissed:";

// Guard the storage READ the same way dismiss() guards the write: a blocked/disabled localStorage
// (Safari private mode, etc.) throws on getItem, and we'd rather show the announcement than crash the
// banner, so a storage failure is treated as "not dismissed".
function isDismissed(id: string): boolean {
  try {
    return localStorage.getItem(`${DISMISS_PREFIX}${id}`) != null;
  } catch {
    return false;
  }
}

const LEVEL_STYLES = {
  INFO: {
    border: "border-info",
    bg: "bg-info-soft",
    icon: "text-info",
    Icon: Info,
  },
  WARNING: {
    border: "border-warning",
    bg: "bg-warning-soft",
    icon: "text-warning",
    Icon: TriangleAlert,
  },
  CRITICAL: {
    border: "border-error",
    bg: "bg-error-soft",
    icon: "text-error",
    Icon: TriangleAlert,
  },
} as const;

const SEVERITY_ORDER = { CRITICAL: 0, WARNING: 1, INFO: 2 } as const;

// Hub-authored operator announcements, rendered as a stack of dismissible banners at the top of the
// app shell (most severe first). Renders nothing when there is nothing active, so it has zero layout
// impact when idle. Fed by UpdatesContext (see src/modules/updates on the backend).
export function AnnouncementBanner() {
  const { announcements } = useUpdates();
  const { t, i18n } = useTranslation();
  // Bumped on dismiss so the localStorage-backed filter re-runs.
  const [, setTick] = useState(0);

  const active = announcements
    .filter((a) => !isDismissed(a.id))
    .sort((a, b) => SEVERITY_ORDER[a.level] - SEVERITY_ORDER[b.level]);

  if (active.length === 0) return null;

  const lang = i18n.language;
  const dismiss = (id: string) => {
    try {
      localStorage.setItem(`${DISMISS_PREFIX}${id}`, "1");
    } catch {}
    setTick((n) => n + 1);
  };

  return (
    <div className="flex shrink-0 flex-col">
      {active.map((a) => {
        const style = LEVEL_STYLES[a.level] ?? LEVEL_STYLES.INFO;
        const text = a.content[lang] ?? a.content.en;
        const ctaLabel = a.cta ? (a.cta.label[lang] ?? a.cta.label.en) : null;
        // The CTA URL is hub-authored: only render the link for an allowlisted http(s) scheme so a
        // crafted `javascript:` href can't execute on click.
        const ctaHref = a.cta && isSafeHttpUrl(a.cta.url) ? a.cta.url : null;
        const Icon = style.Icon;
        return (
          <div
            key={a.id}
            role="alert"
            className={cn(
              "flex items-start gap-2 border-b px-4 py-2.5",
              style.border,
              style.bg,
            )}
          >
            <Icon
              className={cn("mt-0.5 h-4 w-4 shrink-0", style.icon)}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1 text-sm">
              {text?.title && (
                <span className="text-text-primary mr-1 font-medium">
                  {text.title}
                </span>
              )}
              <span className="text-text-secondary">{text?.body}</span>
              {ctaHref && ctaLabel && (
                <a
                  href={ctaHref}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent ml-2 font-medium hover:underline"
                >
                  {ctaLabel}
                </a>
              )}
            </div>
            {a.dismissible && (
              <button
                type="button"
                onClick={() => dismiss(a.id)}
                aria-label={t("common.dismiss", "Dismiss")}
                className="text-text-muted hover:text-text-primary -mt-0.5 shrink-0 rounded"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
