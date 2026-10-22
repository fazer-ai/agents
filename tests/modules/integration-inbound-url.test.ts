import { describe, expect, test } from "bun:test";
import { integrationsController } from "@/api/v1/integrations.controller";
import {
  INTEGRATION_INBOUND_MOUNT,
  integrationInboundUrl,
} from "@/modules/integrations/inbound-url";

// The URL the editor shows comes from PUBLIC_URL on the server. Built from the browser's address, a
// console opened through localhost or a tunnel handed out a URL the provider could never reach.
describe("integration inbound webhook URL", () => {
  test("is PUBLIC_URL plus the mount and the token, with a trailing slash trimmed", () => {
    expect(integrationInboundUrl("https://agents.example.com", "tok")).toBe(
      "https://agents.example.com/api/v1/integrations/inbound/tok",
    );
    expect(integrationInboundUrl("https://agents.example.com//", "tok")).toBe(
      "https://agents.example.com/api/v1/integrations/inbound/tok",
    );
  });

  test("the mount is the path the inbound controller answers on, under /api", () => {
    const paths = integrationsController.routes.map((r) => `/api${r.path}`);
    expect(paths).toContain(`${INTEGRATION_INBOUND_MOUNT}/:routeToken`);
  });
});
