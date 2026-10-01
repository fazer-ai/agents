// Run an unsaved HTTP tool definition ONCE, from the editor, and hand the operator back both what
// the provider answered and what the model would have been given (docs/graph.md). It adds no
// capability: the request goes out through `buildHttpTool`, so every guard is the runtime's own.
// It registers nothing: no appointment closures (testing the tool that books must not book) and no
// ack (no customer is on the other end, and it would require `__wait_message`).

import { ToolInputParsingException } from "@langchain/core/tools";
import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import {
  buildHttpTool,
  CONVERSATION_REF_VAR,
  DEFAULT_HTTP_TOOL_TIMEOUT_MS,
  type HttpToolDef,
} from "@/graph/tools/http";
import {
  isExpectedResult,
  normalizeExpectedStatuses,
} from "@/graph/tools/http-status";
import { AppError } from "@/lib/errors";
import {
  type OutboundBody,
  OutboundTimeoutError,
  readCappedBody,
} from "@/lib/outbound";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { resolveInjectableCredential } from "@/modules/vault/injectable";
import {
  dialableBaseUrl,
  formatVaultRef,
  readVaultRefId,
} from "@/modules/vault/service";
import { unsupportedBodyShape } from "./body-shape";
import {
  CONTEXT_VAR_NAMES,
  normalizeToolShapes,
  renderedVariableNames,
} from "./normalize";
import { readResponseTemplateResult } from "./response-template";
import {
  assertMaxResponseChars,
  DEFAULT_HTTP_METHOD,
  readHttpMethod,
} from "./service";

// A DISPLAY bound on the RAW response the operator picks paths from (not the model's clipped view).
// Tighter than the runtime's MAX_OUTBOUND_BODY_CHARS on purpose: `modelText` comes from the runtime
// itself, so this number never changes what the screen says the model gets.
const MAX_RAW_CHARS = 100_000;

// The timeout is the RUNTIME'S (`DEFAULT_HTTP_TOOL_TIMEOUT_MS`): a more patient test would report a
// clean 200 for an endpoint that aborts on every real call.

export interface ToolTestInput {
  // The definition being edited, unsaved. Same field names the write body uses.
  definition: {
    name?: string;
    method?: string;
    urlTemplate: string;
    allowedHosts?: string[];
    headers?: Record<string, unknown>;
    inputSchema?: Record<string, unknown>;
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
    credentialRef?: string | null;
    expectedStatuses?: number[];
    outputSchema?: Record<string, unknown>;
    maxResponseChars?: number | null;
  };
  // Values for the AI-filled fields, as the model would have supplied them.
  args?: Record<string, unknown>;
  // Values for the conversation/contact placeholders, which no model supplies and no test has.
  // Filtered to the names the runtime actually interpolates, so this cannot become a second way to
  // introduce a variable the editor does not know about.
  context?: Record<string, string>;
}

export interface ToolTestNote {
  phase: string;
  message: string;
  detail?: Record<string, unknown>;
}

export interface ToolTestResult {
  status: number;
  durationMs: number;
  // The provider's response, whole (up to the wire cap). Never the REQUEST: those headers carry the
  // credential, and echoing them back is how a write-only secret stops being write-only.
  raw: string;
  rawChars: number;
  rawClipped: boolean;
  // What the model would receive, verbatim: the same string the tool returns mid-turn, template
  // rendered and clipped exactly as it would be. This is the answer the operator came for, and
  // deriving it a second time here would be a second reader of the same question.
  modelText: string;
  // True when the tool call was marked an integration failure rather than a result.
  failed: boolean;
  // What the runtime would have written on the `tool` stage: an unresolved template path, a body
  // that is not JSON, a response clipped with no template. On screen instead of in the Logs page,
  // because the operator is standing right here.
  notes: ToolTestNote[];
}

const CONTEXT_NAMES = new Set<string>(CONTEXT_VAR_NAMES);

export interface ToolTestDeps {
  // Test seams; production passes none. A provider that never answers and a credential store that
  // fails cannot otherwise be produced without waiting or breaking a database.
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  resolveCredentialImpl?: (ref: string) => Promise<string | null>;
}

