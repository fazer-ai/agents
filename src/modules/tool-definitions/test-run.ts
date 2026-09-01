// Run an HTTP tool definition ONCE, from the editor, and hand the operator back both what the
// provider answered and what the model would have been given (issue #456).
//
// WHY THIS EXISTS. Declaring a response template means naming paths into a response, and the paths
// only exist if you have a response. Before this, the only way to get one was to save the tool,
// grant it to an agent, coax the agent into calling it and read the trace — a loop long enough that
// operators guess the paths instead, and a guessed path is exactly the silent mis-aim the picker
// was built to remove. One button closes it: the definition on screen, unsaved, against the real
// API.
//
// IT ADDS NO CAPABILITY. Whoever reaches this can already save the definition, grant it and call it
// from the playground; what changes is the length of the loop, not what the operator can make the
// server do. Which is why none of the guards are restated here — the request goes out through
// `buildHttpTool`, exactly as a turn's would, so the host allowlist, the SSRF guard, the
// no-redirect rule and the bounded timeout are the same code. A second fetch path would be a second
// place for those to age.
//
// AND IT REGISTERS NOTHING. `appointmentBooked` / `cancelAppointment` are deliberately not wired:
// testing the tool that books must not book, and must not arm reminders. `emitAck` is out for the
// same reason — there is no customer on the other end of this, and wiring the ack would also make
// `__wait_message` a required argument of a schema the operator never filled.

