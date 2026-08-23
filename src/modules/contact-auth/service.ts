import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import type { FlowEvent } from "@/modules/flowlog/service";
import {
  type InjectableCredential,
  resolveInjectableCredentialEntry,
} from "@/modules/vault/injectable";
import { isNonInjectableSecret } from "@/modules/vault/secret-types";
import {
  type CheckDeps,
  type ContactAuthVerdict,
  channelSlug,
  checkContactAuthorization,
  reasonSlug,
  underSignal,
} from "./check";
import type { ContactAuthConfig } from "./settings";
import { contactAuthFlightKey, singleFlight } from "./state";

// The contact authorization check as the runtime calls it: identity from the mirrored contact,
// credential from the vault, one request per incoming message (single-flight coalesces concurrent
// deliveries; no verdict is cached, so the endpoint's answer is always current), and a verdict the
// two callers (the webhook gate, the proactive nudge) act on the same way. The DB reads here are
// short and scoped; the network call runs outside any transaction (docs/tenancy.md, rule 3).

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export type { ContactAuthOutcome } from "./check";

export interface ContactAuthResult extends ContactAuthVerdict {
  // True when this call did not ask the endpoint itself: it was coalesced into a concurrent call's
  // request (single-flight). The gate acts (message, handoff, note) only on the leader's verdict,
  // so two deliveries racing do not act twice.
  shared: boolean;
}

export interface AuthorizeContactParams {
  tenantId: bigint;
  agentId: bigint;
  // Our Contact row id (Conversation.contactId). null = the conversation has no mirrored contact.
  contactDbId: bigint | null;
  conversationId: number;
  // The Chatwoot inbox id, for the POST body. null when unknown.
  inboxId: number | null;
  // The inbox's raw channel_type ("Channel::Whatsapp", ...); slugged before it travels.
  channelType: string | null;
  // The triggering message's text; null on a proactive nudge. Forwarded only under POST with
  // includeMessageText (check.ts caps and places it), and never retained or logged here.
  messageText: string | null;
  // What this asking IS, for the single-flight scope: the triggering message's id when the text is
  // part of the question, the caller's own name otherwise ("nudge"). Two different askings must not
  // share a verdict — see contactAuthFlightKey.
  requestKey: string;
  cfg: ContactAuthConfig;
  base?: PrismaClient;
  fetchImpl?: typeof fetch;
  assertSafe?: CheckDeps["assertSafe"];
  // Injectable for tests, like the two above. The real one refreshes a managed-OAuth token, which
  // is the whole reason the deadline has to start before it rather than inside the request.
  resolveCredential?: typeof resolveInjectableCredentialEntry;
}

