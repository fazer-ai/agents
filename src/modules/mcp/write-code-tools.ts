import basePrisma from "@/api/lib/prisma";
import { checkCodeToolSyntax } from "@/lib/code-tool-syntax";
import { AppError } from "@/lib/errors";
import {
  assertCodeToolCreatable,
  assertCodeToolNameAvailable,
  assertCodeToolPatchValid,
  type CodeToolCreate,
  type CodeToolUpdate,
  createCodeTool,
  deleteCodeTool,
  getCodeTool,
  updateCodeTool,
} from "@/modules/code-tools/service";
import { normalizeToolShapes } from "@/modules/tool-definitions/normalize";
import type { VerifiedToken } from "./oauth/tokens";
import {
  diffFields,
  err,
  gate,
  ok,
  parseMcpId,
  type WriteDeps,
  type WriteResult,
} from "./write";

// MCP code-tool write tools (issue #363), the twin of the HTTP tool_* trio in write-agents.ts.
// Spine: gate (mcp:write + tenant target) → dry-run preview by default → apply + audit (the row is
// the service's, code-tools/service.ts). No secrets, so no credential resolution.
//
// Two things ride on every answer that an HTTP tool's does not. `warnings` is the body's static
// check (a syntax error with its line and column, or a body with no `return`): the service saves an
// invalid body and answers with the warning rather than refusing, so the preview runs the same
// check on the same body, and a caller can approve a dry run knowing what the apply will report.
// And `input_schema` is canonicalized HERE and not only in the service, for the reason
// buildToolPatch gives: the patch is also what the dry run shows, and a preview echoing a
// JSON-Schema-shaped argument would promise a shape the row never holds.

function failOf(e: unknown): WriteResult {
  if (e instanceof AppError) return err(e.message);
  throw e;
}

export interface CodeToolWriteArgs {
  name?: string;
  label?: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  code?: string;
  enabled?: boolean;
}

// Map snake_case tool args → the service's camelCase shape, with input_schema in the form the
// service stores (the compact field map; a JSON-Schema-shaped value converts, and the conversion
// notes come back as `warnings`, strings, the same vocabulary tool_create reports them in).
//
// EXPORTED for the dry-run tests. What the preview shows has to be what the apply stores, and the
// only way to say that as a test is to ask this function what it built.
export function buildCodeToolPatch(args: CodeToolWriteArgs): {
  patch: CodeToolUpdate;
  warnings: string[];
} {
  const patch: CodeToolUpdate = {};
  const warnings: string[] = [];
  if (args.name !== undefined) patch.name = args.name;
  if (args.label !== undefined) patch.label = args.label;
  if (args.description !== undefined) patch.description = args.description;
  if (args.input_schema !== undefined) {
    const norm = normalizeToolShapes({ inputSchema: args.input_schema });
    patch.inputSchema = (norm.shapes.inputSchema ?? {}) as Record<
      string,
      unknown
    >;
    warnings.push(...norm.warnings);
  }
  if (args.code !== undefined) patch.code = args.code;
  if (args.enabled !== undefined) patch.enabled = args.enabled;
  return { patch, warnings };
}

