import { useEffect, useState } from "react";
import { mediaFetch } from "@/client/lib/media";

// The tenant's letterhead as a blob URL, or null while there is none to show.
//
// Not a plain <img src>: the logo endpoint is tenant-scoped, so a browser navigation would omit the
// active-tenant header and a SUPER_ADMIN would get "a target tenant is required" instead of a
// picture. mediaFetch + a blob URL is the same fix MediaImage applies.
//
// Keyed on the VERSION, not on the key: the file name is derived from the tenant id and the
// extension, so replacing a PNG with another PNG leaves it identical and this would never run again
// — the card would keep showing the previous letterhead while issued documents carry the new one.
// It is also the cache buster the response's own max-age needs.
export function useCompanyLogoUrl(
  logoKey: string | null | undefined,
  logoVersion: number | undefined,
): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let minted: string | null = null;
    let cancelled = false;
    // Cleared BEFORE the request, not after it answers. The PREVIOUS run's cleanup has already
    // revoked its blob URL, so leaving it in state points the <img> at bytes the browser released:
    // a broken image for the length of the request, and permanently when the request fails or the
    // logo was removed. Nothing to show is the honest state while there is nothing to show.
    setUrl(null);
    if (!logoKey) return;
    void (async () => {
      // A rejected fetch is a state too — offline, a reset connection — and unhandled it is only an
      // error in the console next to a card that never stops looking empty.
      const res = await mediaFetch(
        `/api/v1/tenant-settings/company/logo?v=${logoVersion}`,
      ).catch(() => null);
      if (!res?.ok || cancelled) return;
      const blob = await res.blob();
      // Checked AGAIN after the body arrives, because the cleanup can run during that await: a
      // tenant switch, another logo write. Minting the URL before this check hands it to a cleanup
      // that already looked and found nothing — the URL is then pinned for the life of the tab, and
      // the stale response paints the previous tenant's letterhead over the current one.
      if (cancelled) return;
      minted = URL.createObjectURL(blob);
      setUrl(minted);
    })();
    return () => {
      cancelled = true;
      if (minted) URL.revokeObjectURL(minted);
    };
  }, [logoKey, logoVersion]);

  return url;
}
