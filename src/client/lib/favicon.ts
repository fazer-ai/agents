import { BRANDING_DEFAULT_FAVICONS_KEY } from "@/lib/branding";

// The page's icon links. Two of them are declared in `public/index.html` (the bundled defaults,
// scoped by `prefers-color-scheme`); a configured favicon replaces them with a single link whose
// variant follows the app theme instead. Applying one is a whole-set rebuild, so the declared
// links have to be remembered somewhere before the first override, or clearing the favicon would
// have nothing to restore.
//
// That "somewhere" is a single window property rather than a module variable, because the first
// override does not always happen here: the inline <head> script applies the cached favicon before
// this bundle exists, and it removes the declared links to keep the browser from fetching the
// default (measured in Chromium: leaving them in place fetches both). Whichever of the two runs
// first writes the property; the other reads it.

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
