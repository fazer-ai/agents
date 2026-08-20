import { randomBytes } from "node:crypto";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { Prisma } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { failableTool, toolFailure } from "@/graph/tools/failure";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  type IntegrationSelection,
  registerToolpack,
  type Toolpack,
  type ToolpackCtx,
  type ToolSpec,
} from "./types";

// Asaas (Brazilian payments) OUTBOUND toolpack. The agent generates a payment link to send to a
// lead; we record an IntegrationExternalRef keyed by an opaque correlation id (sent to Asaas as
// `externalReference` and echoed back in the payment webhook) so the inbound mapper correlates
// the eventual PAYMENT_RECEIVED to THIS conversation by PK, never by LLM.
//
// Security invariants (hardened spec):
//   - `environment` (sandbox/production) is bound to the INSTANCE CONFIG, never a tool arg — a
//     prompt-injection cannot force a prod charge against a sandbox credential (or vice-versa);
//   - the access token (per-tenant, from the vault) flows ONLY into the access_token header,
//     never the URL / body / model-visible return / trace;
//   - the origin is a fixed constant per environment (never interpolated); SSRF-guarded anyway;
//   - https-only, no redirects, bounded timeout.
//
// NOTE: validated against the Asaas SANDBOX (2026-06). `POST /paymentLinks` with header
// `access_token` at https://api-sandbox.asaas.com/v3 returns `{ id, url, externalReference, … }`;
// chargeType DETACHED + billingType UNDEFINED are accepted and `externalReference` is echoed back.
// `dueDateLimitDays` is REQUIRED (omitting it → 400 "É necessário informar a quantidade de dias
// úteis para vencimento"), so it has a default below. The remaining webhook-side check — that a
// link-PAID payment echoes the externalReference — needs a paid payment (inbound mapper open note).
// Request-body defaults stay overridable via instance config (config.paymentLink).

// Base URLs confirmed against the official Asaas docs (docs.asaas.com → Authentication / Sandbox,
// 2026-06): the sandbox host is `api-sandbox.asaas.com` — NOT the legacy `sandbox.asaas.com/api/v3`,
// which 404s/redirects and broke every sandbox call.
const ASAAS_ORIGINS = {
  sandbox: "https://api-sandbox.asaas.com/v3",
  production: "https://api.asaas.com/v3",
} as const;
type AsaasEnv = keyof typeof ASAAS_ORIGINS;

const TIMEOUT_MS = 12_000;
const MAX_RESPONSE_CHARS = 2_000;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Bound to config, never a tool arg. Anything other than the explicit "production" string is
// treated as sandbox (safe default — never accidentally charge in production).
function resolveEnv(config: Record<string, unknown>): AsaasEnv {
  return config.environment === "production" ? "production" : "sandbox";
}

interface AsaasResponse {
  status: number;
  json: unknown;
}

async function asaasFetch(
  base: string,
  path: string,
  init: { method: string; token: string; body?: unknown },
  ctx: ToolpackCtx,
): Promise<AsaasResponse> {
  const url = `${base}${path}`;
  const assertSafe = ctx.assertSafe ?? assertSafeOutboundUrl;
  await assertSafe(url);
  const doFetch = ctx.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      method: init.method,
      headers: {
        access_token: init.token,
        "Content-Type": "application/json",
        "User-Agent": "agents",
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      redirect: "error",
      signal: ctrl.signal,
    });
    const text = (await res.text()).slice(0, MAX_RESPONSE_CHARS);
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON body → leave json null; the caller surfaces a generic error
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

// Tool input schemas (single source for both the runtime tool and the UI arg specs).
const PAYMENT_LINK_SCHEMA = z.object({
  value: z.number().positive().describe("Amount in BRL, e.g. 199.90"),
  description: z
    .string()
    .max(500)
    .optional()
    .describe("What the payment is for"),
  name: z.string().max(120).optional().describe("Short name for the charge"),
});

