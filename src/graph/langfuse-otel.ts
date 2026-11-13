/**
 * The OpenTelemetry transport behind Langfuse tracing (docs/graph.md, Langfuse tracing). There is one
 * tracer provider per process and every tenant traces into its own Langfuse project, so the provider's
 * only span processor is a router: each span goes to the destination of the tenant that registered
 * its trace id, a span of an unregistered trace is dropped, and content is redacted in the router
 * before a span reaches any processor when the tenant did not opt into sending it.
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
  | { fetchRetryCount: number; fetchRetryDelay: number }
  | undefined;

/**
 * Test-only: the retry an exporter built from now on gets, so a test that drains exports aimed at an
 * unreachable Langfuse does not sit through nine seconds of retries. `undefined` puts
 * LANGFUSE_DELIVERY_RETRY back. Production never calls it.
 */
export function setLangfuseDeliveryRetryForTest(
  retry: { fetchRetryCount: number; fetchRetryDelay: number } | undefined,
): void {
  deliveryRetryForTest = retry;
}

const EXPORT_ATTEMPT_TIMEOUT_MS = 10_000;
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
 * OTLP/HTTP JSON over `globalThis.fetch`, so delivery goes through the same fetch as every other
 * outbound call of the app, and a failure is reported with the tenant it belongs to.
 */
export class LangfuseFetchExporter implements SpanExporter {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly retry: { fetchRetryCount: number; fetchRetryDelay: number };
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
    if (body.byteLength > MAX_EXPORT_BODY_BYTES && spans.length > 1) {
      const half = Math.ceil(spans.length / 2);
      const [a, b] = await Promise.all([
        this.sendAll(spans.slice(0, half)),
        this.sendAll(spans.slice(half)),
      ]);
      return a && b;
    }
    return this.post(body);
  }

  private async post(body: Uint8Array): Promise<boolean> {
    let detail = "";
    for (let attempt = 0; attempt <= this.retry.fetchRetryCount; attempt++) {
      if (attempt > 0) await sleep(this.retry.fetchRetryDelay);
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: this.headers,
          body: new TextDecoder().decode(body),
          signal: AbortSignal.timeout(EXPORT_ATTEMPT_TIMEOUT_MS),
        });
        if (res.ok) return true;
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

interface TraceEntry {
  routeKey: string;
  rootSpanId?: string;
  at: number;
}

interface Destination {
  processor: LangfuseSpanProcessor;
  sendContent: boolean;
}

// A trace stays routable this long after its last registration. A turn and the calls that join its
// trace finish within it; a span started later has no destination and is dropped.
const TRACE_ROUTE_TTL_MS = 60 * 60 * 1000;

class TenantSpanRouter implements SpanProcessor {
  private readonly destinations = new Map<string, Destination>();
  private readonly traces = new Map<string, TraceEntry>();
  private readonly routed = new WeakMap<object, Destination>();

  destination(routeKey: string, route: LangfuseRoute): void {
    if (this.destinations.has(routeKey)) return;
    const processor = new LangfuseSpanProcessor({
      publicKey: route.publicKey,
      secretKey: route.secretKey,
      baseUrl: route.baseUrl,
      exporter: new LangfuseFetchExporter(route),
    });
    this.destinations.set(routeKey, {
      processor,
      sendContent: route.sendContent === true,
    });
  }

  /**
   * Binds a trace id to a destination. Every handler of the turn registers the same trace, so a
   * registration for the same destination refreshes the existing entry in place and keeps the root it
   * already knows; a different destination (rotated keys) starts a fresh entry.
   */
  register(traceId: string, routeKey: string): void {
    const now = Date.now();
    const existing = this.traces.get(traceId);
    const entry: TraceEntry =
      existing?.routeKey === routeKey ? existing : { routeKey, at: now };
    entry.at = now;
    this.traces.delete(traceId);
    this.traces.set(traceId, entry);
    for (const [id, e] of this.traces) {
      if (now - e.at < TRACE_ROUTE_TTL_MS) break;
      this.traces.delete(id);
    }
  }

  /** The current entry of a trace, as long as it still routes to `routeKey`. */
  entry(traceId: string, routeKey: string): TraceEntry | undefined {
    const entry = this.traces.get(traceId);
    return entry?.routeKey === routeKey ? entry : undefined;
  }

  onStart(span: Span, parentContext: Parameters<SpanProcessor["onStart"]>[1]) {
    const entry = this.traces.get(span.spanContext().traceId);
    const dest = entry ? this.destinations.get(entry.routeKey) : undefined;
    if (!dest) return;
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

  /** Delivers everything queued, then forgets every destination and trace route. */
  async drain(): Promise<void> {
    const dests = [...this.destinations.values()];
    this.destinations.clear();
    this.traces.clear();
    await Promise.allSettled(dests.map((d) => d.processor.shutdown()));
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
}

export function registerTurnTrace(
  traceId: string,
  routeKey: string,
  route: LangfuseRoute,
): TurnTrace {
  const { router } = state();
  router.destination(routeKey, route);
  router.register(traceId, routeKey);
  return { traceId, routeKey };
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
  const rootSpanId = router.entry(turn.traceId, turn.routeKey)?.rootSpanId;
  if (!asTurnRoot && rootSpanId) {
    const parent: SpanContext = {
      traceId: turn.traceId,
      spanId: rootSpanId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    };
    const child = context.with(
      trace.setSpanContext(context.active(), parent),
      start,
    );
    // NOTE: Langfuse marks a span whose parent it no longer tracks (the root already ended) as an app
    // root, which would let this call take the trace's headline.
    child.otelSpan.setAttribute(LangfuseOtelSpanAttributes.IS_APP_ROOT, false);
    return child;
  }
  ids.armed = turn.traceId;
  let observation: T;
  try {
    observation = context.with(trace.deleteSpan(context.active()), start);
  } finally {
    ids.armed = undefined;
  }
  if (asTurnRoot) {
    const entry = router.entry(turn.traceId, turn.routeKey);
    if (entry) entry.rootSpanId = observation.id;
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
