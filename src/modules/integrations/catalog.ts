import type { CatalogEntry } from "./types";

// Pre-seeded integration catalog (data, not code). A tenant enables an entry per-agent and
// injects credentials by vault reference. `catalogType` is a plain String on
// IntegrationInstance validated against this registry, so a new integration needs no DB enum
// migration. Mappers for each entry live in ./mappers; an entry can exist here before its
// mapper does (inbound for it then fails closed until the mapper ships).
export const CATALOG: ReadonlyArray<CatalogEntry> = [
  {
    catalogType: "ASAAS",
    label: "Asaas",
    kind: "TOOLPACK",
    description:
      "Brazilian payments. Outbound toolpack (payment links + PIX charges) plus the inbound payment webhook: when a charge is paid, the agent is woken on the conversation that generated it and decides whether to notify the customer.",
    supportsInbound: true,
    defaultInboundAuth: "STATIC_HEADER",
    // Asaas sends the webhook's authentication token in `asaas-access-token` and the name is not
    // configurable in their panel, so comparing against our generic default rejected every
    // delivery (issue #107).
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
];

const BY_TYPE = new Map(CATALOG.map((e) => [e.catalogType, e]));

export function getCatalogEntry(catalogType: string): CatalogEntry | undefined {
  return BY_TYPE.get(catalogType);
}

export function isKnownCatalogType(catalogType: string): boolean {
  return BY_TYPE.has(catalogType);
}
