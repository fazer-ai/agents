import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import type { FlowEvent } from "@/modules/flowlog/service";
import {
  type InjectableCredential,
  resolveInjectableCredentialEntry,
} from "@/modules/vault/injectable";
import {
  contactAuthCacheKey,
  ERROR_TTL_MS,
  readCachedVerdict,
  type StoredVerdict,
  singleFlight,
  storeVerdict,
} from "./cache";
import {
  type CheckDeps,
  type ContactAuthOutcome,
  checkContactAuthorization,
  reasonSlug,
} from "./check";
import type { ContactAuthConfig } from "./settings";

// The contact authorization check as the runtime calls it: identity from the mirrored contact,
// credential from the vault, one request per contact per TTL (cache + single-flight), and a verdict
// the two callers (the webhook gate, the proactive nudge) act on the same way. The DB reads here
// are short and scoped; the network call runs outside any transaction (docs/tenancy.md, rule 3).

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export type { ContactAuthOutcome } from "./check";

export interface ContactAuthResult extends StoredVerdict {
  // True when this verdict was not asked for by this call: a cache hit, or a concurrent call that
  // was coalesced into another's request. The gate acts (message, handoff, note) only on a fresh
  // verdict, so a contact who writes three times in a row is told once.
  cached: boolean;
}

export interface AuthorizeContactParams {
  tenantId: bigint;
  agentId: bigint;
  // Our Contact row id (Conversation.contactId). null = the conversation has no mirrored contact.
  contactDbId: bigint | null;
  conversationId: number;
  // The Chatwoot inbox id, for the POST body. null when unknown.
  inboxId: number | null;
  cfg: ContactAuthConfig;
  base?: PrismaClient;
  fetchImpl?: typeof fetch;
  assertSafe?: CheckDeps["assertSafe"];
  // Injectable clock for the cache (tests).
  now?: () => number;
}

// How long a verdict is kept. An error is remembered briefly whatever the agent's TTL says: the
// next message after the short window has to retry, or an outage of the endpoint would silence a
// contact for the whole configured TTL.
function ttlMsFor(outcome: ContactAuthOutcome, cfg: ContactAuthConfig): number {
  return outcome === "error" ? ERROR_TTL_MS : cfg.cacheTtlSeconds * 1000;
}

export async function authorizeContact(
  params: AuthorizeContactParams,
): Promise<ContactAuthResult> {
  const base = params.base ?? basePrisma;
  const now = params.now ?? Date.now;
  const { tenantId, agentId, cfg } = params;
  if (params.contactDbId === null) {
    return { outcome: "no_identity", cached: false, reason: "no_contact" };
  }
  const contactDbId = params.contactDbId;
  const key = contactAuthCacheKey(tenantId, agentId, contactDbId);
  const hit = readCachedVerdict(key, now());
  if (hit) return { ...hit, cached: true };

  const { verdict, shared } = await singleFlight(key, async () => {
    const remember = (v: StoredVerdict): StoredVerdict => {
      storeVerdict(key, v, ttlMsFor(v.outcome, cfg), now());
      return v;
    };
    // NOTE: Read inside the single-flight, so a burst resolves the identity once too. The phone is
    // what Chatwoot mirrored for the contact; nothing the customer typed can stand in for it.
    const contact = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.contact.findUnique({
        where: { id: contactDbId },
        select: { phone: true, chatwootContactId: true },
      }),
    );
    const phone = contact?.phone?.trim() ?? "";
    if (!phone) return remember({ outcome: "no_identity", reason: "no_phone" });
    if (!cfg.url)
      return remember({ outcome: "error", reason: "not_configured" });
    let credential: InjectableCredential | null = null;
    if (cfg.credentialRef) {
      try {
        // NOTE: Outside any tx: a managed-OAuth entry may refresh its token here.
        credential = await resolveInjectableCredentialEntry(
          base,
          tenantId,
          cfg.credentialRef,
        );
      } catch (err) {
        logger.warn(
          "contact-auth: credential resolution failed (agent=%s): %s",
          String(agentId),
          err instanceof Error ? err.message : String(err),
        );
      }
      // A missing, pending or unreadable credential is an error, not a request without it: the
      // endpoint would answer 401 and the gate would read that as "denied", telling the customer
      // they are not registered because of a key the operator has not filled in.
      if (!credential) {
        return remember({ outcome: "error", reason: "credential_unavailable" });
      }
    }
    return remember(
      await checkContactAuthorization(
        cfg,
        {
          phone,
          contactId: contact?.chatwootContactId ?? null,
          conversationId: params.conversationId,
          inboxId: params.inboxId,
        },
        credential,
        { fetchImpl: params.fetchImpl, assertSafe: params.assertSafe },
      ),
    );
  });
  return { ...verdict, cached: shared };
}

// The execution-log line for a verdict. `detail` is PII-free by construction: an outcome enum, a
// boolean, an HTTP status and a reason that passed the slug guard (prose from the endpoint never
// gets this far, but the guard runs again here because this is the write). A denial is ordinary
// operation (info); a check that could not run, or a contact that could not be asked about, is
// something the operator should hear (warn, so alert channels fire on inbox traffic).
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
      cached: result.cached,
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
