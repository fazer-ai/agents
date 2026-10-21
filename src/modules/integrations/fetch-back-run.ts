// Runs a GENERIC instance's consult-back tool once, for one resource id, outside any conversation.
// Through `runToolTest`, the editor's own one-shot execution, so the request goes out through
// `buildHttpTool` with every runtime guard (origin pin, allowedHosts, the SSRF guard on the final
// URL, the runtime timeout, the response cap, the vault credential) and no second copy of them.

import type { PrismaClient } from "@/../generated/prisma/client";
import { AppError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  CONTEXT_VAR_NAMES,
  HTTP_TOOL_ONLY_VAR_NAMES,
  normalizeToolShapes,
  renderedVariableNames,
} from "@/modules/tool-definitions/normalize";
import {
  runToolTest,
  type ToolTestDeps,
} from "@/modules/tool-definitions/test-run";

export type FetchBackOutcome =
  | { ok: true; status: number; response: unknown }
  // `retry`: the provider or the network failed, and the same id may answer later. Otherwise the
  // tool or its answer cannot be used as configured, and a retry would answer the same.
  | { ok: false; retry: boolean; reason: string };

const CONVERSATION_VARS = new Set<string>([
  ...CONTEXT_VAR_NAMES,
  ...HTTP_TOOL_ONLY_VAR_NAMES,
]);

const TOOL_SELECT = {
  id: true,
  name: true,
  enabled: true,
  method: true,
  urlTemplate: true,
  allowedHosts: true,
  headers: true,
  inputSchema: true,
  query: true,
  body: true,
  credentialRef: true,
  expectedStatuses: true,
  outputSchema: true,
  maxResponseChars: true,
} as const;

// Why the tool cannot serve a consult-back, or null. Asked by the writer (so the save refuses it)
// and by the run (so a tool edited after the save refuses instead of rendering an empty variable).
export function fetchBackToolProblem(
  tool: {
    enabled: boolean;
    urlTemplate: string;
    headers: unknown;
    query: unknown;
    body: unknown;
    inputSchema: unknown;
  } | null,
  idArg: string,
): string | null {
  if (!tool) return "names no HTTP tool of this workspace";
  if (!tool.enabled) return "names a tool that is disabled";
  const shapes = normalizeToolShapes({
    urlTemplate: tool.urlTemplate,
    headers: tool.headers as Record<string, unknown>,
    query: tool.query as Record<string, unknown>,
    body: tool.body as Record<string, unknown>,
    inputSchema: tool.inputSchema as Record<string, unknown>,
  }).shapes;
  const conversational = [...renderedVariableNames(shapes)].filter((n) =>
    CONVERSATION_VARS.has(n),
  );
  if (conversational.length) {
    return `names a tool that renders ${conversational.map((n) => `{{${n}}}`).join(", ")}, which only exists inside a conversation`;
  }
  const schema = shapes.inputSchema;
  const field =
    schema && typeof schema === "object" && !Array.isArray(schema)
      ? (schema as Record<string, unknown>)[idArg]
      : undefined;
  if (
    !field ||
    typeof field !== "object" ||
    (field as Record<string, unknown>).source === "fixed"
  ) {
    return `names a tool with no field "${idArg}" for the id`;
  }
  // The lookup hands the tool one text argument and nothing else, so the id field has to take text
  // and no other field may be one the call cannot run without.
  const type = (field as Record<string, unknown>).type;
  if (type !== undefined && type !== "string") {
    return `names a tool whose field "${idArg}" is not text`;
  }
  const others = Object.entries(schema as Record<string, unknown>).filter(
    ([k, v]) =>
      k !== idArg &&
      v !== null &&
      typeof v === "object" &&
      (v as Record<string, unknown>).source !== "fixed" &&
      (v as Record<string, unknown>).required === true,
  );
  if (others.length) {
    return `names a tool that also requires ${others.map(([k]) => `"${k}"`).join(", ")}, which a lookup cannot fill`;
  }
  return null;
}

export async function loadFetchBackTool(
  base: PrismaClient,
  ctx: TenantContext,
  toolId: bigint,
) {
  return runScopedOn(base, ctx, (db) =>
    db.toolDefinition.findUnique({
      where: { id: toolId },
      select: TOOL_SELECT,
    }),
  );
}

export async function runFetchBack(params: {
  base: PrismaClient;
  tenantId: bigint;
  toolId: bigint;
  idArg: string;
  resourceId: string;
  deps?: ToolTestDeps;
}): Promise<FetchBackOutcome> {
  const ctx: TenantContext = {
    tenantId: params.tenantId,
    userId: null,
    role: "TENANT_ADMIN",
  };
  const tool = await loadFetchBackTool(params.base, ctx, params.toolId);
  const problem = fetchBackToolProblem(tool, params.idArg);
  if (problem || !tool) {
    return { ok: false, retry: false, reason: `the consult-back ${problem}` };
  }
  let result: Awaited<ReturnType<typeof runToolTest>>;
  try {
    result = await runToolTest(
      ctx,
      {
        definition: {
          name: tool.name,
          method: tool.method,
          urlTemplate: tool.urlTemplate,
          allowedHosts: tool.allowedHosts,
          headers: tool.headers as Record<string, unknown>,
          inputSchema: tool.inputSchema as Record<string, unknown>,
          query: tool.query as Record<string, unknown>,
          body: tool.body as Record<string, unknown>,
          credentialRef: tool.credentialRef,
          expectedStatuses: tool.expectedStatuses,
          outputSchema: tool.outputSchema as Record<string, unknown>,
          maxResponseChars: tool.maxResponseChars,
        },
        args: { [params.idArg]: params.resourceId },
      },
      params.base,
      params.deps,
    );
  } catch (err) {
    const status = err instanceof AppError ? err.statusCode : 502;
    return {
      ok: false,
      retry: status >= 500,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  if (result.status >= 500 || result.status === 429) {
    return {
      ok: false,
      retry: true,
      reason: `the provider answered HTTP ${result.status}`,
    };
  }
  if (result.status < 200 || result.status >= 300) {
    return {
      ok: false,
      retry: false,
      reason: `the provider answered HTTP ${result.status}`,
    };
  }
  if (result.rawClipped) {
    return {
      ok: false,
      retry: false,
      reason: `the provider's answer is over ${result.rawChars} characters`,
    };
  }
  try {
    return {
      ok: true,
      status: result.status,
      response: JSON.parse(result.raw),
    };
  } catch {
    return {
      ok: false,
      retry: false,
      reason: "the provider's answer is not JSON",
    };
  }
}