export async function runToolTest(
  ctx: TenantContext,
  input: ToolTestInput,
  base: PrismaClient = basePrisma,
  deps: ToolTestDeps = {},
): Promise<ToolTestResult> {
  const tenantId = ctx.tenantId;
  if (tenantId === null) throw new AppError("tenant required", 400);
  const d = input.definition;
  // The SAME five methods the write schema accepts, or this endpoint would let a TENANT_ADMIN
  // make the server issue a `PURGE` or `CONNECT`, which saving the definition does not allow.
  const method = readHttpMethod(d.method ?? DEFAULT_HTTP_METHOD);
  if (method === null) {
    throw new AppError(
      `method must be one of GET, POST, PUT, PATCH, DELETE (got ${String(d.method)})`,
      400,
    );
  }
  // The WRITE path's other two gates, before anything goes out, so a shape the save refuses
  // is never previewed. The body first: `parseBody` ignores unknown keys, so an unsupported shape
  // would silently send a DIFFERENT payload.
  const badBody = unsupportedBodyShape(d.body);
  if (badBody) throw new AppError(badBody, 400);
  // Then the response template, judged by the reader the write schema refines with, so an
  // undeclared shape (a legacy JSON Schema written through MCP) still passes.
  const tpl = readResponseTemplateResult(d.outputSchema);
  if (tpl.declared && !tpl.ok) throw new AppError(tpl.problem, 400);
  assertMaxResponseChars(d.maxResponseChars);

  // NOTE: a test run has no conversation for `{{conversation_ref}}`. Refused up front because the
  // runtime's own refusal would read as a problem with a definition that may be fine.
  if (
    renderedVariableNames(
      normalizeToolShapes({
        urlTemplate: d.urlTemplate,
        headers: d.headers,
        query: d.query,
        body: d.body,
        inputSchema: d.inputSchema,
      }).shapes,
    ).has(CONVERSATION_REF_VAR)
  ) {
    throw new AppError(
      "this tool sends {{conversation_ref}}, which only exists inside a conversation: a test run has none to hand. Try it from a test conversation instead.",
      400,
    );
  }

  const credentialRef = d.credentialRef || null;
  // The credential's metadata, read where the turn reads it, so a typed credential
  // auto-injects as in production. Wrapped because it runs before the try around `invoke`, and a
  // store failure must still carry its reason.
  let meta: Awaited<ReturnType<typeof readCredentialMeta>> = null;
  if (credentialRef) {
    try {
      meta = await readCredentialMeta(base, ctx, credentialRef);
    } catch (err) {
      throw new AppError(
        `the credential could not be read: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
  }

  const def: HttpToolDef = {
    name: d.name || "tool_test",
    method,
    urlTemplate: d.urlTemplate,
    allowedHosts: d.allowedHosts ?? [],
    headers: (d.headers ?? {}) as Record<string, string>,
    inputSchema: d.inputSchema ?? {},
    query: d.query,
    body: d.body,
    expectedStatuses: d.expectedStatuses ?? [],
    credentialRef,
    credentialKind: meta?.kind ?? null,
    credentialParamName: meta?.paramName ?? null,
    credentialBaseUrl: meta?.baseUrl ?? null,
    ackMessage: null,
    outputSchema: d.outputSchema,
    maxResponseChars: d.maxResponseChars ?? null,
  };

  const context: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.context ?? {})) {
    if (CONTEXT_NAMES.has(k) && typeof v === "string") context[k] = v;
  }

  const notes: ToolTestNote[] = [];
  let seen: { status: number; body: Promise<OutboundBody> } | null = null;
  const doFetch = deps.fetchImpl ?? fetch;
  const tool = buildHttpTool(def, {
    // NOTE: a failure to READ the credential is ours, not the definition's, so it carries 500
    // through the `AppError` passthrough below.
    resolveCredential: async (ref) => {
      try {
        return await (deps.resolveCredentialImpl
          ? deps.resolveCredentialImpl(ref)
          : resolveInjectableCredential(base, tenantId, ref));
      } catch (err) {
        throw new AppError(
          `the credential could not be read: ${err instanceof Error ? err.message : String(err)}`,
          500,
        );
      }
    },
    timeoutMs: deps.timeoutMs ?? DEFAULT_HTTP_TOOL_TIMEOUT_MS,
    context,
    onSideEffectError: (e) =>
      notes.push({
        phase: e.phase,
        message: e.err instanceof Error ? e.err.message : String(e.err),
        ...(e.detail ? { detail: e.detail } : {}),
      }),
    // NOTE: the raw body is taken here, before the model's view (rendered, clipped) exists. From a
    // CLONE, not awaited, so the runtime's read is not held and `res` stays untouched. No deadline
    // of its own: `fetchBounded` bounds the whole exchange and the clone errors under that abort.
    fetchImpl: (async (url: string, init: RequestInit) => {
      const res = await doFetch(url, init);
      // `.catch` rather than a bare promise: when the runtime's bound cuts the exchange this
      // rejects too, and an unobserved rejection would be a crash rather than a refusal. The value
      // is read only on the path where the call succeeded.
      seen = {
        status: res.status,
        body: readCappedBody(res.clone(), MAX_RAW_CHARS).catch(() => ({
          text: "",
          chars: 0,
        })),
      };
      return res;
    }) as unknown as typeof fetch,
  });

  const startedAt = Date.now();
  // `invoke` THROWS whatever stops a call (mid-turn LangGraph catches it; here nothing would),
  // so each throw is sorted to a status. AppError is kept as sent (the definition's own refusals are
  // 400, SsrfError included; the credential read is 500). A timeout is 504. Anything else (DNS, TLS,
  // a body the provider broke) is 502, not 400: the definition may be fine.
  let out: unknown;
  try {
    out = await tool.invoke(input.args ?? {});
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof ToolInputParsingException) {
      // The declared schema refused the operator's own values, and its message names the field.
      throw new AppError(err.message, 400);
    }
    const message = err instanceof Error ? err.message : String(err);
    // A body cut mid-read by the runtime's bound surfaces as `EncodingError`, like a broken
    // stream, so only `OutboundTimeoutError` says the bound did it. Its message names the real
    // bound, so it travels as written.
    const timedOut =
      err instanceof OutboundTimeoutError ||
      (err instanceof Error && err.name === "AbortError");
    throw new AppError(
      err instanceof OutboundTimeoutError
        ? message
        : timedOut
          ? `the provider did not answer within ${DEFAULT_HTTP_TOOL_TIMEOUT_MS / 1000}s: ${message}`
          : message,
      timedOut ? 504 : 502,
    );
  }
  const durationMs = Date.now() - startedAt;
  const captured = seen as {
    status: number;
    body: Promise<OutboundBody>;
  } | null;

  const message = out as { content?: unknown; status?: unknown };
  const modelText = String(message?.content ?? out);
  if (!captured) {
    // Nothing went out and nothing threw: a refusal `buildHttpTool` chose to RETURN. It already put
    // the reason in what it returned, so hand that over rather than inventing a second sentence.
    throw new AppError(modelText, 400);
  }

  const rawBody = await captured.body;

  return {
    status: captured.status,
    durationMs,
    raw: rawBody.text,
    rawChars: rawBody.chars,
    rawClipped: rawBody.chars > MAX_RAW_CHARS,
    modelText,
    // The tool marks an integration failure by returning a ToolMessage with status "error"; without
    // a tool_call in scope (which is this call) that degrades to the plain string, so the status is
    // read where it exists and the fallback is the rule the runtime used to decide it.
    failed:
      message?.status === "error" ||
      !isExpectedResult(
        captured.status,
        normalizeExpectedStatuses(def.expectedStatuses),
      ),
    notes,
  };
}

async function readCredentialMeta(
  base: PrismaClient,
  ctx: TenantContext,
  ref: string,
): Promise<{
  kind: string | null;
  paramName: string | null;
  baseUrl: string | null;
} | null> {
  const id = readVaultRefId(ref);
  if (id === null) return null;
  return runScopedOn(base, ctx, async (db) => {
    const entry = await db.vaultEntry.findUnique({
      where: { id },
      select: { id: true, kind: true, paramName: true, baseUrl: true },
    });
    if (!entry || formatVaultRef(entry.id) !== ref) return null;
    return {
      kind: entry.kind,
      paramName: entry.paramName,
      baseUrl: dialableBaseUrl(entry.kind, entry.baseUrl),
    };
  });
}
