import { useEffect, useState } from "react";
import { useBranding } from "@/client/contexts/BrandingContext";
import { useThemedAsset } from "@/client/contexts/ThemeContext";
import { cn } from "@/client/lib/utils";

// The app logo. Renders the GLOBAL custom logo (theme-aware) when one is configured, otherwise the
// bundled default asset (also theme-aware via the -light suffix). Single source for every logo
// site (header, sidebar, auth pages).
//
// FOUC: while branding is not `ready` (a cold first load, before the config fetch settles) it
// renders an invisible placeholder — never the default logo — so a returning custom-branded
// install doesn't flash the default before the real logo loads. A cache hit is ready synchronously.
export function Logo({
  className,
  variant = "full",
}: {
  className?: string;
  // `mark` is the square symbol alone, for where the wordmark has no room (the collapsed
  // sidebar). A custom brand supplies it through its favicon; a custom logo without one is
  // cropped to its left edge, where a wordmark's symbol usually sits.
  variant?: "full" | "mark";
}) {
  const { logoUrl, markUrl, ready } = useBranding();
  const fallback = useThemedAsset(
    variant === "mark" ? "/assets/logo-mark.png" : "/assets/logo.png",
  );
  // If the custom logo URL ever fails to load (e.g. a stale config pointing at a just-removed
  // asset), fall back to the bundled default instead of rendering an empty/broken image.
  const [failed, setFailed] = useState(false);
  const custom = variant === "mark" ? (markUrl ?? logoUrl) : logoUrl;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the error state when the URL changes (a new logo was set).
  useEffect(() => setFailed(false), [custom]);

  if (!ready) {
    return (
      <span
        aria-hidden="true"
        className={className}
        style={{ visibility: "hidden" }}
      />
    );
  }
  const src = custom && !failed ? custom : fallback.src;
  const croppedWordmark =
    variant === "mark" && !markUrl && !!logoUrl && !failed;
  return (
    <img
      src={src}
      alt=""
      className={cn(className, { "object-cover object-left": croppedWordmark })}
      onError={() => setFailed(true)}
    />
  );
}
