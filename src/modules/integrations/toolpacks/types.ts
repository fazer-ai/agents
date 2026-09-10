import type { StructuredToolInterface } from "@langchain/core/tools";
import type { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import { withDeadline } from "@/lib/outbound";
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
  // THE CALLER'S WHOLE-TURN DEADLINE, when it has one (the observer's tick). Aborting an invoke
  // stops the caller waiting, not a handler writing: a pack that was resolving a credential when
  // the budget ran out still reaches its DELETE, and the tick has already been reported as a
  // RETRYABLE failure, so the retry sends it again. Enforced by WRAPPING `fetchImpl` in
  // buildToolpackTools rather than at each pack's own request helper — four packs with their own
  // helpers is four places to forget, and a fifth added later would start out uncovered. Same shape
  // as the Chatwoot client's `mutedFetch`. Absent ⇒ no deadline, which is every reactive turn.
  expiresOn?: AbortSignal;
  // THE CALLER'S WITHDRAWAL FENCE, enforced the same way the deadline is: by wrapping `fetchImpl` at
  // the build seam, so every pack's own request helper asks it without any of them knowing. A
  // deadline answers "is there still time"; this answers "is anyone still waiting" — a `/reset` or a
  // detach landing while a pack resolves a credential leaves the budget alive and the run withdrawn
  // (issue #568, review round 28). Absent ⇒ no fence, which is every reactive turn's toolpack today.
  stillWanted?: () => Promise<boolean>;
  // Called when a call refuses without sending anything, with the TOOL's name: nothing left the
  // process, and the counter on the other end applies to the report the same test it applied at
  // dispatch (see graph/tools/effect-free.ts).
  onNoEffect?: (toolName: string) => void;
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
    // The booking system and the calling tool's name. A toolpack passes neither: it IS Google
    // Calendar, which is what both default to. They exist for the HTTP tool whose DEFINITION
    // declares an appointment (issue #352) — see graph/tools/http.ts.
    provider?: string;
    tool?: string;
    calendarId?: string | null;
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
  cancelAppointment?: (
    eventId: string,
    opts?: { provider?: string; tool?: string },
  ) => Promise<void>;
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
  // WHETHER THIS TOOL'S WHOLE POINT IS TO PUT SOMETHING IN FRONT OF THE CUSTOMER. A muted turn (the
  // observer's, issue #568) is not offered one: the send is refused at that client's transport, and
  // the tool would have done its expensive half — Drive downloads the file first — before finding
  // out. Declared on the SPEC rather than guessed from the name, so a pack added later states it
  // where its tools are already listed.
  deliversToCustomer?: boolean;
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
  // Mirrored from the spec so the editor can answer the same question the muted assembly answers,
  // off one declaration (review round 30).
  deliversToCustomer?: boolean;
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
export function deadlineFetch(
  inner: typeof fetch,
  expiresOn: AbortSignal,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    // Before the request is built, so a pack that spent the budget on a credential read is stopped
    // rather than sending. Thrown rather than returned: a toolpack's helper reads a Response, and
    // handing it a synthetic one would be a failure the pack reports as the provider's.
    if (expiresOn.aborted) {
      throw new Error(
        "the run's time budget ran out before the request was sent",
      );
    }
    // Combined, never chosen between: see withDeadline.
    return inner(input, {
      ...(init ?? {}),
      signal: withDeadline(init?.signal, expiresOn),
    });
  }) as typeof fetch;
}

// Refuses a request whose run was called off, at the last moment before it leaves. Throws rather
// than returning a shape: a pack's request helper reads a Response, and a synthetic one would have
// to lie about a status. The packs already answer a thrown transport error as a tool failure, which
// is the honest reading — the call did not happen.
export class ToolpackCalledOffError extends Error {
  constructor() {
    super("the run was called off before the request was sent");
    this.name = "ToolpackCalledOffError";
  }
}

export function fencedFetch(
  inner: typeof fetch,
  stillWanted: () => Promise<boolean>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    // Only an explicit `false` stops it: a fence that could not answer is not a withdrawal.
    if (!(await stillWanted().catch(() => true)))
      throw new ToolpackCalledOffError();
    return inner(input, init);
  }) as typeof fetch;
}

export function buildToolpackTools(
  selections: IntegrationSelection[],
  ctx: ToolpackCtx,
): StructuredToolInterface[] {
  let inner = ctx.fetchImpl ?? fetch;
  if (ctx.stillWanted) inner = fencedFetch(inner, ctx.stillWanted);
  if (ctx.expiresOn) inner = deadlineFetch(inner, ctx.expiresOn);
  const bounded: ToolpackCtx =
    ctx.expiresOn || ctx.stillWanted ? { ...ctx, fetchImpl: inner } : ctx;
  // A MUTED CLIENT DECIDES WHAT THE TURN MAY BE OFFERED, here as in buildNativeTools: a tool whose
  // delivery this client refuses costs a model round and answers with a failure the operator reads
  // as a broken integration. Read off the client the ctx already carries, so the mute and the
  // toolset cannot disagree.
  const muted = ctx.chatwoot?.client?.muted === true;
  const out: StructuredToolInterface[] = [];
  for (const sel of selections) {
    if (sel.enabledTools.length === 0) continue;
    const pack = getToolpack(sel.catalogType);
    if (!pack) continue;
    // REPORTED PER TOOL, at the build seam, and not from inside `fencedFetch`: the fetch wrapper is
    // shared by the whole pack, so it knows no tool name and a pack that makes two requests in one
    // call would report twice for one dispatch. Here the error escapes ONE tool's invoke exactly
    // once, and it carries that tool's name (review round 37).
    const built = pack.build(sel, bounded).map((t) => {
      if (!ctx.onNoEffect) return t;
      const seen = Object.create(t) as typeof t;
      seen.invoke = (async (input: unknown, config?: unknown) => {
        try {
          return await (
            t.invoke as (i: unknown, c?: unknown) => Promise<unknown>
          )(input, config);
        } catch (e) {
          if (e instanceof ToolpackCalledOffError) ctx.onNoEffect?.(t.name);
          throw e;
        }
      }) as typeof t.invoke;
      return seen;
    });
    if (!muted) {
      out.push(...built);
      continue;
    }
    const delivers = new Set(
      pack.toolSpecs.filter((t) => t.deliversToCustomer).map((t) => t.name),
    );
    out.push(...built.filter((t) => !delivers.has(t.name)));
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
    ...(s.deliversToCustomer ? { deliversToCustomer: true } : {}),
  }));
}
