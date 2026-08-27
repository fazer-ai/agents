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
  type AuthContext,
  type CheckDeps,
  type ContactAuthVerdict,
  channelSlug,
  checkContactAuthorization,
  reasonSlug,
  underSignal,
} from "./check";
import {
  contactAuthIdentityHash,
  contactAuthPolicyHash,
  dropContactAuthGrant,
  readContactAuthGrant,
  readCredentialStamp,
  retryUnconfirmedWrite,
  writeContactAuthGrant,
} from "./grants";
import type { ContactAuthConfig } from "./settings";
import { contactAuthFlightKey, singleFlight } from "./state";

// The contact authorization check as the runtime calls it: identity from the mirrored contact,
// credential from the vault, one request per incoming message (single-flight coalesces concurrent
// deliveries), and a verdict the four callers (the webhook gate, the debounce flush, the proactive
// nudge, the manual re-engage) act on the same way. The DB reads here are short and scoped; the
// network call runs outside any transaction (docs/tenancy.md, rule 3).
//
// Under the default mode nothing is cached, so the endpoint's answer is always current. Under
// `mode: "once"` a positive verdict is stored per contact and reused until it expires (issue #189,
// grants.ts) — the reuse lives HERE, in the one function all four callers already go through, so no
// caller has to remember it and none of them can disagree about when a stored verdict applies.

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

// A verdict served from a stored grant carries the same outcome and the same facts as the ask that
// produced it, so every caller acts on it exactly as before. What `reused` adds is the operator's
// half: the flow line has to be able to say "the endpoint allowed this" apart from "we did not ask",
// or a trail of allows looks like a trail of calls the endpoint never received.
function reusedVerdict(context: AuthContext | null): ContactAuthVerdict {
  return {
    outcome: "allowed",
    reused: true,
    ...(context ? { context } : {}),
  };
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
      // The stored verdict, when the operator asked for one (issue #189). Read here rather than
      // before the identity, because what a grant is ABOUT is the identity the mirror holds right
      // now: a contact whose phone changed since is not necessarily the person the endpoint said
      // yes to. Read before the credential too, so a reuse costs neither the vault round-trip nor
      // the managed-OAuth refresh that a real ask would.
      const grantKey = { tenantId, agentId, contactId: contactDbId };
      // The deadline starts HERE, before the first step that can wait. The credential is resolved
      // under it because a managed-OAuth entry refreshes its token to produce it — a network call
      // with a ten-second ceiling of its own — and the stored-verdict read is under it because a
      // saturated pool is exactly as capable of holding the webhook as a slow endpoint is. Timed
      // from the request instead, a gate configured for one second could hold the webhook for
      // eleven, while `timeoutMs` promises to cover every step that waits. From this line to the
      // answer is one budget, and the grant bookkeeping after the answer is inside it too.
      const ctrl = new AbortController();
      const askedAt = Date.now();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
      try {
        // A bookkeeping write this process could not confirm, settled by deleting. Under BOTH
        // modes: the refusal that failed to land usually happened under `perMessage`, which reads no
        // grants, so a retry that lived on the read path would never run for the mode that needs it.
        await retryUnconfirmedWrite(base, grantKey, ctrl.signal);
        // The credential's own revision is part of the policy a grant is written under, so it is
        // read at the START of the check and the same value is used to look a grant up and to store
        // one. Read once here rather than twice: taken again after the endpoint answered, a rotation
        // landing in between would be written into the fingerprint of a verdict obtained before it.
        // Only under `once`, and only when there is a credential at all — `perMessage` neither reads
        // nor writes grants, so it would be paying for a fingerprint nobody builds.
        const credentialStamp =
          cfg.mode === "once"
            ? await readCredentialStamp(
                base,
                tenantId,
                cfg.credentialRef,
                ctrl.signal,
              )
            : ({ ok: true, stamp: null } as const);
        // A revision nobody could read is not a revision: without it there is no fingerprint that
        // can be trusted to change when the credential does, so this check neither reads a stored
        // verdict nor writes one. It costs an endpoint call, which is the fail-closed direction.
        const grantsUsable = cfg.mode === "once" && credentialStamp.ok;
        const fingerprints = {
          identityHash: contactAuthIdentityHash({ phone, email, identifier }),
          policyHash: contactAuthPolicyHash(
            cfg,
            credentialStamp.ok ? credentialStamp.stamp : null,
          ),
        };
        if (grantsUsable) {
          const stored = await readContactAuthGrant(
            base,
            grantKey,
            fingerprints,
            { signal: ctrl.signal },
          );
          if (stored) return reusedVerdict(stored.context);
        }
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
        const verdict = await checkContactAuthorization(
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
        // ONLY `once` GRANTS; EVERY MODE UN-GRANTS. The asymmetry is the rule, not an oversight:
        // the mode decides who READS a grant, and it is deliberately not part of the policy
        // fingerprint, so grants written under `once` survive a switch to `perMessage`. Dropping
        // only under `once` left a round trip open — grant, switch to `perMessage`, the endpoint
        // starts refusing, switch back inside the TTL, and the contact is served from an allow
        // older than the refusal. The cost on the other side is one indexed DELETE of nothing per
        // refusal under the default mode, which is what the rule is worth.
        //
        // An error stores and drops nothing: it is transient by contract (the next message
        // retries), and a blip of the endpoint must not cost a contact the verdict they were
        // legitimately given.
        if (verdict.outcome === "denied") {
          // Stamped with the instant this check STARTED, not with the instant the delete lands: what
          // orders a concurrent allow against this refusal is when each was asked, and a retry that
          // finally lands minutes later must not read as a refusal from minutes later.
          await dropContactAuthGrant(base, grantKey, { refusedAt: askedAt });
        } else if (grantsUsable && verdict.outcome === "allowed") {
          await writeContactAuthGrant(
            base,
            grantKey,
            {
              ...fingerprints,
              context: verdict.context,
              ttlSeconds: cfg.grantTtlSeconds,
            },
            // `askedAt` is what makes this allow refusable: a refusal asked for while this check
            // was in flight is newer than it, however late either answer arrived.
            { askedAt },
          );
        }
        return verdict;
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
      // Only when true: the ordinary line is an ask, and a key on every line to say "this was the
      // ordinary case" is a key readers learn to skip.
      ...(result.reused ? { reused: true } : {}),
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
