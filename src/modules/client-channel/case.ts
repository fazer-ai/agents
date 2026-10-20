// Escalation on the client channel: nobody from the team answers in the host's chat, so the agent
// opens the user's request as a case in the team's inbox (`open_case_in_inbox`, the agent's
// `crossInboxCase` config) and the team replies through that inbox's own channel. The contact the
// case goes to comes from what the host stated about its user (docs/client-channel.md, "Escalation").

import type { BaseMessage } from "@langchain/core/messages";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { getCheckpointer } from "@/graph/checkpointer";
import type { AgentConfig } from "@/graph/prepare";
import type { ToolCtx } from "@/graph/tools/native";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  ChatwootApiError,
  type ChatwootClient,
} from "@/modules/chatwoot/client";
import { loadChatwootClient } from "@/modules/chatwoot/instance";
import { isAnonUserId } from "@/modules/client-apps/anonymous";
import { customerTyped } from "@/modules/cross-inbox-case/service";
import { pinnedHandoffTarget } from "@/modules/handoff/settings";
import { consoleUrl } from "@/modules/mcp/console-links";
import { withoutScreenContext } from "./screen-context";

export type CaseContactClient = Pick<
  ChatwootClient,
  | "findContactIdByEmail"
  | "findContactIdByIdentifier"
  | "createContact"
  | "getContact"
  | "updateContact"
  | "setContactCustomAttributes"
>;

// The contact attribute that marks an address nobody verified: one an anonymous visitor typed.
export const UNVERIFIED_EMAIL_ATTRIBUTE = "email_unverified";

// The contact a case goes to, and whether its address was changed now to reach the user (see
// OpenCaseInput.freshCase).
export interface CaseContact {
  id: number;
  addressUpdated: boolean;
}

export interface CaseContactUser {
  id: bigint;
  name: string | null;
  email: string;
}

// The Chatwoot contact a case is opened for. Ours by identifier when a case was opened for this
// user before, carrying the email the host states now (see `reconcile`); else the contact that
// already holds that email (a customer the team knows); else a new one. A 422 on the create is
// another contact holding the email or the identifier (a concurrent create included), and that one
// is the answer.
export async function resolveCaseContact(
  client: CaseContactClient,
  user: CaseContactUser,
): Promise<CaseContact> {
  const resolved = await resolveSignedInContact(client, user);
  await releaseFromAnonymous(client, resolved.id);
  return resolved;
}

async function resolveSignedInContact(
  client: CaseContactClient,
  user: CaseContactUser,
): Promise<CaseContact> {
  const identifier = caseContactIdentifier(user.id);
  const ours = await client.findContactIdByIdentifier(identifier);
  if (ours !== null) return reconcile(client, ours, user);
  const known = await client.findContactIdByEmail(user.email);
  if (known !== null) return { id: known, addressUpdated: false };
  try {
    const id = await client.createContact({
      name: user.name,
      email: user.email,
      identifier,
    });
    return { id, addressUpdated: false };
  } catch (err) {
    if (!(err instanceof ChatwootApiError && err.status === 422)) throw err;
    const held =
      (await client.findContactIdByIdentifier(identifier)) ??
      (await client.findContactIdByEmail(user.email));
    if (held === null) throw err;
    return reconcile(client, held, user);
  }
}

// Our contact carries the email the host states now: the team's email replies go to the contact's
// address, so an old one would answer someone the host no longer names. An email another contact
// already holds is a customer the team knows, and the case goes to that contact instead.
async function reconcile(
  client: CaseContactClient,
  contactId: number,
  user: CaseContactUser,
): Promise<CaseContact> {
  const current = await client.getContact(contactId);
  if (current?.email?.toLowerCase() === user.email.toLowerCase())
    return { id: contactId, addressUpdated: false };
  try {
    await client.updateContact(contactId, { email: user.email });
    return { id: contactId, addressUpdated: true };
  } catch (err) {
    if (!(err instanceof ChatwootApiError && err.status === 422)) throw err;
    const holder = await client.findContactIdByEmail(user.email);
    if (holder === null) throw err;
    return { id: holder, addressUpdated: false };
  }
}

// What an anonymous visitor's contact is keyed by: the visitor AND the address, so an anonymous call
// never changes a contact's address (a new address is a new contact). A signed-in user's resolution
// that takes such a contact clears the key (`releaseFromAnonymous`), so the visitor loses it.
const ANONYMOUS_IDENTIFIER_PREFIX = "fazer-ai-client-anon:";

export function anonymousCaseContactIdentifier(
  externalUserId: bigint,
  email: string,
): string {
  return `${ANONYMOUS_IDENTIFIER_PREFIX}${externalUserId}:${email.toLowerCase()}`;
}

