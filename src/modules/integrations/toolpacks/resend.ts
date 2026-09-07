import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { Prisma } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { failableTool, toolFailure } from "@/graph/tools/failure";
import { fetchBounded } from "@/lib/outbound";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  type IntegrationSelection,
  registerToolpack,
  type Toolpack,
  type ToolpackCtx,
  type ToolSpec,
} from "./types";

// Resend (transactional email) OUTBOUND toolpack. The agent sends an email the customer asked for
// (a booking confirmation, a reminder, a follow-up) and can check its delivery status later. We
// record an IntegrationExternalRef keyed by the Resend email id so a future inbound webhook
// (delivered/bounced events) can correlate back to THIS conversation by PK, never by LLM.
//
// Security invariants (mirroring the Asaas hardened spec):
//   - `from` and `reply_to` are bound to the INSTANCE CONFIG, never tool args — a prompt-injection
//     cannot spoof the sender identity of the tenant's verified domain;
//   - the API key (per-tenant, from the vault) flows ONLY into the Authorization header, never the
//     URL / body / model-visible return / trace;
//   - the origin is a fixed constant (never interpolated); SSRF-guarded anyway;
//   - https-only, no redirects, bounded timeout, bounded response read.
//
// NOTE: validated against the official Resend API reference (resend.com/docs, 2026-09):
// `POST /emails` with `Authorization: Bearer re_...` accepts { from, to, subject, html, reply_to }
// and answers `{ id }`; `GET /emails/{id}` answers the email projection with `last_event`
// (queued/delivered/bounced/...). The `from` domain must be verified on the Resend account,
// otherwise the send is rejected — surfaced as the provider refusal below.

const RESEND_ORIGIN = "https://api.resend.com";

