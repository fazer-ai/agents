import { useTranslation } from "react-i18next";
import { cn } from "@/client/lib/utils";
import { useMediaObjectUrl } from "./useMediaObjectUrl";

// Renders an image served by the cookie-authenticated, same-origin playground media endpoint. A raw
// `<img src={endpoint}>` would omit the X-Tenant-Id header (breaking for a SUPER_ADMIN), so we fetch
// the blob via useMediaObjectUrl and render an object URL; the wrapping link opens that same blob in
// a new tab (no second tenant-less request).
export function MediaImage({
  src,
  alt,
  className,
}: {
  src: string;
  alt?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const { url, failed } = useMediaObjectUrl(src);

  if (failed) {
    return (
      <span className="text-text-muted text-xs italic">
        {t("playground.image.loadFailed", "Could not load the image.")}
      </span>
    );
  }
  if (!url) {
    return (
      <div
        className="bg-bg-tertiary h-32 w-44 max-w-full animate-pulse rounded-lg"
        role="status"
        aria-label={t("common.loading", "Loading…")}
      />
    );
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="block">
      <img
        src={url}
        alt={alt}
        className={cn(
          "border-border max-h-64 max-w-full rounded-lg border",
          className,
        )}
      />
    </a>
  );
}