// The contact a case is opened for from an anonymous visitor, with the address they typed. Only the
// contact this visitor created for this address, found by its key and never by the address: nobody
// proved the address is theirs, so a contact that holds it otherwise is a person the team knows, and
// the answer is "held" rather than that person's contact. Chatwoot keeps one contact per address, so
// a held address cannot get a contact of its own either. Nothing here writes to an existing contact
// but the unverified mark.
export async function resolveAnonymousCaseContact(
  client: CaseContactClient,
  user: { id: bigint; email: string },
): Promise<CaseContact | "held"> {
  const identifier = anonymousCaseContactIdentifier(user.id, user.email);
  const mark = async (id: number) => {
    await client
      .setContactCustomAttributes(id, { [UNVERIFIED_EMAIL_ATTRIBUTE]: true })
      .catch((err) =>
        logger.warn(
          { err, contactId: id },
          "client channel: an anonymous case's contact could not be marked as unverified",
        ),
      );
  };
  // Whether the contact is still this visitor's for this address: "released" when the key on the
  // contact itself is gone (a signed-in user's resolution elsewhere took it, which the search hit
  // alone does not show), "moved" when the team changed its address, the key still on it.
  const standing = async (id: number) => {
    const current = await client.getContact(id);
    if (current?.identifier !== identifier) return "released";
    return current.email?.toLowerCase() === user.email.toLowerCase()
      ? "ours"
      : "moved";
  };
  // Marks the contact and hands it over only if it is still ours afterwards. A release while we
  // marked it leaves the mark to the signed-in user to lose, not to us to leave; a contact the team
  // moved to another address is still an anonymous one, and keeps it.
  const claim = async (id: number): Promise<CaseContact | "held"> => {
    await mark(id);
    const after = await standing(id);
    if (after === "ours") return { id, addressUpdated: false };
    if (after === "released")
      await client.setContactCustomAttributes(id, {
        [UNVERIFIED_EMAIL_ATTRIBUTE]: false,
      });
    return "held";
  };
  const own = async (): Promise<CaseContact | "held" | null> => {
    const id = await client.findContactIdByIdentifier(identifier);
    if (id === null) return null;
    if ((await standing(id)) !== "ours") return "held";
    return claim(id);
  };
  const found = await own();
  if (found !== null) return found;
  if ((await client.findContactIdByEmail(user.email)) !== null) return "held";
  try {
    return claim(await client.createContact({ email: user.email, identifier }));
  } catch (err) {
    if (!(err instanceof ChatwootApiError && err.status === 422)) throw err;
    return (await own()) ?? "held";
  }
}

// A signed-in user's resolution took a contact an anonymous visitor created: the visitor's key and
// the unverified mark go, so the visitor can no longer reach it. Not swallowed, since the case must
// not open on a contact the visitor still holds; a mark still set is cleared on the next call even
// when the key already went, so a release that failed halfway finishes on retry.
async function releaseFromAnonymous(
  client: CaseContactClient,
  contactId: number,
): Promise<void> {
  const current = await client.getContact(contactId);
  const keyed = current?.identifier?.startsWith(ANONYMOUS_IDENTIFIER_PREFIX);
  const marked =
    current?.customAttributes?.[UNVERIFIED_EMAIL_ATTRIBUTE] === true;
  if (!keyed && !marked) return;
  if (keyed) await client.updateContact(contactId, { identifier: null });
  await client.setContactCustomAttributes(contactId, {
    [UNVERIFIED_EMAIL_ATTRIBUTE]: false,
  });
}

// Whether the visitor wrote this address, whole, in their own words: the message of the turn being
// answered (handed in, since the checkpoint may not hold it yet when the tool runs) or an earlier one
// on the thread, each without the screen context the page sent with it. An anonymous visitor's
// address reaches the tool through the model, so it is opened with only when the visitor typed it.
export async function userTypedOnThread(
  checkpointer: Pick<BaseCheckpointSaver, "get">,
  threadId: string,
  email: string,
  currentMessage?: string,
): Promise<boolean> {
  if (currentMessage !== undefined && customerTyped([currentMessage], email))
    return true;
  const checkpoint = await checkpointer.get({
    configurable: { thread_id: threadId },
  });
  const messages =
    (checkpoint?.channel_values as { messages?: BaseMessage[] } | undefined)
      ?.messages ?? [];
  return customerTyped(
    messages
      .filter((m) => m.getType() === "human")
      .map((m) => withoutScreenContext(messageText(m.content))),
    email,
  );
}

function messageText(content: BaseMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      typeof part === "object" && part && "text" in part
        ? String((part as { text: unknown }).text)
        : "",
    )
    .join(" ");
}

export function caseContactIdentifier(externalUserId: bigint): string {
  return `fazer-ai-client:${externalUserId}`;
}

// A case answers to the address it was opened with: the thread's case recorded under another address
// (changed on an earlier call whose opening then failed, say) is not added to.
async function recordedUnder(
  base: PrismaClient,
  ctx: TenantContext,
  threadId: string,
  email: string,
): Promise<boolean> {
  const row = await runScopedOn(base, ctx, (db) =>
    db.detachedThread.findUnique({
      where: { threadId },
      select: { caseConversationId: true, caseEmail: true },
    }),
  );
  return (
    row?.caseConversationId != null &&
    row.caseEmail?.toLowerCase() !== email.toLowerCase()
  );
}

