import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { mirroredContactIdentifier } from "@/modules/chatwoot/contact-identifier";
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
import {
  evaluateContactAuthRule,
  type RuleFacts,
  ruleReadsConversation,
} from "./rule";
import {
  type ContactAuthConfig,
  type ContactAuthRule,
  contactAuthHasEndpointStage,
} from "./settings";
import { contactAuthFlightKey, singleFlight } from "./state";

// The contact authorization check as the runtime calls it: identity from the mirrored contact,
// credential from the vault, one request per incoming message (single-flight coalesces concurrent
// deliveries), and one verdict the four callers act on the same way. The network call runs outside
// any transaction (docs/tenancy.md, rule 3). Under `mode: "once"` a positive verdict is stored and
// reused (grants.ts), and the reuse lives HERE so no caller can disagree about when it applies.

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
  // Our Conversation row id, for a local rule over the conversation's mirrored attributes. null =
  // the caller has none, and a conversation-scoped rule then reads an empty bag (refuses). REQUIRED
  // and nullable, so a new caller is asked the question by the compiler instead of silently refusing
  // every conversation-scoped rule.
  conversationDbId: bigint | null;
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
  // Which half of the gate this call is (docs/contact-auth.md, Two stages). `rule` answers from the
  // rule alone and is what a caller asks FIRST, before any other pre-turn gate; with no rule set it
  // allows, since there is nothing to refuse at that position. `endpoint` skips the rule, for the
  // caller that already asked it at the first position, and allows when the agent has a rule and no
  // endpoint stage. `both` is the whole gate in one call, for the callers that ask it at one place
  // only (the media pass). REQUIRED, so a new caller says which one it is.
  stage: ContactAuthStage;
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

function bagOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export { RULE_NOT_LISTED, RULE_UNMET } from "./rule";

const NO_CONVERSATION_FACTS = {
  conversationType: null,
  labels: [],
  conversationAttributes: {},
} as const;

// What a rule reads from the conversation row, in one indexed read. A caller with no row (null id)
// gets the empty facts, under which every conversation condition is unmet.
async function ruleFacts(
  base: PrismaClient,
  tenantId: bigint,
  conversationDbId: bigint | null,
  contactFacts: Pick<RuleFacts, "phone" | "identifier" | "contactAttributes">,
): Promise<RuleFacts> {
  const conv =
    conversationDbId === null
      ? null
      : await runScopedOn(base, sysCtx(tenantId), (db) =>
          db.conversation.findFirst({
            where: { id: conversationDbId },
            select: {
              customAttributes: true,
              conversationType: true,
              labels: true,
            },
          }),
        );
  const type = conv?.conversationType;
  return {
    ...contactFacts,
    conversationType: type === "group" || type === "individual" ? type : null,
    labels: conv?.labels ?? [],
    conversationAttributes: bagOf(conv?.customAttributes),
  };
}

// The rule stage's verdict, the one place it is decided. Only a plain allowlist waits for the identity
// check: every other rule reads facts a contact with no phone or email still has (a group, a label, a
// marked conversation), which is the whole point of reading them. No grant is read, written or
// dropped: a rule reads our own rows every message, and a stored verdict would only make an edit take
// effect late.
async function ruleVerdict(
  rule: ContactAuthRule,
  at: {
    base: PrismaClient;
    tenantId: bigint;
    conversationDbId: bigint | null;
    phone: string | null;
    email: string | null;
    identifier: string | null;
    contactAttributes: Record<string, unknown>;
  },
): Promise<ContactAuthVerdict> {
  if (rule.kind !== "allowlist") {
    return evaluateContactAuthRule(
      rule,
      await ruleFacts(at.base, at.tenantId, at.conversationDbId, {
        phone: at.phone,
        identifier: at.identifier,
        contactAttributes: at.contactAttributes,
      }),
    );
  }
  // NOTE: The Chatwoot contact id alone is NOT identity, for the list as for the endpoint.
  if (!at.phone && !at.email && !at.identifier) {
    return { outcome: "no_identity", reason: "no_identifiers" };
  }
  // The list compares the phone and the identifier. A contact that has only an email has something
  // an endpoint could ask about, and nothing this list can match: refused as not listed.
  return evaluateContactAuthRule(rule, {
    ...NO_CONVERSATION_FACTS,
    phone: at.phone,
    identifier: at.identifier,
    contactAttributes: {},
  });
}

export type ContactAuthStage = "rule" | "endpoint" | "both";

