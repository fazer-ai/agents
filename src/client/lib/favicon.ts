import { BRANDING_DEFAULT_FAVICONS_KEY } from "@/lib/branding";

// The page's icon links. `public/index.html` declares two (the bundled defaults, by
// `prefers-color-scheme`); a configured favicon replaces them with one link following the app theme.
// Applying one rebuilds the set, so the declared links are remembered before the first override, or
// clearing the favicon would have nothing to restore. Remembered on a window property, not a module
// variable: the inline <head> script may apply the cached favicon first, removing the declared links
// so the browser does not fetch the default too. Whichever runs first writes it; the other reads it.

export interface IconLink {
  href: string;
  media: string | null;
}

function stash(): IconLink[] | undefined {
  return (globalThis as Record<string, unknown>)[
    BRANDING_DEFAULT_FAVICONS_KEY
  ] as IconLink[] | undefined;
}

function currentLinks(): IconLink[] {
  return Array.from(
    document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'),
  ).map((l) => ({
    href: l.getAttribute("href") ?? "",
    media: l.getAttribute("media"),
  }));
}

// The declared defaults, remembering them on the first call if the inline script did not.
function declaredDefaults(): IconLink[] {
  const remembered = stash();
  if (remembered) return remembered;
  const declared = currentLinks();
  (globalThis as Record<string, unknown>)[BRANDING_DEFAULT_FAVICONS_KEY] =
    declared;
  return declared;
}

// Apply the custom favicon, or (url=null) restore the declared defaults.
export function applyFavicon(url: string | null): void {
  if (typeof document === "undefined") return;
  const defaults = declaredDefaults();
  for (const l of Array.from(
    document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'),
  )) {
    l.remove();
  }
  const links = url ? [{ href: url, media: null }] : defaults;
  for (const { href, media } of links) {
    const link = document.createElement("link");
    link.rel = "icon";
    link.href = href;
    if (media) link.setAttribute("media", media);
    document.head.appendChild(link);
  }
}