const TIMEOUT_MS = 12_000;
const MAX_RESPONSE_CHARS = 2_000;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Bound to config, never a tool arg. A blank/absent `from` fails closed at invoke time (the tool
// tells the model the integration is not configured instead of guessing a sender).
function resolveFrom(config: Record<string, unknown>): string | null {
  const from = typeof config.from === "string" ? config.from.trim() : "";
  return from.length > 0 ? from : null;
}

function resolveReplyTo(config: Record<string, unknown>): string | null {
  const replyTo =
    typeof config.replyTo === "string" ? config.replyTo.trim() : "";
  return replyTo.length > 0 ? replyTo : null;
}

interface ResendResponse {
  status: number;
  json: unknown;
}

async function resendFetch(
  path: string,
  init: { method: string; token: string; body?: unknown },
  ctx: ToolpackCtx,
): Promise<ResendResponse> {
  const url = `${RESEND_ORIGIN}${path}`;
  const assertSafe = ctx.assertSafe ?? assertSafeOutboundUrl;
  await assertSafe(url);
  const doFetch = ctx.fetchImpl ?? fetch;
  const { res, body } = await fetchBounded(
    url,
    {
      method: init.method,
      headers: {
        Authorization: `Bearer ${init.token}`,
        "Content-Type": "application/json",
        "User-Agent": "agents",
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      redirect: "error",
    },
    { timeoutMs: TIMEOUT_MS, cap: MAX_RESPONSE_CHARS, fetchImpl: doFetch },
  );
  let json: unknown = null;
  try {
    json = JSON.parse(body.text);
  } catch {
    // non-JSON body → leave json null; the caller surfaces a generic error
  }
  return { status: res.status, json };
}

// Tool input schemas (single source for both the runtime tool and the UI arg specs).
const EMAIL_SEND_SCHEMA = z.object({
  to: z
    .string()
    .email()
    .describe(
      "Recipient email address, exactly as the customer provided it in the conversation.",
    ),
  subject: z.string().min(1).max(200).describe("Short, clear subject line."),
  html: z
    .string()
    .min(1)
    .max(20_000)
    .describe(
      "Email body as simple HTML (<p>, <a>, <strong>). Plain text is derived automatically.",
    ),
});

const EMAIL_STATUS_SCHEMA = z.object({
  emailId: z
    .string()
    .min(1)
    .max(100)
    .describe("The email id returned by email_send."),
});

const RESEND_TOOL_SPECS: ToolSpec[] = [
  { name: "email_send", schema: EMAIL_SEND_SCHEMA },
  { name: "email_status", schema: EMAIL_STATUS_SCHEMA },
];

function buildSendTool(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): StructuredToolInterface {
  const from = resolveFrom(sel.config);
  const replyTo = resolveReplyTo(sel.config);

  return failableTool(
    async (input: { to: string; subject: string; html: string }) => {
      const token = sel.credentialRef
        ? await ctx.resolveCredential(sel.credentialRef)
        : null;
      if (!token)
        return toolFailure(
          "Resend credential is not configured for this integration.",
        );
      if (!from)
        return toolFailure(
          "The sender address is not configured for this integration (set `from` in the integration settings).",
        );

      const body = {
        from,
        to: input.to,
        subject: input.subject,
        html: input.html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      };

      let res: ResendResponse;
      try {
        res = await resendFetch(
          "/emails",
          { method: "POST", token, body },
          ctx,
        );
      } catch (err) {
        logger.warn({ err }, "resend: email send request failed");
        return toolFailure(
          "Failed to reach the email provider. Try again shortly.",
        );
      }
      if (res.status < 200 || res.status >= 300) {
        logger.warn("resend: email send returned HTTP %s", String(res.status));
        // A 403 on send is almost always an unverified `from` domain — the one misconfiguration
        // the operator can fix, so it deserves a distinct message over the generic refusal.
        if (res.status === 403)
          return toolFailure(
            "The email provider rejected the sender (HTTP 403). The `from` domain is likely not verified on the Resend account.",
          );
        return toolFailure(
          `The email provider rejected the request (HTTP ${res.status}).`,
        );
      }
      const data = (res.json ?? {}) as Record<string, unknown>;
      const emailId = typeof data.id === "string" ? data.id : null;
      if (!emailId) {
        logger.warn("resend: email send response missing id");
        return toolFailure(
          "The email provider returned an unexpected response.",
        );
      }

      // Correlation ref (short scoped write, no network — the send already happened above). Ties a
      // future delivery/bounce webhook back to this thread; orphan on failure → logged, email sent.
      try {
        await runScopedOn(ctx.base, sysCtx(ctx.tenantId), (db) =>
          db.integrationExternalRef.create({
            data: {
              tenantId: ctx.tenantId,
              integrationInstanceId: sel.instanceId,
              externalId: emailId,
              threadId: ctx.threadId,
              kind: "resend_email",
              metadata: { subject: input.subject } as Prisma.InputJsonValue,
            },
          }),
        );
      } catch (err) {
        logger.error(
          { err, emailId },
          "resend: failed to persist correlation ref (orphan email)",
        );
        ctx.onSideEffectError?.({
          tool: "email_send",
          phase: "persist_ref",
          detail: { emailId },
          err,
        });
      }
      return `Email sent to ${input.to}.\n(emailId: ${emailId})`;
    },
    {
      name: "email_send",
      description:
        "Send an email to the customer (booking confirmation, reminder, follow-up). Use ONLY an address the customer provided in the conversation. Body is simple HTML. Returns the emailId — use it with email_status to check delivery.",
      schema: EMAIL_SEND_SCHEMA,
    },
  );
}

function buildStatusTool(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): StructuredToolInterface {
  return failableTool(
    async (input: { emailId: string }) => {
      const token = sel.credentialRef
        ? await ctx.resolveCredential(sel.credentialRef)
        : null;
      if (!token)
        return toolFailure(
          "Resend credential is not configured for this integration.",
        );
      const emailId = input.emailId.trim();
      // Reject pasted URLs/paths outright — Resend ids never contain slashes or colons; letting
      // one through would surface as a confusing 404 from the provider.
      if (/[/:]/.test(emailId))
        return "Provide the emailId returned by email_send, not a URL.";

      let res: ResendResponse;
      try {
        res = await resendFetch(
          `/emails/${encodeURIComponent(emailId)}`,
          { method: "GET", token },
          ctx,
        );
      } catch (err) {
        logger.warn({ err }, "resend: email status request failed");
        return toolFailure("Failed to reach the email provider.");
      }
      if (res.status < 200 || res.status >= 300) {
        if (res.status === 404)
          return "The email provider returned HTTP 404 (email not found). Use the emailId returned by email_send.";
        return toolFailure(`The email provider returned HTTP ${res.status}.`);
      }
      const d = (res.json ?? {}) as Record<string, unknown>;
      // Bounded projection (status-relevant fields only; never the html body back into context).
      return JSON.stringify({
        id: d.id,
        last_event: d.last_event,
        to: d.to,
        subject: d.subject,
        created_at: d.created_at,
      });
    },
    {
      name: "email_status",
      description:
        "Check the delivery status of an email sent with email_send. Pass the emailId it returned. last_event is queued/sent/delivered/bounced/complained.",
      schema: EMAIL_STATUS_SCHEMA,
    },
  );
}

const TOOL_BUILDERS: Record<
  string,
  (sel: IntegrationSelection, ctx: ToolpackCtx) => StructuredToolInterface
> = {
  email_send: buildSendTool,
  email_status: buildStatusTool,
};

export const resendToolpack: Toolpack = {
  catalogType: "RESEND",
  toolSpecs: RESEND_TOOL_SPECS,
  build(sel, ctx) {
    const out: StructuredToolInterface[] = [];
    for (const name of sel.enabledTools) {
      const builder = TOOL_BUILDERS[name];
      if (builder) out.push(builder(sel, ctx));
    }
    return out;
  },
};

registerToolpack(resendToolpack);
