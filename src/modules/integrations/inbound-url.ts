// The inbound webhook URL an operator pastes into the provider's panel. Built on the server from
// PUBLIC_URL, never from the browser's address: a console opened through localhost, an internal
// hostname or a tunnel would otherwise hand out a URL the provider cannot reach.
//
// NOTE: keep in sync with the integrationsController prefix/route in
// src/api/v1/integrations.controller.ts (`/api` group + `/v1/integrations` prefix +
// `/inbound/:routeToken`).
export const INTEGRATION_INBOUND_MOUNT = "/api/v1/integrations/inbound";

export function integrationInboundUrl(
  publicUrl: string,
  routeToken: string,
): string {
  return `${publicUrl.replace(/\/+$/, "")}${INTEGRATION_INBOUND_MOUNT}/${routeToken}`;
}
