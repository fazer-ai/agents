import type { StructuredToolInterface } from "@langchain/core/tools";
import type { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import type { SafeUrlOptions } from "@/lib/ssrf";
import type { Schedule } from "@/modules/business-hours/hours";
import type { ChatwootClient } from "@/modules/chatwoot/client";

// Outbound toolpacks: the per-agent activation of a catalog integration's OUTBOUND tools (the
// inbound side is the pure mapper). A toolpack is curated code (not a free-form ToolDefinition)
// because it carries domain wiring the declarative HTTP tool cannot: the credential's
// environment binding, a fixed origin, and the IntegrationExternalRef side-effect that
// correlates a future inbound webhook back to this conversation by PK.

// A scoped read produces this; the actual HTTP call happens at tool-invoke time, OUTSIDE any tx.
// enabledTools is a fail-closed allowlist (a tool the agent was not granted is never exposed; a
// new upstream tool is not auto-granted).
export interface IntegrationSelection {
  instanceId: bigint;
  catalogType: string;
  config: Record<string, unknown>;
  credentialRef: string | null;
  enabledTools: string[];
}

export interface ToolpackCtx {
  tenantId: bigint;
  base: PrismaClient;
  threadId: string;
  // The current customer's DB id (Contact.id), stable per tenant across conversations. Present on a
  // real turn / nudge (resolved from the conversation), absent on the playground. A toolpack that
  // must isolate per-customer data (e.g. Google Calendar appointments) stamps/filters by it and
  // fails closed when absent — it is NEVER a model-controlled arg, so a prompt cannot widen it.
  contactDbId?: bigint | null;
  // Resolves a vault secret by reference (short scoped DB read; no network).
  resolveCredential: (ref: string) => Promise<string | null>;
  // Injectable for tests; default real fetch.
  fetchImpl?: typeof fetch;
  // Injectable for tests; default assertSafeOutboundUrl. The origin is a fixed trusted constant
  // here, so this is defense-in-depth (and lets tests stay hermetic without DNS).
  assertSafe?: (url: string, opts?: SafeUrlOptions) => Promise<unknown>;
  // The live conversation handle, present ONLY on a real inbox turn (conversationId > 0). A tool
  // that delivers something to the customer (e.g. Drive send_file) uses it; absent on the
  // playground (conversationId 0 + stub client), so such tools degrade gracefully.
  chatwoot?: { client: ChatwootClient; conversationId: number };
  // Resolves an integration's chosen BusinessHours by id → the whole schedule (weekly windows, date
  // exceptions, timezone; short scoped DB read, no network). The Calendar availability tool uses it to
  // bound bookable slots to the service hours; null when unset/deleted/other-tenant ⇒ "always on".
  // Injected in prepare.ts; stubbed in tests.
  resolveBusinessHours?: (id: string) => Promise<Schedule | null>;
  // An appointment was booked in this conversation. A closure bound to the tenant + this
  // conversation's thread; it is a pure MECHANISM (write the record, arm the scheduler jobs). The
  // POLICY lives in the integration's config and is read + passed by the toolpack, as `reminders`.
  // The credentialRef is the integration's, never the secret. Undefined on the playground / when no
  // contact is in scope, so the toolpack treats it as best-effort. NEVER a model arg. Injected in
  // prepare.ts; stubbed in tests.
  //
  // `reminders: null` means "arm nothing", and it is the ordinary answer for an integration with
  // reminders switched off. It does NOT mean "do not record": the record is what the follow-up
  // pause, the console indicator and the agent's own prompt read, and it is written either way. The
  // two used to be one call, which is how an operator could turn reminders off and silently lose the
  // pause as well (issue #376).
  appointmentBooked?: (args: {
    eventId: string;
    calendarId: string;
    startISO: string;
    credentialRef: string | null;
    reminders: {
      offsetsHours: number[];
      askConfirmationOnLast: boolean;
    } | null;
    // Snapshot for the record and the job payload: lets the reminder turn and the per-turn
    // appointment context describe the event without a Google call.
    summary: string | null;
    calendarLabel: string | null;
  }) => Promise<void>;
  // The appointment stopped standing: retire the record and its pending reminders (Calendar cancel;
  // the toolpack re-arms on reschedule by calling appointmentBooked again). Same gating as
  // appointmentBooked.
  cancelAppointment?: (eventId: string) => Promise<void>;
  // NOTE: Reports a side effect that failed INSIDE a tool that still returns success to the model
  // (e.g. the Asaas charge exists but persisting the correlation ref failed). prepare.ts binds this to a
  // flowlog `tool`-stage warn so the failure reaches the Logs page and alert channels; absent
  // (playground/tests) ⇒ the failure stays log-only. NEVER changes the tool's return value.
  onSideEffectError?: SideEffectErrorReporter;
}

// NOTE: The single declaration of the side-effect reporter contract — shared by ToolpackCtx (here),
// the native ToolCtx, and prepare.ts's structural mirror of it, so the three cannot drift apart.
export type SideEffectErrorReporter = (e: {
  tool: string;
  phase: string;
  detail?: Record<string, unknown>;
  err: unknown;
}) => void;

// A single tool argument, projected for the UI (mirrors how MCP tool args are shown): the name, the
// model-facing description (the zod `.describe()`), and whether it is required.
export interface ToolArgSpec {
  name: string;
  description?: string;
  required: boolean;
}

// A tool's declarative spec: name and input schema. SINGLE SOURCE of truth for a toolpack — the
// tool names and the UI arg list both derive from here. The schema is a ZodObject so argsFromZod
// can yield the arg list WITHOUT building the tool (no ctx, no side effects).
export interface ToolSpec {
  name: string;
  schema: z.ZodObject<z.ZodRawShape>;
}

// One integration's outbound tools. Pure builder: returns StructuredTools filtered to the
// allowlist; each tool's body does its own network + scoped persistence at invoke time.
export interface Toolpack {
  catalogType: string;
  // Every tool this pack can expose, with its input schema (for UI + fail-closed validation).
  toolSpecs: readonly ToolSpec[];
  build(
    selection: IntegrationSelection,
    ctx: ToolpackCtx,
  ): StructuredToolInterface[];
}

// Derives the UI arg list from a tool's zod schema: each top-level field's name, its `.describe()`
// text, and whether it is required. Pure (no build, no ctx) — same projection MCP args get.
export function argsFromZod(schema: z.ZodObject<z.ZodRawShape>): ToolArgSpec[] {
  return Object.entries(schema.shape).map(([name, field]) => {
    const f = field as z.ZodTypeAny;
    return {
      name,
      description: f.description,
      required: !f.isOptional(),
    };
  });
}

// A toolpack tool projected for the UI: name + arg specs.
export interface ToolView {
  name: string;
  args: ToolArgSpec[];
}

const REGISTRY = new Map<string, Toolpack>();

export function registerToolpack(pack: Toolpack): void {
  REGISTRY.set(pack.catalogType, pack);
}

export function getToolpack(catalogType: string): Toolpack | undefined {
  return REGISTRY.get(catalogType);
}

// Builds the outbound tools for a set of integration selections. Fail-closed: a selection with
// an empty allowlist or a catalogType without a toolpack (NATIVE/MCP) contributes nothing.
export function buildToolpackTools(
  selections: IntegrationSelection[],
  ctx: ToolpackCtx,
): StructuredToolInterface[] {
  const out: StructuredToolInterface[] = [];
  for (const sel of selections) {
    if (sel.enabledTools.length === 0) continue;
    const pack = getToolpack(sel.catalogType);
    if (!pack) continue;
    out.push(...pack.build(sel, ctx));
  }
  return out;
}

// Every tool name a catalogType's toolpack can expose (the fail-closed allowlist). Empty for a
// catalogType without a registered toolpack (NATIVE/MCP).
export function getToolpackToolNames(catalogType: string): string[] {
  return getToolpack(catalogType)?.toolSpecs.map((s) => s.name) ?? [];
}

// The toolpack's tools projected for the UI: name + args (label/description live in the frontend's
// toolpackToolMeta, keyed by name).
export function getToolpackToolViews(catalogType: string): ToolView[] {
  const pack = getToolpack(catalogType);
  if (!pack) return [];
  return pack.toolSpecs.map((s) => ({
    name: s.name,
    args: argsFromZod(s.schema),
  }));
}
