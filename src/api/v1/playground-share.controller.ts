import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { AppError } from "@/lib/errors";
import { runPlaygroundTurn } from "@/modules/playground/service";
import {
  claimPlaygroundShareLinkMessage,
  resolvePlaygroundShareLink,
} from "@/modules/playground/share";
import {
  isValidPlaygroundThread,
  newPlaygroundThreadId,
} from "@/modules/playground/thread";

interface ResolvedLink {
  id: bigint;
  tenantId: bigint;
  agentId: bigint;
  agentName: string;
}

// Public, no-login playground share link: an operator-minted link a customer can open to chat
// with an agent (isolated thread, no Chatwoot side effects). Not behind tenancyPlugin — the
// opaque token resolves the tenant. "not_found" and "expired" collapse into one generic message
// (no token-enumeration signal, same principle as the inbound receptor's UnauthorizedError);
// "exhausted" is surfaced distinctly since it's a legitimate state for a valid link.
async function resolveOrThrow(token: string): Promise<ResolvedLink> {
  const resolved = await resolvePlaygroundShareLink(token);
  if (resolved.status === "exhausted")
    throw new AppError(
      "This chat link has reached its message limit",
      429,
      "errors.playgroundShareLinkExhausted",
    );
  if (resolved.status !== "ok" || !resolved.link)
    throw new AppError(
      "This chat link is invalid or has expired",
      404,
      "errors.playgroundShareLinkInvalid",
    );
  return resolved.link;
}

export const playgroundShareController = new Elysia({
  prefix: "/v1/playground/share",
  tags: ["Agents"],
})
  .get(
    "/:token",
    async ({ params }) => {
      const link = await resolveOrThrow(params.token);
      return { agentName: link.agentName };
    },
    {
      detail: {
        ...doc(
          "Resolve playground share link",
          "Public lookup for a share link: returns the agent's display name if the link is valid, or 404/429 if invalid, expired, or exhausted.",
        ),
        security: [],
      },
      response: errors(404, 429),
      params: t.Object({ token: t.String() }),
    },
  )
  .post(
    "/:token/message",
    async ({ params, body }) => {
      const link = await resolveOrThrow(params.token);
      const claimed = await claimPlaygroundShareLinkMessage(
        link.tenantId,
        link.id,
      );
      if (!claimed)
        throw new AppError(
          "This chat link has reached its message limit",
          429,
          "errors.playgroundShareLinkExhausted",
        );

      const threadId =
        body.threadId &&
        isValidPlaygroundThread(body.threadId, link.tenantId, link.agentId)
          ? body.threadId
          : newPlaygroundThreadId(link.tenantId, link.agentId);

      const result = await runPlaygroundTurn({
        tenantId: link.tenantId,
        agentId: link.agentId,
        message: body.message,
        threadId,
      });
      // Public clients never see internal trace/tool-call details, only the reply.
      return { reply: result.reply, threadId: result.threadId };
    },
    {
      detail: {
        ...doc(
          "Send playground share link message",
          "Public chat turn against the agent bound to this share link. Consumes one message from the link's quota.",
        ),
        security: [],
      },
      response: errors(400, 404, 429),
      params: t.Object({ token: t.String() }),
      body: t.Object({
        message: t.String({ minLength: 1, maxLength: 10_000 }),
        threadId: t.Optional(t.String()),
      }),
    },
  );
