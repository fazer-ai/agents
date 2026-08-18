// Integration catalog + the closed set of normalized inbound domain events.
//
// Deliberate scope limit: the generic inbound receptor normalizes every external payload into
// ONE OF these kinds — never arbitrary action. We are an app, not an automation platform
// (n8n-export covers arbitrary workflows). Adding an integration = a catalog entry + a pure
// mapper into these kinds + a zod schema + a registry line; nothing in the core changes.

import type { InboundAuthStrategy } from "@/../generated/prisma/client";

export const INBOUND_EVENT_KINDS = [
  "conversion",
  "status_update",
  "agent_nudge",
] as const;
export type InboundEventKind = (typeof INBOUND_EVENT_KINDS)[number];

// A mapper's pure output. externalId correlates to a thread via IntegrationExternalRef;
// dedupeKey drives idempotency. All other fields are an allowlisted, PII-bounded projection —
// `summary` is text WE normalized, never the raw external JSON (prompt-injection boundary).
export interface NormalizedInboundEvent {
  kind: InboundEventKind;
  externalId: string;
  dedupeKey: string;
  occurredAt?: Date;
  value?: number;
  currency?: string;
  status?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}

// A mapper's discriminated verdict. "unhandled" = parsed fine but not an event we act on
// (lifecycle noise, deliberately silent). "invalid" = the payload SHOULD have matched and did
// not — schema drift or garbage; `detail` carries zod issue PATHS only, never values (the
// receptor logs it; PII boundary).
export type MapResult =
  | { ok: true; event: NormalizedInboundEvent }
  | { ok: false; reason: "unhandled" | "invalid"; detail?: string };

// The deterministic translator for one integration: external payload → MapResult. Pure (no DB,
// no network, no LLM): correlation/idempotency/dispatch happen in the receptor around it.
// Validate shape with zod inside map().
export interface InboundMapper {
  catalogType: string;
  map(raw: unknown): MapResult;
}

export type CatalogKind = "TOOLPACK" | "MCP" | "NATIVE";

export interface CatalogEntry {
  catalogType: string;
  label: string;
  kind: CatalogKind;
  description: string;
  supportsInbound: boolean;
  // NOTE: suggested default for the UI when an operator first enables the integration; the
  // instance can override. The actual gate is per-instance (inboundAuthStrategy column).
  defaultInboundAuth: InboundAuthStrategy;
  // NOTE: the header THIS provider sends its static token in, when it fixes one. Absent ⇒ the
  // generic default. This is not a preference: a provider that hardcodes its header name leaves the
  // operator nothing to configure on their side, so the convention has to live here (issue #107).
  inboundAuthHeader?: string;
}