type Detached = NonNullable<NonNullable<ToolCtx["crossInboxCase"]>["detached"]>;

// What `open_case_in_inbox` needs on this thread, or null when the agent has no destination inbox or
// its account cannot be reached; null leaves the tool out of the turn, since a tool that can only
// fail costs the model a round and the user a broken promise. The instance is the one the operator
// picked the inbox from; a config written without it is honored on a tenant with a single account.
export async function detachedCaseFor(params: {
  ctx: TenantContext;
  base: PrismaClient;
  loaded: AgentConfig;
  threadId: string;
  externalUserId: bigint;
  turnId: string;
  loadClient?: (
    tenantId: bigint,
    instanceId: bigint,
  ) => Promise<ChatwootClient>;
  checkpointer?: Pick<BaseCheckpointSaver, "get">;
  // The user's own words in this turn, without the screen context; absent on a resumed round-trip.
  currentMessage?: string;
}): Promise<Detached | null> {
  const { ctx, base, loaded, threadId, externalUserId } = params;
  const tenantId = ctx.tenantId as bigint;
  const cfg = loaded.crossInboxCaseConfig;
  if (cfg.targetInboxId == null) return null;
  // Read from the tenant's own connected accounts, so a config naming another tenant's or a
  // disconnected account offers nothing.
  const instances = await runScopedOn(base, ctx, (db) =>
    db.chatwootInstance.findMany({
      where: { disconnectedAt: null },
      select: { id: true },
    }),
  );
  const instance =
    cfg.targetInstanceId != null
      ? instances.find((i) => Number(i.id) === cfg.targetInstanceId)
      : instances.length === 1
        ? instances[0]
        : undefined;
  if (!instance) return null;
  const instanceId = instance.id;
  let client: ChatwootClient;
  try {
    client = await (
      params.loadClient ?? ((t, i) => loadChatwootClient(t, i, { base }))
    )(tenantId, instanceId);
  } catch (err) {
    logger.warn(
      { err, threadId },
      "client channel: the case inbox's account could not be loaded; open_case_in_inbox not offered",
    );
    return null;
  }
  const pinned = pinnedHandoffTarget(loaded.handoffConfig, instanceId);
  // An anonymous visitor has no address from a host: the case goes to the one they type here.
  const anonymous = isAnonUserId(
    (
      await runScopedOn(base, ctx, (db) =>
        db.externalUser.findUniqueOrThrow({
          where: { id: externalUserId },
          select: { externalId: true },
        }),
      )
    ).externalId,
  );
  // The address the contact resolved to on this call, recorded with the case it opens.
  let currentEmail: string | null = null;
  return {
    client,
    caseTeamId: pinned?.kind === "team" ? pinned.id : null,
    // NOTE: per account, not per person: two people of the host can resolve to one Chatwoot
    // contact (a shared email), and escalations are rare enough for one queue to cost nothing.
    serialKey: `client-case:${instanceId}`,
    anonymous,
    userTyped: async (email) =>
      userTypedOnThread(
        params.checkpointer ?? (await getCheckpointer()),
        threadId,
        email,
        params.currentMessage,
      ),
    contact: async (typed) => {
      if (anonymous) {
        if (!typed) return null;
        currentEmail = typed;
        const resolved = await resolveAnonymousCaseContact(client, {
          id: externalUserId,
          email: typed,
        });
        if (resolved === "held") return "held";
        return {
          id: resolved.id,
          addressUpdated:
            resolved.addressUpdated ||
            (await recordedUnder(base, ctx, threadId, typed)),
          email: typed,
        };
      }
      const user = await runScopedOn(base, ctx, (db) =>
        db.externalUser.findUniqueOrThrow({
          where: { id: externalUserId },
          select: { id: true, name: true, email: true },
        }),
      );
      const email = user.email;
      if (!email) return null;
      currentEmail = email;
      // Serialized by the tool per person and account (`serialKey`); the 422 recovery covers a
      // concurrent create from another process.
      const resolved = await resolveCaseContact(client, {
        id: user.id,
        name: user.name,
        email,
      });
      return {
        id: resolved.id,
        addressUpdated:
          resolved.addressUpdated ||
          (await recordedUnder(base, ctx, threadId, email)),
        email,
      };
    },
    origin: {
      key: `client-thread:${threadId}`,
      url: consoleUrl(
        `/logs?${new URLSearchParams({ turnId: params.turnId, source: "all" })}`,
        { tenantId },
      ),
      knownCaseId: async () => {
        const row = await runScopedOn(base, ctx, (db) =>
          db.detachedThread.findUnique({
            where: { threadId },
            select: { caseInstanceId: true, caseConversationId: true },
          }),
        );
        return row?.caseInstanceId === instanceId
          ? (row.caseConversationId ?? null)
          : null;
      },
      recordCase: async (caseId) => {
        await runScopedOn(base, ctx, (db) =>
          db.detachedThread.update({
            where: { threadId },
            data: {
              caseInstanceId: instanceId,
              caseConversationId: caseId,
              caseEmail: currentEmail,
            },
          }),
        );
      },
    },
  };
}