export async function authorizeContact(
  params: AuthorizeContactParams,
): Promise<ContactAuthResult> {
  const base = params.base ?? basePrisma;
  const { tenantId, agentId, cfg } = params;
  if (params.contactDbId === null) {
    return { outcome: "no_identity", shared: false, reason: "no_contact" };
  }
  const contactDbId = params.contactDbId;
  const { stage } = params;
  const rule = stage === "endpoint" ? null : cfg.rule;
  const askEndpoint = stage !== "rule" && contactAuthHasEndpointStage(cfg);
  // Read inside each flight, so a burst resolves the identity once too. Everything under `contact` is
  // what Chatwoot mirrored; nothing the customer typed can stand in for it.
  const readContact = () =>
    runScopedOn(base, sysCtx(tenantId), (db) =>
      db.contact.findUnique({
        where: { id: contactDbId },
        select: {
          phone: true,
          name: true,
          email: true,
          chatwootContactId: true,
          attributes: true,
          customAttributes: true,
        },
      }),
    );
  // NOTE: a local rule answers in its own flight, and a refusal there never reaches the endpoint. No
  // grant is read, written or dropped: a rule reads our own rows every message, and a stored verdict
  // would only make an edit take effect late.
  if (rule) {
    // A conversation-scoped rule answers about the CONVERSATION, so two conversations of one contact
    // are two questions: sharing a flight would hand the marked one's allow to the unmarked one.
    const conversationScoped = ruleReadsConversation(rule);
    const asking = `${params.requestKey}:rule`;
    const ruled = await singleFlight(
      contactAuthFlightKey(
        tenantId,
        agentId,
        contactDbId,
        conversationScoped
          ? `${asking}:conv:${params.conversationDbId ?? "none"}`
          : asking,
      ),
      async (): Promise<ContactAuthVerdict> => {
        const contact = await readContact();
        return ruleVerdict(rule, {
          base,
          tenantId,
          conversationDbId: conversationScoped ? params.conversationDbId : null,
          phone: trimmed(contact?.phone),
          email: trimmed(contact?.email),
          identifier: mirroredContactIdentifier(contact?.attributes),
          contactAttributes: bagOf(contact?.customAttributes),
        });
      },
    );
    // A refusal is the gate's answer whatever comes after, and so is an allow with no endpoint stage
    // to hand it to.
    if (ruled.verdict.outcome !== "allowed" || !askEndpoint) {
      return { ...ruled.verdict, stage: "rule", shared: ruled.shared };
    }
  }
  // The rule position asked with no rule set: nothing to refuse here, and the endpoint stage, if the
  // agent has one, answers at its own position.
  if (!askEndpoint) return { outcome: "allowed", stage: "rule", shared: false };
  // The endpoint's flight is keyed by the asking alone, whichever stage the caller named: the webhook
  // at the endpoint position and the media pass asking the whole gate put the same question to the
  // operator's endpoint, and two flights would send it twice.
  const { verdict, shared } = await singleFlight(
    contactAuthFlightKey(tenantId, agentId, contactDbId, params.requestKey),
    async (): Promise<ContactAuthVerdict> => {
      const contact = await readContact();
      const phone = trimmed(contact?.phone);
      const email = trimmed(contact?.email);
      const identifier = mirroredContactIdentifier(contact?.attributes);
      const endpointVerdict = (v: ContactAuthVerdict): ContactAuthVerdict => ({
        ...v,
        stage: "endpoint",
      });
      // NOTE: The Chatwoot contact id alone is NOT identity: it names the row to us and says
      // nothing to the operator's system. Without a phone, an email or an operator identifier
      // there is nothing to ask about.
      if (!phone && !email && !identifier) {
        return endpointVerdict({
          outcome: "no_identity",
          reason: "no_identifiers",
        });
      }
      if (!cfg.url) {
        return endpointVerdict({ outcome: "error", reason: "not_configured" });
      }
      // The stored verdict, read after the identity (a grant is about the identity the mirror
      // holds now) and before the credential, so a reuse costs neither the vault read nor a
      // managed-OAuth refresh.
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
          if (stored) return endpointVerdict(reusedVerdict(stored.context));
        }
        let credential: InjectableCredential | null = null;
        if (cfg.credentialRef) {
          let timedOut = false;
          try {
            // Outside any tx: a managed-OAuth entry may refresh its token here. Under the
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
          if (timedOut) {
            return endpointVerdict({ outcome: "error", reason: "timeout" });
          }
          // A missing, pending or unreadable credential is an error, not a request without it: the
          // endpoint would answer 401 and the gate would read that as "denied", telling the customer
          // they are not registered because of a key the operator has not filled in.
          if (!credential) {
            return endpointVerdict({
              outcome: "error",
              reason: "credential_unavailable",
            });
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
            return endpointVerdict({
              outcome: "error",
              reason: "credential_not_injectable",
            });
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
        // NOTE: only `once` grants; every mode un-grants. The mode is not in the policy fingerprint,
        // so grants survive a switch to `perMessage`; dropping only under `once` would let a contact be
        // served, after switching back inside the TTL, from an allow older than a refusal. An error
        // stores and drops nothing: it is transient, and a blip must not cost a legitimate verdict.
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
        return endpointVerdict(verdict);
      } finally {
        clearTimeout(timer);
      }
    },
  );
  return { ...verdict, shared };
}

// The execution-log line for a verdict. `detail` carries only an outcome enum, a boolean, an HTTP
// status and OUR OWN reason code. The endpoint's reason is absent: the slug guard checks shape and
// `5511999999999` is slug-shaped, so it would put a phone in alert-channel data; it goes to the
// operator note instead. The customer's text never leaves the endpoint request. A denial is info; a
// check that could not run or a contact that could not be asked about is warn, so alerts fire.
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
      // Which stage answered: with both configured, an allow at the rule is not on the line (the
      // endpoint's verdict is), so a reader can tell "the rule refused" from "the endpoint refused"
      // without knowing the reason codes.
      ...(result.stage ? { stage: result.stage } : {}),
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