function trimmed(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export async function authorizeContact(
  params: AuthorizeContactParams,
): Promise<ContactAuthResult> {
  const base = params.base ?? basePrisma;
  const { tenantId, agentId, cfg } = params;
  if (params.contactDbId === null) {
    return { outcome: "no_identity", shared: false, reason: "no_contact" };
  }
  const contactDbId = params.contactDbId;
  const key = contactAuthFlightKey(
    tenantId,
    agentId,
    contactDbId,
    params.requestKey,
  );
  const { verdict, shared } = await singleFlight(
    key,
    async (): Promise<ContactAuthVerdict> => {
      // NOTE: Read inside the single-flight, so a burst resolves the identity once too. Everything
      // under `contact` is what Chatwoot mirrored; nothing the customer typed can stand in for it.
      const contact = await runScopedOn(base, sysCtx(tenantId), (db) =>
        db.contact.findUnique({
          where: { id: contactDbId },
          select: {
            phone: true,
            name: true,
            email: true,
            chatwootContactId: true,
            attributes: true,
          },
        }),
      );
      const phone = trimmed(contact?.phone);
      const email = trimmed(contact?.email);
      const attrs = contact?.attributes;
      const identifier = trimmed(
        attrs && typeof attrs === "object" && !Array.isArray(attrs)
          ? (attrs as Record<string, unknown>).identifier
          : null,
      );
      // NOTE: The Chatwoot contact id alone is NOT identity: it names the row to us and says
      // nothing to the operator's system. Without a phone, an email or an operator identifier
      // there is nothing to ask about.
      if (!phone && !email && !identifier) {
        return { outcome: "no_identity", reason: "no_identifiers" };
      }
      if (!cfg.url) return { outcome: "error", reason: "not_configured" };
      // The deadline starts HERE, not inside the request, because the credential is resolved first
      // and a managed-OAuth entry refreshes its token to produce it — a network call with a
      // ten-second ceiling of its own. Timed from the request, a gate configured for one second
      // could hold the webhook for eleven, while `timeoutMs` promises to cover every step that
      // waits. From this line to the answer is one budget.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
      try {
        let credential: InjectableCredential | null = null;
        if (cfg.credentialRef) {
          let timedOut = false;
          try {
            // NOTE: Outside any tx: a managed-OAuth entry may refresh its token here. Under the
            // signal, so a refresh that hangs spends the gate's budget instead of its own.
            const resolve =
              params.resolveCredential ?? resolveInjectableCredentialEntry;
            credential = await underSignal(
              resolve(base, tenantId, cfg.credentialRef),
              ctrl.signal,
            );
          } catch (err) {
            timedOut = ctrl.signal.aborted;
            logger.warn(
              "contact-auth: credential resolution failed (agent=%s): %s",
              String(agentId),
              err instanceof Error ? err.message : String(err),
            );
          }
          // A budget spent before the endpoint was even asked is a timeout, not an unreadable
          // credential: the operator's key may be perfectly fine and merely slower than the gate.
          if (timedOut) return { outcome: "error", reason: "timeout" };
          // A missing, pending or unreadable credential is an error, not a request without it: the
          // endpoint would answer 401 and the gate would read that as "denied", telling the customer
          // they are not registered because of a key the operator has not filled in.
          if (!credential) {
            return { outcome: "error", reason: "credential_unavailable" };
          }
          // A kind whose rule says it never travels in an outbound request (mcp_env is read by the
          // stdio loader, langfuse by observability). The request builder falls back to a generic
          // Bearer when the vault has no injection rule, which is right for a kind it does not know
          // and exactly wrong here: it would hand an unrelated secret to somebody else's endpoint.
          // The editor cannot offer these, but REST, MCP and import can carry one.
          if (isNonInjectableSecret(credential.kind)) {
            logger.warn(
              "contact-auth: credential kind %s is never injected into an outbound request (agent=%s)",
              String(credential.kind),
              String(agentId),
            );
            return { outcome: "error", reason: "credential_not_injectable" };
          }
        }
        return await checkContactAuthorization(
          cfg,
          {
            phone,
            name: trimmed(contact?.name),
            email,
            identifier,
            chatwootContactId: contact?.chatwootContactId ?? null,
            conversationId: params.conversationId,
            inboxId: params.inboxId,
            channel: channelSlug(params.channelType),
            messageText: params.messageText,
          },
          credential,
          {
            fetchImpl: params.fetchImpl,
            assertSafe: params.assertSafe,
            signal: ctrl.signal,
          },
        );
      } finally {
        clearTimeout(timer);
      }
    },
  );
  return { ...verdict, shared };
}

// The execution-log line for a verdict. `detail` carries an outcome enum, a boolean, an HTTP status
// and OUR OWN reason code — a fixed list, every value of which is in this repository. The
// endpoint's own reason is deliberately absent: the slug guard is a check on SHAPE, and
// `5511999999999` is slug-shaped, so passing it through would put a phone number in a detail that
// alert channels are promised to be PII-free. It goes to the operator note instead, which lives in
// their Chatwoot beside the conversation it describes. The customer's text never appears anywhere:
// it travels to the endpoint and nowhere else. A denial is ordinary operation (info); a check that
// could not run, or a contact that could not be asked about, is something the operator should hear
// (warn, so alert channels fire on inbox traffic).
export function contactAuthFlowEvent(result: ContactAuthResult): FlowEvent {
  const reason = reasonSlug(result.reason);
  const failed = result.outcome === "error";
  const unidentified = result.outcome === "no_identity";
  return {
    stage: "contact_auth",
    level: failed || unidentified ? "warn" : "info",
    status: failed ? "error" : unidentified ? "skipped" : "ok",
    detail: {
      outcome: result.outcome,
      shared: result.shared,
      ...(result.status !== undefined ? { status: result.status } : {}),
      ...(reason ? { reason } : {}),
    },
    ...(failed
      ? {
          errorMessage: `contact authorization check failed (${
            result.status !== undefined ? `HTTP ${result.status}` : reason
          })`,
        }
      : {}),
  };
}