const PIX_CHARGE_SCHEMA = z.object({
  value: z.number().positive().describe("Amount in BRL, e.g. 199.90"),
  customerName: z.string().min(1).max(120).describe("Customer full name"),
  cpfCnpj: z
    .string()
    .min(1)
    .max(20)
    .describe(
      "Customer CPF or CNPJ, numbers only. Used to open the charge; never shown back to the customer.",
    ),
  mobilePhone: z
    .string()
    .max(20)
    .optional()
    .describe("Customer mobile phone (digits with area code), optional"),
  description: z
    .string()
    .max(500)
    .optional()
    .describe("What the payment is for"),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Due date as YYYY-MM-DD (optional; defaults to today)"),
});

// NOTE: field order is the arg order the UI projection renders (argsFromZod iterates the shape).
// Exactly one id is required, enforced in code (not .refine) so the model gets a short
// instructive message instead of a zod validation dump.
const PAYMENT_STATUS_SCHEMA = z.object({
  paymentId: z
    .string()
    .optional()
    .describe(
      "Asaas payment id (starts with pay_...), returned by asaas_create_pix_charge. Use for PIX/direct charges.",
    ),
  paymentLinkId: z
    .string()
    .optional()
    .describe(
      "Asaas payment link id, returned by asaas_payment_link_create. NOT the slug from the invoice/payment URL.",
    ),
});

const ASAAS_TOOL_SPECS: ToolSpec[] = [
  { name: "asaas_payment_link_create", schema: PAYMENT_LINK_SCHEMA },
  { name: "asaas_create_pix_charge", schema: PIX_CHARGE_SCHEMA },
  { name: "asaas_payment_status", schema: PAYMENT_STATUS_SCHEMA },
];

function buildCreateLinkTool(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): StructuredToolInterface {
  const env = resolveEnv(sel.config);
  const base = ASAAS_ORIGINS[env];
  const overrides = (sel.config.paymentLink ?? {}) as Record<string, unknown>;

  return failableTool(
    async (input: { value: number; description?: string; name?: string }) => {
      const token = sel.credentialRef
        ? await ctx.resolveCredential(sel.credentialRef)
        : null;
      if (!token)
        return toolFailure(
          "Asaas credential is not configured for this integration.",
        );

      // Opaque correlation token: sent as externalReference, stored as the ref's externalId, and
      // read back from the payment webhook by the inbound mapper. Never the internal thread id
      // (which would leak tenant/instance/conversation ids to Asaas).
      const correlationId = randomBytes(16).toString("hex");
      const body = {
        billingType: "UNDEFINED",
        chargeType: "DETACHED",
        name: input.name ?? input.description ?? "Pagamento",
        ...(input.description ? { description: input.description } : {}),
        value: input.value,
        // Required by Asaas for DETACHED links (sandbox-confirmed 2026-06): business days the link
        // stays payable. Overridable via config.paymentLink.
        dueDateLimitDays: 3,
        ...overrides,
        // Last: a config override must NOT clobber the correlation token. externalReference is the
        // field Asaas offers for the merchant's own identifier, so an operator stamping an ERP id
        // in config.paymentLink is the expected use of that map — and it used to win, leaving the
        // paid webhook with nothing to tie back to the conversation (issue #108).
        externalReference: correlationId,
      };

      let res: AsaasResponse;
      try {
        res = await asaasFetch(
          base,
          "/paymentLinks",
          { method: "POST", token, body },
          ctx,
        );
      } catch (err) {
        logger.warn({ err, env }, "asaas: payment link request failed");
        return toolFailure(
          "Failed to reach the payment provider. Try again shortly.",
        );
      }
      if (res.status < 200 || res.status >= 300) {
        logger.warn(
          "asaas: payment link create returned HTTP %s",
          String(res.status),
        );
        return toolFailure(
          `The payment provider rejected the request (HTTP ${res.status}).`,
        );
      }
      const data = (res.json ?? {}) as Record<string, unknown>;
      const linkId = typeof data.id === "string" ? data.id : null;
      const url = typeof data.url === "string" ? data.url : null;
      if (!linkId || !url) {
        logger.warn("asaas: payment link response missing id/url");
        return toolFailure(
          "The payment provider returned an unexpected response.",
        );
      }

      // Correlation ref (short scoped write, no network — the fetch already happened above).
      try {
        await runScopedOn(ctx.base, sysCtx(ctx.tenantId), (db) =>
          db.integrationExternalRef.create({
            data: {
              tenantId: ctx.tenantId,
              integrationInstanceId: sel.instanceId,
              externalId: correlationId,
              threadId: ctx.threadId,
              kind: "asaas_payment",
              metadata: { paymentLinkId: linkId } as Prisma.InputJsonValue,
            },
          }),
        );
      } catch (err) {
        // The link exists in Asaas but we failed to record the correlation → a future webhook
        // cannot tie the payment back to this thread. Surface loudly for manual reconciliation;
        // still return the link (the customer can pay).
        // NOTE: a true outbox (pending intent before the call) is deferred; reconciliation here
        // is log-driven for now (see plan: outbox/reconciliação open item).
        logger.error(
          { err, linkId },
          "asaas: failed to persist correlation ref (orphan link)",
        );
        ctx.onSideEffectError?.({
          tool: "asaas_payment_link_create",
          phase: "persist_ref",
          detail: { linkId },
          err,
        });
      }
      return `Payment link created. Send this URL to the customer: ${url}\n(paymentLinkId: ${linkId})`;
    },
    {
      name: "asaas_payment_link_create",
      description:
        "Create an Asaas payment link to send to the customer. Provide the amount in BRL (value) and an optional description. Returns the URL to share.",
      schema: PAYMENT_LINK_SCHEMA,
    },
  );
}

