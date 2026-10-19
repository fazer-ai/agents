// A call from the playground: the operator's microphone in place of the WhatsApp line, on the same
// bridge and engine a real call runs. The browser cannot send the session cookie's tenant header
// on a WebSocket upgrade, so the authenticated POST hands it a short-lived ticket, signed with the
// JWT secret, that names the tenant, the agent and the operator; the socket presents it, under the
// session cookie of that same operator, and a logout or a password change closes it.

import { createHmac, timingSafeEqual } from "node:crypto";
import config from "@/config";
import { parseDbId } from "@/lib/db-id";
import type { TenantContext } from "@/lib/tenancy";

const TICKET_TTL_MS = 60_000;

export interface PlaygroundCallTicket {
  tenantId: bigint;
  agentId: bigint;
  userId: bigint | null;
}

function sign(body: string): string {
  return createHmac("sha256", config.jwtSecret)
    .update(`playground-call:${body}`)
    .digest("base64url");
}

export function issuePlaygroundCallTicket(
  ctx: TenantContext,
  agentId: bigint,
  now = Date.now(),
): string {
  if (ctx.tenantId === null)
    throw new Error("a playground call needs a tenant");
  const body = [
    ctx.tenantId,
    agentId,
    ctx.userId ?? "",
    now + TICKET_TTL_MS,
  ].join(".");
  return `${body}.${sign(body)}`;
}

/** The ticket's claims, or null when it is forged, malformed or expired. */
export function readPlaygroundCallTicket(
  raw: string,
  now = Date.now(),
): PlaygroundCallTicket | null {
  const parts = raw.split(".");
  if (parts.length !== 5) return null;
  const [tenant, agent, user, exp, mac] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  const expected = Buffer.from(sign(parts.slice(0, 4).join(".")));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    return null;
  if (!(Number(exp) > now)) return null;
  const tenantId = parseDbId(tenant);
  const agentId = parseDbId(agent);
  const userId = user ? parseDbId(user) : null;
  if (tenantId === null || agentId === null || (user && userId === null))
    return null;
  return { tenantId, agentId, userId };
}
