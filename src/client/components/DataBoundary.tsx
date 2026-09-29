import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { loadErrorMessage } from "@/client/lib/utils";
import { Button } from "./Button";
import { Card } from "./Card";
import { Skeleton } from "./Skeleton";

interface DataBoundaryProps {
  loading: boolean;
  error?: boolean;
  isEmpty?: boolean;
  onRetry?: () => void;
  loadingLabel?: string;
  errorLabel?: string;
  // HTTP status of the failed request, when known. 429 surfaces a rate-limit hint instead of the
  // generic load-error copy (see loadErrorMessage).
  errorStatus?: number;
  // Layout-matching placeholder rendered while loading. When omitted we fall
  // back to a generic row-skeleton (most consumers are row lists). Pass a
  // bespoke skeleton for distinctive layouts (dashboards, two-section pages).
  skeleton?: ReactNode;
  // Rich empty slot (e.g. an <EmptyState>). Falls back to a muted line.
  empty?: ReactNode;
  children: ReactNode;
}

// Static keys so the default skeleton rows don't key off the array index.
const DEFAULT_SKELETON_KEYS = [
  "db-skeleton-0",
  "db-skeleton-1",
  "db-skeleton-2",
];

// Centralizes the loading / error / empty / content switch every list page
// repeats. Loading shows a skeleton (the default loading indicator in this app;
// spinners are reserved for button states and the app-boot splash). Wraps the
// error / empty states in a <Card>; renders children once data is present.
export function DataBoundary({
  loading,
  error,
  isEmpty,
  onRetry,
  loadingLabel,
  errorLabel,
  errorStatus,
  skeleton,
  empty,
  children,
}: DataBoundaryProps) {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div role="status">
        <span className="sr-only">
          {loadingLabel ?? t("common.loading", "Loading…")}
        </span>
        {skeleton ?? (
          <div className="flex flex-col gap-3">
            {DEFAULT_SKELETON_KEYS.map((key) => (
              <Card
                key={key}
                className="flex items-center justify-between gap-4"
              >
                <div className="flex min-w-0 flex-col gap-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="h-8 w-28" />
              </Card>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <Card className="flex flex-col items-center gap-3 py-10 text-center">
        <p className="text-error text-sm">
          {loadErrorMessage(t, errorStatus, errorLabel)}
        </p>
        {onRetry && (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {t("common.retry", "Retry")}
          </Button>
        )}
      </Card>
    );
  }

  if (isEmpty) {
    return (
      <Card className="p-0">
        {empty ?? (
          <p className="py-10 text-center text-sm text-text-muted">
            {t("common.nothingHere", "Nothing here yet.")}
          </p>
        )}
      </Card>
    );
  }

  return <>{children}</>;
}