import { ToolInputParsingException } from "@langchain/core/tools";
import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import {
  buildHttpTool,
  DEFAULT_HTTP_TOOL_TIMEOUT_MS,
  type HttpToolDef,
} from "@/graph/tools/http";
import {
  isExpectedResult,
  normalizeExpectedStatuses,
} from "@/graph/tools/http-status";
import { AppError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { clipText } from "@/lib/text";
import { resolveInjectableCredential } from "@/modules/vault/injectable";
import { formatVaultRef, readVaultRefId } from "@/modules/vault/service";
import { CONTEXT_VAR_NAMES } from "./normalize";
import { DEFAULT_HTTP_METHOD, readHttpMethod } from "./service";

// What the operator gets back to paste into the sample field, and it is the RAW response, not the
// clipped one the model sees: the whole point is to pick paths out of it, including the ones past
// the clip. Bounded because it crosses the wire into a browser; the response this feature was
// measured against is 8kB.
const MAX_RAW_CHARS = 100_000;

// The RUNTIME'S patience, not a friendlier one. A test more patient than a turn answers the wrong
// question: an endpoint that takes 12s would report a clean 200 here and abort on every real
// call, and the operator would have measured the one number this screen exists to show them.
// Imported rather than restated so the two cannot drift.

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
  // Test seams, both of them, and both narrow on purpose: production passes neither. They exist
  // because the two things this module has to classify correctly — a provider that never answers,
  // a credential store that fails — cannot be produced from the outside without waiting ten seconds
  // or breaking a database.
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
  // The SAME five methods the write schema accepts, and refused here rather than passed through.
  // Without this the endpoint is the one place a TENANT_ADMIN can make the server issue a `PURGE`
  // or a `CONNECT` — which is a capability that saving the definition and calling it does not give
  // them, and "adds no capability over what you can already do" is the whole argument for this
  // endpoint existing.
  const method = readHttpMethod(d.method ?? DEFAULT_HTTP_METHOD);
  if (method === null) {
    throw new AppError(
      `method must be one of GET, POST, PUT, PATCH, DELETE (got ${String(d.method)})`,
      400,
    );
  }
  const credentialRef = d.credentialRef || null;
  // The credential's own metadata, read where the turn reads it, so a typed credential auto-injects
  // here the way it will in production. A ref naming nothing yields no metadata, which is the same
  // "no auto-injection" the runtime falls back to.
  //
  // Wrapped like the injection read below, and for the same reason: this one runs BEFORE the try
  // around `invoke`, so a store that cannot answer here escaped as a bare throw with no status —
  // a 500 with the reason stripped off, for the one failure in this function that really is a 500.
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
  };

  const context: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.context ?? {})) {
    if (CONTEXT_NAMES.has(k) && typeof v === "string") context[k] = v;
  }

  const notes: ToolTestNote[] = [];
  let seen: { status: number; body: Promise<string> } | null = null;
  const doFetch = deps.fetchImpl ?? fetch;
  const tool = buildHttpTool(def, {
    // Wrapped so that a failure to READ the credential is not read as a failure of the definition.
    // It is the one thing inside `invoke` that is ours rather than the operator's or the provider's,
    // and it is what makes the `AppError` passthrough below a branch with a case rather than an
    // identity: it is the only status in here that is not a 4xx.
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
    // The raw body is taken HERE, on the way in, because everything downstream of this point is the
    // model's view: rendered, clipped, prefixed. The operator needs the provider's own answer.
    //
    // From a CLONE, and not awaited before returning, because both halves of that are timing. The
    // runtime clears its abort timer the instant `fetch` resolves and reads the body afterwards, so
    // production bounds the wait for HEADERS and not for the body. Reading here, inside the call,
    // put the body read back under the armed timer: measured against a provider that answers at
    // once and streams its body 800ms later with a 300ms timeout, the runtime returns `HTTP 200
    // {"a":1}` and this returned "The operation was aborted." — the same definition, against the
    // same provider, behaving differently on the screen built to preview it. Returning `res`
    // untouched also means there is no reconstructed Response to get wrong: a 204 or a 304 stays
    // exactly the object the runtime would have read.
    fetchImpl: (async (url: string, init: RequestInit) => {
      const res = await doFetch(url, init);
      // `.catch` rather than a bare promise: when the runtime aborts, this rejects too, and an
      // unobserved rejection would be a crash rather than a refusal. The value is read only on the
      // path where the call succeeded.
      seen = {
        status: res.status,
        body: res
          .clone()
          .text()
          .catch(() => ""),
      };
      return res;
    }) as unknown as typeof fetch,
  });

  const startedAt = Date.now();
  // WHY THE THROWS ARE CAUGHT HERE, AND HOW THEY ARE SORTED. `buildHttpTool` has no outer catch:
  // everything that stops a call — a host off the allowlist, a URL the SSRF guard blocks, a name
  // with no value, an argument the declared type refuses, a DNS failure, the abort — THROWS out of
  // `invoke`. Mid-turn LangGraph catches those and hands the model the message; there is no
  // LangGraph here, so an uncaught one reaches Elysia with no status at all and surfaces as a 500.
  //
  // The first version of this made every throw a 400, on the reasoning that everything reachable in
  // here is the caller's to fix. That is wrong for half of them, and review round 6 was right to
  // say so: a name that does not resolve, a TLS handshake that fails, a provider that does not
  // answer inside the bound — none of those is a malformed request, and answering 400 tells the
  // operator to go and edit a definition that is fine. What each one IS, measured rather than
  // guessed:
  //
  //   AppError        the definition's own refusals, already carrying 400 (SsrfError is one of
  //                   these), plus the credential read above, which carries 500. Kept as sent.
  //   AbortError      the provider did not answer inside the runtime's bound -> 504.
  //   anything else   DNSException (`getaddrinfo ENOTFOUND`), EncodingError (a body that stopped
  //                   mid-stream), TLS -> 502. The message travels either way, because it is the
  //                   only thing that says what to do next.
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
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new AppError(
      aborted
        ? `the provider did not answer within ${DEFAULT_HTTP_TOOL_TIMEOUT_MS / 1000}s: ${message}`
        : message,
      aborted ? 504 : 502,
    );
  }
  const durationMs = Date.now() - startedAt;
  const captured = seen as { status: number; body: Promise<string> } | null;

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
    raw: clipText(rawBody, MAX_RAW_CHARS),
    rawChars: rawBody.length,
    rawClipped: rawBody.length > MAX_RAW_CHARS,
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
      baseUrl: entry.baseUrl,
    };
  });
}
