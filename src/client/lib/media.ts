import { getActiveTenantId } from "@/client/lib/activeTenant";

// Fetches a same-origin media blob (the playground media endpoint) carrying the SUPER_ADMIN's
// active-tenant selector. Native <img>/<audio>/<a> requests omit the X-Tenant-Id header, so for a
// SUPER_ADMIN (whose tenant is resolved ONLY from that header) the media endpoint would resolve a
// null tenant and reply "A target tenant is required". The Eden client adds the header on every API
// call (src/client/lib/api.ts); this mirrors it for the raw fetches that load media bytes.
export function mediaFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) ?? {}),
  };
  const tenantId = getActiveTenantId();
  if (tenantId) headers["X-Tenant-Id"] = tenantId;
  return fetch(url, { ...init, credentials: "same-origin", headers });
}
