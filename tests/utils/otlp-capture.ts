/**
 * Reads OTLP/HTTP JSON request bodies (what the Langfuse exporter POSTs to
 * `/api/public/otel/v1/traces`) into flat spans with decoded attributes.
 */
export const LANGFUSE_OTLP_PATH = "/api/public/otel/v1/traces";

export interface FlatSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  attrs: Record<string, unknown>;
}

type OtlpValue = {
  stringValue?: string;
  intValue?: number | string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: OtlpValue[] };
};

function decodeValue(v: OtlpValue): unknown {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(decodeValue);
  return undefined;
}

export function otlpSpans(bodies: string[]): FlatSpan[] {
  const out: FlatSpan[] = [];
  for (const body of bodies) {
    const req = JSON.parse(body) as {
      resourceSpans?: Array<{
        scopeSpans?: Array<{
          spans?: Array<{
            traceId: string;
            spanId: string;
            parentSpanId?: string;
            name: string;
            attributes?: Array<{ key: string; value: OtlpValue }>;
          }>;
        }>;
      }>;
    };
    for (const rs of req.resourceSpans ?? []) {
      for (const ss of rs.scopeSpans ?? []) {
        for (const s of ss.spans ?? []) {
          const attrs: Record<string, unknown> = {};
          for (const a of s.attributes ?? [])
            attrs[a.key] = decodeValue(a.value);
          out.push({
            traceId: s.traceId,
            spanId: s.spanId,
            parentSpanId: s.parentSpanId || undefined,
            name: s.name,
            attrs,
          });
        }
      }
    }
  }
  return out;
}

/** A JSON-encoded span attribute (trace metadata values, usage details) decoded. */
export function jsonAttr(attrs: Record<string, unknown>, key: string): unknown {
  const raw = attrs[key];
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

/** A trace metadata value as Langfuse reads it: the SDK writes each one JSON-encoded. */
export function meta(attrs: Record<string, unknown>, key: string): unknown {
  return jsonAttr(attrs, `langfuse.trace.metadata.${key}`);
}
