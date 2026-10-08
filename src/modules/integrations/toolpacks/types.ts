import { AsyncLocalStorage } from "node:async_hooks";
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
  // The contact's own address, for the one pack that writes to an address instead of into the
  // conversation. A column rather than one of the attribute bags, so `contactDbId` cannot answer
  // it. Absent or null ⇒ the pack fails closed, like the Calendar stamp.
  resolveContactEmail?: () => Promise<string | null>;
  // The contact's email as Chatwoot holds it NOW, read over the network. Not the mirror above:
  // Chatwoot does not deliver contact_updated to bots, so an email an agent typed into the contact
  // in Chatwoot is invisible to the mirror until another event carries the contact. Used by the
  // Calendar invite. Absent ⇒ no live read (playground); null ⇒ the contact has no email.
  readContactEmail?: () => Promise<string | null>;
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
  // The caller's withdrawal fence, enforced like the deadline: by wrapping `fetchImpl` at the build
  // seam, so every pack's request helper asks it unknowingly. The deadline answers "is there still
  // time"; this answers "is anyone still waiting" (a `/reset` or a detach while a pack resolves a
  // credential). Absent means no fence, which is every reactive turn's toolpack.
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
  // An appointment was booked in this conversation: a closure bound to the tenant + this
  // conversation's thread, a pure MECHANISM (write the record, arm the jobs). The POLICY is the
  // integration's config, passed by the toolpack as `reminders`. Undefined on the playground or
  // with no contact in scope, so best-effort; NEVER a model arg. Injected in prepare.ts.
  // `reminders: null` means "arm nothing", NOT "do not record": the follow-up pause, the console
  // indicator and the prompt read the record.
  appointmentBooked?: (args: {
    eventId: string;
    // The booking system and the calling tool's name. A toolpack passes neither: it IS Google
    // Calendar, which is what both default to. They exist for the HTTP tool whose DEFINITION
    // declares an appointment (see graph/tools/http.ts).
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

// The single declaration of the side-effect reporter contract — shared by ToolpackCtx (here),
// the native ToolCtx, and prepare.ts's structural mirror of it, so the three cannot drift apart.
export type SideEffectErrorReporter = (e: {
  tool: string;
  phase: string;
  detail?: Record<string, unknown>;
  err: unknown;
  // Absent is `warn`, which pages an alert channel. `info` keeps the line on the Logs page and pages
  // only a channel set to info: the level a tool's own "do not alert me about this" asks for.
  level?: "warn" | "info";
  // `ok`: the side effect went through and the line is the record of it (`info`, no error status).
  status?: "ok";
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
  // Whether this tool's whole point is to put something in front of the customer. A muted turn (the
  // observer's) is not offered one: the send is refused at that client's transport, after the tool
  // already did its expensive half (Drive downloads the file first). Declared on the SPEC, not
  // guessed from the name.
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
  // off one declaration.
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

// Which dispatch a refusal belongs to. `fencedFetch` is shared by every pack of the turn, so its
// throw knows no tool name, and the build seam never sees the throw, because every pack turns a
// transport error into a tool failure inside its handler. So the seam opens a frame per dispatch
// and the throw reads it; the flag keeps a pack that makes two requests in one call from reporting
// twice.
type CalledOffFrame = { tool: string; reported: boolean; spent: boolean };
const calledOffFrame = new AsyncLocalStorage<CalledOffFrame>();

export function fencedFetch(
  inner: typeof fetch,
  stillWanted: () => Promise<boolean>,
  onNoEffect?: (toolName: string) => void,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    // Only an explicit `false` stops it: a fence that could not answer is not a withdrawal.
    if (!(await stillWanted().catch(() => true))) {
      // ...and only while the dispatch is still EMPTY. A pack tool can be several requests
      // (`asaas_create_pix_charge` POSTs the charge, then GETs its QR code), and reporting a
      // refusal after the charge exists would let the scheduler retry and charge twice:
      // at-most-once for the effects beats at-least-once for a classification (docs/chatwoot.md).
      const frame = calledOffFrame.getStore();
      if (frame && !frame.reported && !frame.spent) {
        frame.reported = true;
        onNoEffect?.(frame.tool);
      }
      throw new ToolpackCalledOffError();
    }
    // A request that LEFT, whatever it was. No pack tells this wrapper which of its calls writes,
    // and the two errors are not symmetric: treating a read as an effect costs one observation,
    // treating a write as none costs the write again in somebody else's system.
    const frame = calledOffFrame.getStore();
    if (frame) frame.spent = true;
    return inner(input, init);
  }) as typeof fetch;
}

export function buildToolpackTools(
  selections: IntegrationSelection[],
  ctx: ToolpackCtx,
): StructuredToolInterface[] {
  let inner = ctx.fetchImpl ?? fetch;
  if (ctx.stillWanted)
    inner = fencedFetch(inner, ctx.stillWanted, ctx.onNoEffect);
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
    // THE NAME, HANDED TO THE THROW. Opening the frame is all this wrapper does: the report itself
    // happens where the refusal is raised, which is the only place the pack's own catch cannot
    // swallow it (see `calledOffFrame` above).
    const built = pack.build(sel, bounded).map((t) => {
      if (!ctx.onNoEffect || !ctx.stillWanted) return t;
      const seen = Object.create(t) as typeof t;
      seen.invoke = ((input: unknown, config?: unknown) =>
        calledOffFrame.run(
          { tool: t.name, reported: false, spent: false },
          () =>
            (t.invoke as (i: unknown, c?: unknown) => Promise<unknown>)(
              input,
              config,
            ),
        )) as typeof t.invoke;
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