// Explicit PIX charge (n8n parity): find-or-create the customer by CPF/CNPJ, open a PIX payment,
// fetch the copy-and-paste code. Same correlation contract as the link tool (opaque
// externalReference → IntegrationExternalRef → inbound webhook). The CPF/CNPJ flows ONLY into the
// request body (never the model-visible return / log); the QR `encodedImage` (base64) is never
// returned either — only the textual `payload` (copy-and-paste) and the hosted `invoiceUrl`.
function buildCreatePixChargeTool(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): StructuredToolInterface {
  const env = resolveEnv(sel.config);
  const base = ASAAS_ORIGINS[env];
  const overrides = (sel.config.payment ?? {}) as Record<string, unknown>;

  return failableTool(
    async (input: {
      value: number;
      customerName: string;
      cpfCnpj: string;
      mobilePhone?: string;
      description?: string;
      dueDate?: string;
    }) => {
      const token = sel.credentialRef
        ? await ctx.resolveCredential(sel.credentialRef)
        : null;
      if (!token)
        return toolFailure(
          "Asaas credential is not configured for this integration.",
        );

      const cpfCnpj = input.cpfCnpj.replace(/\D/g, "");
      if (cpfCnpj.length !== 11 && cpfCnpj.length !== 14)
        return "Invalid CPF/CNPJ: provide 11 digits (CPF) or 14 (CNPJ).";

      // 1) Find-or-create the customer by CPF/CNPJ (reuse avoids duplicate customers on Asaas).
      let customerId: string | null = null;
      try {
        const found = await asaasFetch(
          base,
          `/customers?cpfCnpj=${cpfCnpj}`,
          { method: "GET", token },
          ctx,
        );
        // NOTE: A rejected lookup must fail the call, not fall through with an empty customerId —
        // falling through would POST /customers and create a DUPLICATE on a transient provider error.
        if (found.status < 200 || found.status >= 300) {
          logger.warn(
            "asaas: customer lookup returned HTTP %s",
            String(found.status),
          );
          return toolFailure(
            `The payment provider rejected the customer lookup (HTTP ${found.status}).`,
          );
        }
        // NOTE: A malformed 2xx body must also fail the call (asaasFetch yields json: null on an
        // unparseable body) — only a valid data array may reach the create branch, and a non-empty
        // one must carry a string id, otherwise a parse glitch would duplicate the customer.
        const json = found.json as { data?: unknown } | null;
        if (!json || typeof json !== "object" || !Array.isArray(json.data)) {
          logger.warn("asaas: customer lookup returned an invalid response");
          return toolFailure(
            "The payment provider returned an unexpected response.",
          );
        }
        const first = (json.data as Array<{ id?: unknown }>)[0]?.id;
        // NOTE: A blank ("" / whitespace) id must count as missing — it would leave customerId
        // falsy and reach the create branch anyway.
        const firstId = typeof first === "string" ? first.trim() : "";
        if (json.data.length > 0 && !firstId) {
          logger.warn("asaas: customer lookup response missing customer id");
          return toolFailure(
            "The payment provider returned an unexpected response.",
          );
        }
        if (firstId) customerId = firstId;
      } catch (err) {
        logger.warn({ err, env }, "asaas: customer lookup failed");
        return toolFailure(
          "Failed to reach the payment provider. Try again shortly.",
        );
      }

      if (!customerId) {
        let created: AsaasResponse;
        try {
          created = await asaasFetch(
            base,
            "/customers",
            {
              method: "POST",
              token,
              body: {
                name: input.customerName,
                cpfCnpj,
                ...(input.mobilePhone
                  ? { mobilePhone: input.mobilePhone }
                  : {}),
              },
            },
            ctx,
          );
        } catch (err) {
          logger.warn({ err, env }, "asaas: customer create failed");
          return toolFailure(
            "Failed to reach the payment provider. Try again shortly.",
          );
        }
        if (created.status < 200 || created.status >= 300) {
          logger.warn(
            "asaas: customer create returned HTTP %s",
            String(created.status),
          );
          return toolFailure(
            `The payment provider rejected the customer (HTTP ${created.status}).`,
          );
        }
        const cd = (created.json ?? {}) as Record<string, unknown>;
        if (typeof cd.id === "string") customerId = cd.id;
      }
      if (!customerId) {
        logger.warn("asaas: could not resolve a customer id");
        return toolFailure(
          "The payment provider returned an unexpected response.",
        );
      }

      // 2) Open the PIX charge. correlationId is opaque (never the internal thread id).
      const correlationId = randomBytes(16).toString("hex");
      const dueDate = input.dueDate ?? new Date().toISOString().slice(0, 10);
      const body = {
        customer: customerId,
        billingType: "PIX",
        value: input.value,
        dueDate,
        ...(input.description ? { description: input.description } : {}),
        ...overrides,
        // Last: a config override must NOT clobber the correlation token.
        externalReference: correlationId,
      };
      let charge: AsaasResponse;
      try {
        charge = await asaasFetch(
          base,
          "/payments",
          { method: "POST", token, body },
          ctx,
        );
      } catch (err) {
        logger.warn({ err, env }, "asaas: pix charge request failed");
        return toolFailure(
          "Failed to reach the payment provider. Try again shortly.",
        );
      }
      if (charge.status < 200 || charge.status >= 300) {
        logger.warn(
          "asaas: pix charge create returned HTTP %s",
          String(charge.status),
        );
        return toolFailure(
          `The payment provider rejected the request (HTTP ${charge.status}).`,
        );
      }
      const cdata = (charge.json ?? {}) as Record<string, unknown>;
      const paymentId = typeof cdata.id === "string" ? cdata.id : null;
      const invoiceUrl =
        typeof cdata.invoiceUrl === "string" ? cdata.invoiceUrl : null;
      if (!paymentId) {
        logger.warn("asaas: pix charge response missing id");
        return toolFailure(
          "The payment provider returned an unexpected response.",
        );
      }

      // Persist the correlation ref (the charge exists; this is what ties a future webhook back to
      // THIS thread). Orphan on failure → logged for reconciliation, charge still returned.
      try {
        await runScopedOn(ctx.base, sysCtx(ctx.tenantId), (db) =>
          db.integrationExternalRef.create({
            data: {
              tenantId: ctx.tenantId,
              integrationInstanceId: sel.instanceId,
              externalId: correlationId,
              threadId: ctx.threadId,
              kind: "asaas_payment",
              metadata: { paymentId } as Prisma.InputJsonValue,
            },
          }),
        );
      } catch (err) {
        logger.error(
          { err, paymentId },
          "asaas: failed to persist correlation ref (orphan charge)",
        );
        ctx.onSideEffectError?.({
          tool: "asaas_create_pix_charge",
          phase: "persist_ref",
          detail: { paymentId },
          err,
        });
      }

      // 3) Fetch the PIX copy-and-paste code. Best-effort: a missing PIX key on the account still
      // leaves a payable invoiceUrl. We surface `payload` (text) but never `encodedImage` (base64).
      let payload: string | null = null;
      try {
        const qr = await asaasFetch(
          base,
          `/payments/${encodeURIComponent(paymentId)}/pixQrCode`,
          { method: "GET", token },
          ctx,
        );
        if (qr.status >= 200 && qr.status < 300) {
          const qd = (qr.json ?? {}) as Record<string, unknown>;
          if (typeof qd.payload === "string") payload = qd.payload;
        } else {
          // NOTE: A non-2xx never threw, so this used to vanish silently — the charge exists and
          // the tool returns success either way, but the customer gets no copy-and-paste code.
          // (A 2xx without a payload is a legitimate state — e.g. no PIX key, invoiceUrl still
          // payable — and stays quiet.)
          logger.warn(
            { status: qr.status, env },
            "asaas: pix qr fetch returned a non-2xx response",
          );
          ctx.onSideEffectError?.({
            tool: "asaas_create_pix_charge",
            phase: "pix_qr",
            detail: { paymentId },
            err: `HTTP ${qr.status}`,
          });
        }
      } catch (err) {
        logger.warn({ err, env }, "asaas: pix qr fetch failed");
        ctx.onSideEffectError?.({
          tool: "asaas_create_pix_charge",
          phase: "pix_qr",
          detail: { paymentId },
          err,
        });
      }

      const lines = ["PIX charge created."];
      if (payload) lines.push(`PIX copy-and-paste code: ${payload}`);
      if (invoiceUrl) lines.push(`Payment page: ${invoiceUrl}`);
      if (!payload && !invoiceUrl)
        lines.push(
          "The charge exists but no payment code was returned; check the Asaas dashboard.",
        );
      lines.push(`(paymentId: ${paymentId})`);
      return lines.join("\n");
    },
    {
      name: "asaas_create_pix_charge",
      description:
        "Create a PIX charge in Asaas for a customer and return the copy-and-paste PIX code plus the payment page to send them. Use when the customer wants to pay by PIX. Returns the paymentId — use it with asaas_payment_status to check whether it was paid.",
      schema: PIX_CHARGE_SCHEMA,
    },
  );
}

