/**
 * The OpenTelemetry transport behind Langfuse tracing (docs/graph.md, Langfuse tracing). There is one
 * tracer provider per process and every tenant traces into its own Langfuse project, so the provider's
 * only span processor is a router: each span goes to the destination of the handler that started it,
 * a span started outside a handler is dropped, and content is redacted in the router before a span
 * reaches any processor when the tenant did not opt into sending it.
 */

import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  LangfuseOtelSpanAttributes,
  setLangfuseTracerProvider,
} from "@langfuse/tracing";
import {
  type Span as ApiSpan,
  context,
  type SpanContext,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import {
  BasicTracerProvider,
  type IdGenerator,
  RandomIdGenerator,
  type ReadableSpan,
  type Span,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import logger from "@/api/lib/logger";
import { clipText } from "@/lib/text";

export const REDACTED = "[redacted by fazer.ai PII policy]";

const CONTENT_ATTRIBUTES = [
  LangfuseOtelSpanAttributes.OBSERVATION_INPUT,
  LangfuseOtelSpanAttributes.OBSERVATION_OUTPUT,
  LangfuseOtelSpanAttributes.TRACE_INPUT,
  LangfuseOtelSpanAttributes.TRACE_OUTPUT,
] as const;

/** Where a tenant's spans go, and whether their content may leave the process. */
export interface LangfuseRoute {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
  sendContent?: boolean;
  tenantId: bigint;
}

// How a failed export is retried: three more tries, three seconds apart, on a network error, a 429
// or a 5xx. A 4xx other than 429 is the instance refusing the request, and repeating it changes
// nothing.
export const LANGFUSE_DELIVERY_RETRY = {
  fetchRetryCount: 3,
  fetchRetryDelay: 3_000,
} as const;

let deliveryRetryForTest:
  | { fetchRetryCount: number; fetchRetryDelay: number; budgetMs?: number }
  | undefined;

/**
 * Test-only: the retry an exporter built from now on gets, so a test that drains exports aimed at an
 * unreachable Langfuse does not sit through nine seconds of retries. `undefined` puts
 * LANGFUSE_DELIVERY_RETRY back. Production never calls it.
 */
export function setLangfuseDeliveryRetryForTest(
  retry:
    | { fetchRetryCount: number; fetchRetryDelay: number; budgetMs?: number }
    | undefined,
): void {
  deliveryRetryForTest = retry;
}

const EXPORT_ATTEMPT_TIMEOUT_MS = 10_000;
// Every attempt and pause of one export fits in this budget, which stays under the batch processor's
// 30-second export timeout, so the processor never gives up on an export that is still running.
const EXPORT_BUDGET_MS = 25_000;
// Langfuse refuses an OTLP body above its request limit, so a batch whose JSON passes this is split
// in halves until each half fits or holds a single span.
const MAX_EXPORT_BODY_BYTES = 3_500_000;

/**
 * Delivery failures are logged once per distinct message per tenant destination, so an instance that
 * stays broken does not log a line per turn. The message names the tenant and the base URL, never the
 * keys or the span content.
 */
const loggedDeliveryIssues = new Map<string, Set<string>>();

export function reportLangfuseDeliveryFailure(
  route: Pick<LangfuseRoute, "tenantId" | "baseUrl" | "publicKey">,
  detail: string,
  log: Pick<typeof logger, "warn"> = logger,
): void {
  const key = `${route.tenantId}:${route.baseUrl ?? ""}:${route.publicKey}`;
  const seen = loggedDeliveryIssues.get(key) ?? new Set<string>();
  loggedDeliveryIssues.set(key, seen);
  if (seen.has(detail)) return;
  seen.add(detail);
  log.warn(
    {
      langfuseEvent: "export",
      detail,
      tenantId: String(route.tenantId),
      baseUrl: route.baseUrl,
    },
    "langfuse trace delivery failed; traces will be missing — check the Langfuse instance (keys, URL, OTLP endpoint)",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * An OTLP endpoint can answer 200 and still refuse spans (`partialSuccess.rejectedSpans`). Those are
 * not retried, since the rest of the request was accepted, but they are a failed delivery all the
 * same. Returns the failure to report, or undefined when nothing was refused.
 */
async function rejectedSpans(res: Response): Promise<string | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await res.text());
  } catch {
    return undefined;
  }
  const partial = (parsed as { partialSuccess?: unknown } | null)
    ?.partialSuccess as
    | { rejectedSpans?: number | string; errorMessage?: string }
    | undefined;
  const count = Number(partial?.rejectedSpans ?? 0);
  if (!(count > 0)) return undefined;
  return `${count} span(s) rejected by ${res.url || "the OTLP endpoint"}${partial?.errorMessage ? `: ${partial.errorMessage}` : ""}`;
}

export const TRUNCATED_MARKER =
  " …[truncated by fazer.ai: over the Langfuse request size]";

/**
 * Fits one span over the request limit by cutting its longest text attributes (prompt, completion,
 * trace input/output), halving the cap until the body fits, so the span still lands with its model,
 * usage and timings. Returns the body to post, or undefined when even the shortest cap does not fit.
 */
function boundSpan(span: ReadableSpan): Uint8Array | undefined {
  const attrs = span.attributes as Record<string, unknown>;
  for (let cap = 1_000_000; cap >= 1_000; cap = Math.floor(cap / 2)) {
    for (const [key, value] of Object.entries(attrs)) {
      if (typeof value === "string" && value.length > cap) {
        attrs[key] = `${clipText(value, cap)}${TRUNCATED_MARKER}`;
      }
    }
    const body = JsonTraceSerializer.serializeRequest([span]);
    if (body && body.byteLength <= MAX_EXPORT_BODY_BYTES) return body;
  }
  return undefined;
}

/**
 * OTLP/HTTP JSON over `globalThis.fetch`, so delivery goes through the same fetch as every other
 * outbound call of the app, and a failure is reported with the tenant it belongs to.
 */
export class LangfuseFetchExporter implements SpanExporter {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly retry: { fetchRetryCount: number; fetchRetryDelay: number };
  private readonly budgetMs: number;
  private readonly inFlight = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(private readonly route: LangfuseRoute) {
    const base = (
      route.baseUrl?.trim() || "https://cloud.langfuse.com"
    ).replace(/\/+$/, "");
    this.url = `${base}/api/public/otel/v1/traces`;
    this.headers = {
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from(`${route.publicKey}:${route.secretKey}`).toString("base64")}`,
      "x-langfuse-public-key": route.publicKey,
      "x-langfuse-sdk-name": "javascript",
      "x-langfuse-ingestion-version": "4",
    };
    this.retry = deliveryRetryForTest ?? LANGFUSE_DELIVERY_RETRY;
    this.budgetMs = deliveryRetryForTest?.budgetMs ?? EXPORT_BUDGET_MS;
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    if (this.stopped) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error("exporter is shut down"),
      });
      return;
    }
    const sent = this.sendAll(spans).then(
      (ok) =>
        resultCallback({
          code: ok ? ExportResultCode.SUCCESS : ExportResultCode.FAILED,
        }),
      () => resultCallback({ code: ExportResultCode.FAILED }),
    );
    this.inFlight.add(sent);
    void sent.finally(() => this.inFlight.delete(sent));
  }

  private async sendAll(spans: ReadableSpan[]): Promise<boolean> {
    if (spans.length === 0) return true;
    const body = JsonTraceSerializer.serializeRequest(spans);
    if (!body) return false;
    if (body.byteLength <= MAX_EXPORT_BODY_BYTES) return this.post(body);
    if (spans.length > 1) {
      const half = Math.ceil(spans.length / 2);
      const [a, b] = await Promise.all([
        this.sendAll(spans.slice(0, half)),
        this.sendAll(spans.slice(half)),
      ]);
      return a && b;
    }
    const bounded = boundSpan(spans[0] as ReadableSpan);
    return bounded ? this.post(bounded) : false;
  }

  private async post(body: Uint8Array): Promise<boolean> {
    const deadline = Date.now() + this.budgetMs;
    let detail = "";
    for (let attempt = 0; attempt <= this.retry.fetchRetryCount; attempt++) {
      if (attempt > 0) {
        if (Date.now() + this.retry.fetchRetryDelay >= deadline) break;
        await sleep(this.retry.fetchRetryDelay);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: this.headers,
          body: new TextDecoder().decode(body),
          signal: AbortSignal.timeout(
            Math.min(EXPORT_ATTEMPT_TIMEOUT_MS, remaining),
          ),
        });
        if (res.ok) {
          const rejected = await rejectedSpans(res);
          if (rejected) reportLangfuseDeliveryFailure(this.route, rejected);
          return !rejected;
        }
        detail = `HTTP ${res.status} from ${this.url}`;
        if (res.status !== 429 && res.status < 500) break;
      } catch (err) {
        detail = `${err instanceof Error ? err.message : String(err)} (${this.url})`;
      }
    }
    reportLangfuseDeliveryFailure(this.route, detail);
    return false;
  }

  async forceFlush(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
    this.stopped = true;
  }
}

/**
 * Hands out the trace id a turn's root span must carry. OpenTelemetry asks the id generator for a
 * trace id only when a span starts with no parent, and the start is synchronous, so the id armed
 * right before that start is the one it takes.
 */
class TurnTraceIdGenerator implements IdGenerator {
  private readonly random = new RandomIdGenerator();
  armed: string | undefined;

  generateTraceId(): string {
    const id = this.armed;
    this.armed = undefined;
    return id ?? this.random.generateTraceId();
  }

  generateSpanId(): string {
    return this.random.generateSpanId();
  }
}

interface RootEntry {
  rootSpanId?: string;
  at: number;
}

interface Destination {
  processor: LangfuseSpanProcessor;
  exporter: LangfuseFetchExporter;
  sendContent: boolean;
}

interface ArmedRoute {
  routeKey: string;
  route: LangfuseRoute;
}

// A turn's root stays known this long after the last handler of that turn was built. A call that
// joins the turn later starts parentless in the same trace instead of under the root.
const ROOT_TTL_MS = 60 * 60 * 1000;

/**
 * Sends each span to the destination of the handler that started it. Every span is started
 * synchronously inside `startInTurnRoute`, which arms that handler's route for the duration of the
 * start, so the destination is a property of who created the span, never a lookup by trace id that
 * another tenant's handler could answer. A span started with nothing armed is dropped.
 */
class TenantSpanRouter implements SpanProcessor {
  private readonly destinations = new Map<string, Destination>();
  private readonly roots = new Map<string, RootEntry>();
  private readonly routed = new WeakMap<object, Destination>();
  armed: ArmedRoute | undefined;

  private destination({ routeKey, route }: ArmedRoute): Destination {
    const existing = this.destinations.get(routeKey);
    if (existing) return existing;
    const exporter = new LangfuseFetchExporter(route);
    const processor = new LangfuseSpanProcessor({
      publicKey: route.publicKey,
      secretKey: route.secretKey,
      baseUrl: route.baseUrl,
      exporter,
    });
    const dest = {
      processor,
      exporter,
      sendContent: route.sendContent === true,
    };
    this.destinations.set(routeKey, dest);
    return dest;
  }

  /** The root record of one destination's trace, refreshed on every lookup. */
  root(traceId: string, routeKey: string): RootEntry {
    const now = Date.now();
    const key = `${routeKey}|${traceId}`;
    const entry = this.roots.get(key) ?? { at: now };
    entry.at = now;
    this.roots.delete(key);
    this.roots.set(key, entry);
    for (const [k, e] of this.roots) {
      if (now - e.at < ROOT_TTL_MS) break;
      this.roots.delete(k);
    }
    return entry;
  }

  onStart(span: Span, parentContext: Parameters<SpanProcessor["onStart"]>[1]) {
    const armed = this.armed;
    if (!armed) return;
    const dest = this.destination(armed);
    this.routed.set(span, dest);
    dest.processor.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    const dest = this.routed.get(span);
    if (!dest) return;
    if (!dest.sendContent) {
      const attrs = span.attributes as Record<string, unknown>;
      for (const key of CONTENT_ATTRIBUTES) {
        if (attrs[key] !== undefined) attrs[key] = JSON.stringify(REDACTED);
      }
    }
    dest.processor.onEnd(span);
  }

  async forceFlush(): Promise<void> {
    await Promise.allSettled(
      [...this.destinations.values()].map((d) => d.processor.forceFlush()),
    );
  }

  /** Delivers everything queued, then forgets every destination and root. */
  async drain(): Promise<void> {
    const dests = [...this.destinations.values()];
    this.destinations.clear();
    this.roots.clear();
    await Promise.allSettled(dests.map((d) => d.processor.shutdown()));
    // NOTE: A processor that gave up on an export still leaves its request running in the exporter.
    await Promise.allSettled(dests.map((d) => d.exporter.shutdown()));
  }

  async shutdown(): Promise<void> {
    await this.drain();
  }
}

interface TracingState {
  router: TenantSpanRouter;
  ids: TurnTraceIdGenerator;
}

const STATE_KEY = Symbol.for("fazerai.langfuse.otel");

function state(): TracingState {
  const g = globalThis as unknown as Record<symbol, TracingState | undefined>;
  let s = g[STATE_KEY];
  if (!s) {
    // NOTE: Without a context manager OpenTelemetry's context is a no-op, and Langfuse's
    // propagateAttributes (user, session, environment, metadata on every span) silently does nothing.
    context.setGlobalContextManager(
      new AsyncLocalStorageContextManager().enable(),
    );
    const router = new TenantSpanRouter();
    const ids = new TurnTraceIdGenerator();
    const provider = new BasicTracerProvider({
      idGenerator: ids,
      spanProcessors: [router],
    });
    setLangfuseTracerProvider(provider);
    s = { router, ids };
    g[STATE_KEY] = s;
  }
  return s;
}

/**
 * The trace id of a turn: the `turnId` itself when it is a UUID (dashes dropped, which is the 32 hex
 * digits OpenTelemetry requires), otherwise the first 32 hex digits of its SHA-256.
 */
export function traceIdForTurn(turnId: string): string {
  const compact = turnId.replace(/-/g, "").toLowerCase();
  if (/^[0-9a-f]{32}$/.test(compact) && compact !== "0".repeat(32)) {
    return compact;
  }
  const digest = new Bun.CryptoHasher("sha256").update(turnId).digest();
  return Buffer.from(digest.buffer, digest.byteOffset, 16).toString("hex");
}

/** A turn's trace, bound to the tenant destination its spans are delivered to. */
export interface TurnTrace {
  traceId: string;
  routeKey: string;
  route: LangfuseRoute;
}

export function registerTurnTrace(
  traceId: string,
  routeKey: string,
  route: LangfuseRoute,
): TurnTrace {
  state().router.root(traceId, routeKey);
  return { traceId, routeKey, route };
}

/** Runs a synchronous span start with the turn's destination armed, so the span is delivered there. */
export function startInTurnRoute<T>(turn: TurnTrace, start: () => T): T {
  const { router } = state();
  const previous = router.armed;
  router.armed = { routeKey: turn.routeKey, route: turn.route };
  try {
    return start();
  } finally {
    router.armed = previous;
  }
}

/**
 * Starts a top-level observation of a turn's trace. The turn's own root (`asTurnRoot`) starts with no
 * parent under the turn's trace id and is remembered; any other top-level call (a guardrail, the
 * speech normalizer, a generation written by hand) becomes a child of that root when the root already
 * exists, so it cannot take the trace's name and input/output, and otherwise starts as a parentless
 * span of the same trace that is told it is not the trace's root.
 */
export function startInTurnTrace<T extends { id: string; otelSpan: ApiSpan }>(
  turn: TurnTrace,
  asTurnRoot: boolean,
  start: () => T,
): T {
  const { ids, router } = state();
  const root = router.root(turn.traceId, turn.routeKey);
  if (!asTurnRoot && root.rootSpanId) {
    const parent: SpanContext = {
      traceId: turn.traceId,
      spanId: root.rootSpanId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    };
    const child = startInTurnRoute(turn, () =>
      context.with(trace.setSpanContext(context.active(), parent), start),
    );
    // NOTE: Langfuse marks a span whose parent it no longer tracks (the root already ended) as an app
    // root, which would let this call take the trace's headline.
    child.otelSpan.setAttribute(LangfuseOtelSpanAttributes.IS_APP_ROOT, false);
    return child;
  }
  ids.armed = turn.traceId;
  let observation: T;
  try {
    observation = startInTurnRoute(turn, () =>
      context.with(trace.deleteSpan(context.active()), start),
    );
  } finally {
    ids.armed = undefined;
  }
  if (asTurnRoot) {
    root.rootSpanId = observation.id;
  } else {
    observation.otelSpan.setAttribute(
      LangfuseOtelSpanAttributes.IS_APP_ROOT,
      false,
    );
  }
  return observation;
}

/** Delivers every span queued for any tenant and forgets all destinations. Never rejects. */
export async function drainLangfuseTracing(): Promise<void> {
  const g = globalThis as unknown as Record<symbol, TracingState | undefined>;
  const s = g[STATE_KEY];
  if (!s) return;
  await s.router.drain();
}