export async function codeToolCreate(
  principal: VerifiedToken,
  args: CodeToolWriteArgs & { dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  if (!args.name) return err("name is required");
  if (!args.description) return err("description is required");
  if (!args.code) return err("code is required");
  const built = buildCodeToolPatch(args);
  // NOTE: the defaults the service would fill (label from the identifier, an empty schema, enabled)
  // are filled here instead, so the preview carries every column the row will, not only the ones
  // the caller named.
  const input: CodeToolCreate = {
    ...built.patch,
    name: args.name,
    label: args.label ?? args.name,
    description: args.description,
    inputSchema: built.patch.inputSchema ?? {},
    code: args.code,
    enabled: args.enabled ?? true,
  };
  const schemaWarnings =
    built.warnings.length > 0 ? { schemaWarnings: built.warnings } : {};
  try {
    if (args.dry_run !== false) {
      // NOTE: the core's own questions, asked before the preview answers them. They sit INSIDE the
      // branch because the apply reaches the core, which asks them again (#490).
      // PARSED, and the preview shows what it returned: the parser trims the label and the
      // description, so echoing the raw input would promise the caller a row the apply then stores
      // with different values (#490 is about exactly that gap).
      const parsed = assertCodeToolCreatable(input);
      // ADVISORY, unlike the line above it: this one READS, outside the transaction the apply will
      // write in, so a free name here can be taken before the apply arrives. The unique index
      // inside the write remains what guarantees one name to one row (#490).
      await assertCodeToolNameAvailable(ctx, parsed.name, base);
      return ok({
        dryRun: true,
        action: "create",
        resource: "code_tool",
        preview: parsed,
        warnings: await checkCodeToolSyntax(input.code),
        ...schemaWarnings,
      });
    }
    const { tool, warnings } = await createCodeTool(ctx, input, base);
    return ok({
      dryRun: false,
      applied: true,
      target: `code_tool:${tool.id}`,
      tool,
      warnings,
      ...schemaWarnings,
    });
  } catch (e) {
    return failOf(e);
  }
}

export async function codeToolUpdate(
  principal: VerifiedToken,
  args: CodeToolWriteArgs & { code_tool_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.code_tool_id, "code_tool_id");
  if (typeof id !== "bigint") return id;
  const built = buildCodeToolPatch(args);
  if (Object.keys(built.patch).length === 0) {
    return err("no updatable fields provided");
  }
  const schemaWarnings =
    built.warnings.length > 0 ? { schemaWarnings: built.warnings } : {};
  try {
    const current = await getCodeTool(ctx, id, base);
    const keys = Object.keys(built.patch) as (keyof CodeToolUpdate)[];
    const beforeProj: Record<string, unknown> = {};
    const afterProj: Record<string, unknown> = {};
    for (const k of keys) {
      beforeProj[k] = (current as unknown as Record<string, unknown>)[k];
      afterProj[k] = built.patch[k];
    }
    const target = `code_tool:${id}`;
    if (args.dry_run !== false) {
      // The patch the apply would parse, parsed here: a rename the pattern refuses stops reading as
      // a diff the apply would take (#490). It judges the INPUT, so its verdict cannot change in
      // the gap; the name's availability is asked by the apply, inside its transaction.
      const parsed = assertCodeToolPatchValid(built.patch);
      // A rename is the one field of a patch whose verdict is not in the payload: `updateCodeTool`
      // asks whether the name is free, and a preview that skipped the question answered a confident
      // diff for a write that always fails. ADVISORY, like the create's, and excluding this row so
      // a tool keeping its own name is not refused for colliding with itself (#490).
      if (built.patch.name !== undefined) {
        await assertCodeToolNameAvailable(ctx, built.patch.name, base, id);
      }
      // NOTE: checked only when the patch carries a body, which is when the apply checks it: a patch
      // that leaves the body alone reports `[]` from both, and the stored body's own warnings are
      // code_tool_get's to show.
      const warnings =
        built.patch.code !== undefined
          ? await checkCodeToolSyntax(built.patch.code)
          : [];
      // The diff carries what the apply would STORE, which is the parser's output: the same reason
      // the create's preview echoes `parsed` above.
      const parsedProj: Record<string, unknown> = {};
      for (const k of keys) parsedProj[k] = parsed[k];
      return ok({
        dryRun: true,
        target,
        diff: diffFields(beforeProj, parsedProj),
        warnings,
        ...schemaWarnings,
      });
    }
    const { tool, warnings } = await updateCodeTool(ctx, id, built.patch, base);
    const appliedProj: Record<string, unknown> = {};
    for (const k of keys)
      appliedProj[k] = (tool as unknown as Record<string, unknown>)[k];
    return ok({
      dryRun: false,
      applied: true,
      target,
      diff: diffFields(beforeProj, appliedProj),
      warnings,
      ...schemaWarnings,
    });
  } catch (e) {
    return failOf(e);
  }
}

export async function codeToolDelete(
  principal: VerifiedToken,
  args: { code_tool_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.code_tool_id, "code_tool_id");
  if (typeof id !== "bigint") return id;
  try {
    const current = await getCodeTool(ctx, id, base);
    const target = `code_tool:${id}`;
    const beforeProj = { id: current.id, name: current.name };
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "delete",
        target,
        current: beforeProj,
      });
    }
    await deleteCodeTool(ctx, id, base);
    return ok({ dryRun: false, applied: true, target });
  } catch (e) {
    return failOf(e);
  }
}
