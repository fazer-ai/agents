import type { CatalogEntry } from "./types";

// Pre-seeded integration catalog (data, not code). A tenant enables an entry per-agent and
// injects credentials by vault reference. `catalogType` is a plain String on
// IntegrationInstance validated against this registry, so a new integration needs no DB enum
// migration. Mappers for each entry live in ./mappers; an entry can exist here before its
// mapper does (inbound for it then fails closed until the mapper ships).
export const CATALOG: ReadonlyArray<CatalogEntry> = [
  {
    catalogType: "GENERIC",
    label: "Generic webhook",
    kind: "WEBHOOK",
    description:
      "An inbound webhook that speaks back into a conversation, for two kinds of sender. (1) Your own system: an HTTP tool hands it `{{conversation_ref}}` when the agent calls it; later the system POSTs an event with that ref to this webhook. (2) A payment gateway that notifies with only an id (Mercado Pago, Stripe): `config.signatureHeader` + `config.signature` verify the gateway's signed manifest (e.g. `format: parts`, `ts`/`v1`), and `config.fetchBack` runs one of the tenant's HTTP tools with the notified id and reads `conversationRefPath` and `statusPath` from its response, so the payment link tool sends `{{conversation_ref}}` as the gateway's reference and a paid status wakes the agent on that conversation. Either way the agent passes the event on to the customer (or leaves a private note when a person holds the conversation). Config shape and a Mercado Pago example: https://github.com/fazer-ai/agents/blob/main/docs/integrations.md",
    supportsInbound: true,
    defaultInboundAuth: "HMAC_SHA256",
    // An open route here is a way to make the agent write to any customer who ever had a ref minted.
    requiresInboundAuth: true,
  },
  {
    catalogType: "ASAAS",
    label: "Asaas",
    kind: "TOOLPACK",
    description:
      "Brazilian payments. Outbound toolpack (payment links + PIX charges) plus the inbound payment webhook: when a charge is paid, the agent is woken on the conversation that generated it and decides whether to notify the customer.",
    supportsInbound: true,
    defaultInboundAuth: "STATIC_HEADER",
    // Asaas sends the webhook's authentication token in `asaas-access-token` and the name is not
    // configurable in their panel, so the generic default would reject every delivery.
    inboundAuthHeader: "asaas-access-token",
  },
  {
    catalogType: "GOOGLE_CALENDAR",
    label: "Google Calendar",
    kind: "TOOLPACK",
    description:
      "Scheduling. Outbound toolpack (list/create/update events + free/busy) over a Google OAuth credential, restricted to an allowlist of calendars.",
    supportsInbound: false,
    defaultInboundAuth: "NONE",
  },
  {
    catalogType: "GOOGLE_DRIVE",
    label: "Google Drive",
    kind: "TOOLPACK",
    description:
      "Files. Outbound toolpack (find a file, get its link, send it to the customer) over a Google OAuth credential, optionally scoped to a folder.",
    supportsInbound: false,
    defaultInboundAuth: "NONE",
  },
  {
    catalogType: "GOOGLE_SHEETS",
    label: "Google Sheets",
    kind: "TOOLPACK",
    description:
      "Spreadsheets. Outbound toolpack (append a row, find rows, update a found row) over a Google OAuth credential, on one spreadsheet tab bound to the instance config.",
    supportsInbound: false,
    defaultInboundAuth: "NONE",
  },
  {
    catalogType: "RESEND",
    label: "Resend",
    kind: "TOOLPACK",
    description:
      "Transactional email. Outbound toolpack (send an email to the customer + check its delivery status) over a Resend API key; the sender address is bound to the instance config, never the model.",
    // NOTE: Resend delivery webhooks sign with Svix (svix-id/timestamp/signature), which the generic
    // HMAC_SHA256 strategy does not verify; inbound ships with a Svix-aware verifier later.
    supportsInbound: false,
    defaultInboundAuth: "NONE",
  },
];

const BY_TYPE = new Map(CATALOG.map((e) => [e.catalogType, e]));

export function getCatalogEntry(catalogType: string): CatalogEntry | undefined {
  return BY_TYPE.get(catalogType);
}

export function isKnownCatalogType(catalogType: string): boolean {
  return BY_TYPE.has(catalogType);
}
