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

import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { buildHttpTool, type HttpToolDef } from "@/graph/tools/http";
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
import { readHttpMethod } from "./service";

// What the operator gets back to paste into the sample field, and it is the RAW response, not the
// clipped one the model sees: the whole point is to pick paths out of it, including the ones past
// the clip. Bounded because it crosses the wire into a browser; the response this feature was
// measured against is 8kB.
const MAX_RAW_CHARS = 100_000;

// Shorter patience than a turn's 10s default, because somebody is watching a modal rather than a
// conversation, and a request slower than this is a finding rather than a result.
const TEST_TIMEOUT_MS = 15_000;

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
  fetchImpl?: typeof fetch;
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
  const method = readHttpMethod(d.method ?? "GET");
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
  const meta = credentialRef
    ? await readCredentialMeta(base, ctx, credentialRef)
    : null;

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
  let seen: { status: number; body: string } | null = null;
  const doFetch = deps.fetchImpl ?? fetch;
  const tool = buildHttpTool(def, {
    resolveCredential: (ref) =>
      resolveInjectableCredential(base, tenantId, ref),
    timeoutMs: TEST_TIMEOUT_MS,
    context,
    onSideEffectError: (e) =>
      notes.push({
        phase: e.phase,
        message: e.err instanceof Error ? e.err.message : String(e.err),
        ...(e.detail ? { detail: e.detail } : {}),
      }),
    // The raw body is taken HERE, on the way in, because everything downstream of this point is the
    // model's view: rendered, clipped, prefixed. The operator needs the provider's own answer.
    fetchImpl: (async (url: string, init: RequestInit) => {
      const res = await doFetch(url, init);
      const body = await res.text();
      seen = { status: res.status, body };
      return new Response(body, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    }) as unknown as typeof fetch,
  });

  const startedAt = Date.now();
  const out = await tool.invoke(input.args ?? {});
  const durationMs = Date.now() - startedAt;
  const captured = seen as { status: number; body: string } | null;

  const message = out as { content?: unknown; status?: unknown };
  const modelText = String(message?.content ?? out);
  if (!captured) {
    // Nothing went out: a placeholder with no value, a host off the allowlist, a credential that did
    // not resolve. `buildHttpTool` already put the reason in what it returned, so hand that over
    // rather than inventing a second sentence for the same refusal.
    throw new AppError(modelText, 400);
  }

  return {
    status: captured.status,
    durationMs,
    raw: clipText(captured.body, MAX_RAW_CHARS),
    rawChars: captured.body.length,
    rawClipped: captured.body.length > MAX_RAW_CHARS,
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
