import { useBranding } from "@/client/contexts/BrandingContext";
import { DEFAULT_BRAND_NAME } from "@/lib/branding";

// The auth-page footer: "© {year} {brandName}". The brand name follows the global white-label
// config. When it is the default it links to the product site; a custom brand renders as plain
// text (linking a white-label brand back to fazer.ai would be misleading).
export function BrandFooter() {
  const { brandName } = useBranding();
  const year = new Date().getFullYear();
  const isDefault = brandName === DEFAULT_BRAND_NAME;
  return (
    <footer className="mt-12 text-center">
      <p className="text-text-muted text-xs">
        {"© "}
        {year}{" "}
        {isDefault ? (
          <a
            href="https://fazer.ai"
            className="text-text-secondary hover:text-text-primary hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            {brandName}
          </a>
        ) : (
          <span className="text-text-secondary">{brandName}</span>
        )}
      </p>
    </footer>
  );
}
