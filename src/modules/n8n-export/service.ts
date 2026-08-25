import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { buildToolWorkflow, CREDENTIALS_NOTE, type N8nWorkflow } from "./n8n";

// n8n export service. Reads are tenant-scoped (a tenant can only export its OWN ToolDefinition —
// no other tenant's data can enter the JSON). The pure builder + assertNoSecrets backstop guarantee
// no credential leaves the system.

export interface ToolWorkflowExport {
  workflow: N8nWorkflow;
  credentialsNote: string;
}

export async function exportToolWorkflow(
  ctx: TenantContext,
  toolId: bigint,
  base: PrismaClient = basePrisma,
): Promise<ToolWorkflowExport> {
  const tool = await runScopedOn(base, ctx, (db) =>
    db.toolDefinition.findUnique({
      where: { id: toolId },
      // Allowlist: ONLY these safe fields are read. credentialRef / headers (which carry the
      // vault placeholder) are deliberately not selected.
      select: { name: true, method: true, urlTemplate: true },
    }),
  );
  if (!tool) throw new NotFoundError("tool definition not found");
  const workflow = buildToolWorkflow({
    name: tool.name,
    method: tool.method,
    url: tool.urlTemplate,
  });
  return { workflow, credentialsNote: CREDENTIALS_NOTE };
}

// Convenience for callers that already resolved a tenantId (REST/MCP controllers).
export async function exportToolWorkflowForTenant(
  ctx: TenantContext,
  toolId: bigint,
  base: PrismaClient = basePrisma,
): Promise<ToolWorkflowExport> {
  return exportToolWorkflow(ctx, toolId, base);
}
