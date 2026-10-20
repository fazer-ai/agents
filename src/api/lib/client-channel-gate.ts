import { NotFoundError } from "elysia";
import config from "@/config";

// Off (CLIENT_CHANNEL_ENABLED), the client channel's routes (the turn, the SDK's turn and the client apps) are routes
// that do not exist. Asked on
// `onRequest`, before routing: the tenancy plugin's global derive (auth, the tenant selector) and the
// body parser both run before any hook a route declares, and either would answer something a
// missing route does not (a 403 for a foreign selector, a 400 for a body that is not JSON).
const CLIENT_CHANNEL_ROUTES = [
  /^\/api\/v1\/agents\/[^/]+\/client\/turn\/?$/,
  /^\/api\/v1\/client-apps(\/|$)/,
  /^\/api\/v1\/sdk(\/|$)/,
];

export function clientChannelGate({ request }: { request: Request }): void {
  if (config.clientChannel.enabled) return;
  const { pathname } = new URL(request.url);
  if (CLIENT_CHANNEL_ROUTES.some((route) => route.test(pathname)))
    throw new NotFoundError();
}