function buildStatusTool(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): StructuredToolInterface {
  const env = resolveEnv(sel.config);
  const base = ASAAS_ORIGINS[env];

  return failableTool(
    async (input: { paymentId?: string; paymentLinkId?: string }) => {
      const token = sel.credentialRef
        ? await ctx.resolveCredential(sel.credentialRef)
        : null;
      if (!token)
        return toolFailure(
          "Asaas credential is not configured for this integration.",
        );
      let paymentId = input.paymentId?.trim() || undefined;
      let linkId = input.paymentLinkId?.trim() || undefined;
      // Defensive: a pay_... id in the link field is a payment id (models mix them up).
      if (!paymentId && linkId?.startsWith("pay_")) {
        paymentId = linkId;
        linkId = undefined;
      }
      const guidance =
        "Provide paymentId (pay_..., returned by asaas_create_pix_charge) or paymentLinkId (returned by asaas_payment_link_create). Do NOT use the invoice/payment page URL or its slug.";
      // Reject pasted URLs outright — Asaas ids never contain slashes or colons; letting an
      // invoice URL through would surface as a confusing 404 from the provider.
      const looksLikeUrl = (v: string) => /[/:]/.test(v);
      if (
        (paymentId && looksLikeUrl(paymentId)) ||
        (linkId && looksLikeUrl(linkId))
      )
        return guidance;
      if (!paymentId && !linkId) return guidance;
      // Path-interpolated ids are URL-encoded; the origin stays the fixed constant above.
      // When both arrive, the payment wins: its status is the terminal fact (a link stays
      // `active` even after it was paid).
      const path = paymentId
        ? `/payments/${encodeURIComponent(paymentId)}`
        : `/paymentLinks/${encodeURIComponent(linkId as string)}`;
      let res: AsaasResponse;
      try {
        res = await asaasFetch(base, path, { method: "GET", token }, ctx);
      } catch (err) {
        logger.warn({ err, env }, "asaas: payment status request failed");
        return toolFailure("Failed to reach the payment provider.");
      }
      if (res.status < 200 || res.status >= 300) {
        // An invoice-URL SLUG is shape-indistinguishable from a real link id, so it can only be
        // caught here: turn the provider's 404 into recoverable guidance instead of a dead end.
        if (res.status === 404)
          return "The payment provider returned HTTP 404 (id not found). If this value was extracted from an invoice/payment URL, that slug is not a valid id — use the paymentId returned by asaas_create_pix_charge or the paymentLinkId returned by asaas_payment_link_create.";
        return toolFailure(`The payment provider returned HTTP ${res.status}.`);
      }
      const d = (res.json ?? {}) as Record<string, unknown>;
      // Bounded projections (no secrets; status-relevant fields only). The payment path skips
      // netValue (merchant-facing fee math), invoiceUrl (possibly stale page) and
      // externalReference (internal correlation token).
      if (paymentId) {
        return JSON.stringify({
          id: d.id,
          status: d.status,
          value: d.value,
          billingType: d.billingType,
          dueDate: d.dueDate,
          paymentDate: d.paymentDate,
        });
      }
      return JSON.stringify({
        id: d.id,
        active: d.active,
        value: d.value,
        billingType: d.billingType,
        chargeType: d.chargeType,
      });
    },
    {
      name: "asaas_payment_status",
      description:
        "Check the status of an Asaas payment. Pass paymentId (pay_..., returned by asaas_create_pix_charge) OR paymentLinkId (returned by asaas_payment_link_create); never the invoice URL or its slug. Payment status is PENDING/RECEIVED/CONFIRMED/OVERDUE/REFUNDED.",
      schema: PAYMENT_STATUS_SCHEMA,
    },
  );
}

const TOOL_BUILDERS: Record<
  string,
  (sel: IntegrationSelection, ctx: ToolpackCtx) => StructuredToolInterface
> = {
  asaas_payment_link_create: buildCreateLinkTool,
  asaas_create_pix_charge: buildCreatePixChargeTool,
  asaas_payment_status: buildStatusTool,
};

export const asaasToolpack: Toolpack = {
  catalogType: "ASAAS",
  toolSpecs: ASAAS_TOOL_SPECS,
  build(sel, ctx) {
    const out: StructuredToolInterface[] = [];
    for (const name of sel.enabledTools) {
      const builder = TOOL_BUILDERS[name];
      if (builder) out.push(builder(sel, ctx));
    }
    return out;
  },
};

registerToolpack(asaasToolpack);
