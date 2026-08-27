import basePrisma from "@/api/lib/prisma";
import { AppError } from "@/lib/errors";
import { truncForAudit } from "@/modules/audit/projection";
import { parseDocumentStyle } from "@/modules/documents/blocks";
import { documentStarter } from "@/modules/documents/starters";
import {
  createDocumentTemplate,
  deleteDocumentTemplate,
  documentTemplateWriteProblem,
  getDocumentTemplate,
  normalizeTemplateName,
  previewDocumentTemplate,
  updateDocumentTemplate,
} from "@/modules/documents/templates";
import type { VerifiedToken } from "./oauth/tokens";
import {
  ctxOf,
  diffFields,
  err,
  gate,
  ok,
  parseMcpId,
  recordMcpAudit,
  type WriteDeps,
  type WriteResult,
} from "./write";

// MCP document-template write tools. Spine: gate (mcp:write + tenant) → dry-run preview by default →
// apply + audit. No secrets, so no credential resolution.
//
// Authoring a rich document over MCP is the point of this surface, and the shape it accepts is
// deliberately NOT published as a discriminated union in the tool schema — see the note on the
// registrations in server.ts. The contract lives in the tool description, the enforcement lives in
// modules/documents/validate, and the refusal it returns is written for whoever is authoring.

function failOf(e: unknown): WriteResult {
  if (e instanceof AppError) return err(e.message);
  throw e;
}

// A projection small enough to read in a terminal: the blocks themselves are the bulk of a template
// and diffing them field by field would print the whole document twice. What a caller needs to see
// before applying is WHICH parts moved and by how much.
function projection(t: {
  name: string;
  slug: string;
  description: string | null;
  blocks: unknown[];
  fields: { name: string; type: string; required?: boolean }[];
  style: Record<string, unknown>;
  numberPrefix: string | null;
  enabled: boolean;
}) {
  return {
    name: t.name,
    slug: t.slug,
    description: t.description,
    blocks: t.blocks.length,
    fields: t.fields.map((f) => `${f.name}:${f.type}${f.required ? "*" : ""}`),
    style: t.style,
    numberPrefix: t.numberPrefix,
    enabled: t.enabled,
  };
}

export interface DocumentTemplateWriteArgs {
  name?: string;
  slug?: string;
  description?: string | null;
  blocks?: unknown;
  fields?: unknown;
  style?: unknown;
  number_prefix?: string | null;
  enabled?: boolean;
  starter?: string;
  locale?: string;
  dry_run?: boolean;
}

export async function documentTemplateCreate(
  principal: VerifiedToken,
  args: DocumentTemplateWriteArgs,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const gated = gate(principal);
  if ("ok" in gated) return gated;
  const ctx = ctxOf(principal);
  // A starter supplies whatever the call left out, so "give me a quote template I can edit" is one
  // round trip instead of authoring six blocks blind.
  const starter = args.starter
    ? documentStarter(args.starter, args.locale === "en-US" ? "en-US" : "pt-BR")
    : null;
  if (args.starter && !starter) {
    return err(
      `unknown starter "${args.starter}" — use document_starters_list to see the available ones`,
    );
  }
  // `!== undefined` rather than `??` on the two NULLABLE overrides: both are advertised as accepting
  // null, and `??` reads an explicit null as "not supplied" and puts the starter's value back — so a
  // caller asking for a template with no description or no number prefix would get the starter's,
  // with nothing saying their argument was ignored.
  const input = {
    // Normalized HERE, once, because every use below is downstream of it: the gate, the rendered
    // preview's title and the reported name. The apply trims, so anything shown untrimmed is a
    // value the write does not keep.
    name: normalizeTemplateName(args.name ?? starter?.name ?? ""),
    slug: args.slug,
    description:
      args.description !== undefined
        ? args.description
        : (starter?.description ?? null),
    blocks: args.blocks ?? starter?.blocks ?? [],
    fields: args.fields ?? starter?.fields ?? [],
    style: args.style ?? starter?.style,
    numberPrefix:
      args.number_prefix !== undefined
        ? args.number_prefix
        : (starter?.numberPrefix ?? null),
    enabled: args.enabled,
  };
  if (!input.name) return err("name is required");
  try {
    if (args.dry_run !== false) {
      // Asked BEFORE the render, and asked at all because a dry run that renders a beautiful
      // document and then reports "valid" for a name or slug the apply will refuse is worse than no
      // dry run: the caller acts on it.
      const problem = await documentTemplateWriteProblem(
        ctx,
        {
          name: input.name,
          slug: input.slug,
          description: input.description,
          numberPrefix: input.numberPrefix,
        },
        base,
      );
      if (problem) return err(problem);
      // The dry run RENDERS, so the preview is the document rather than a description of it. That is
      // the whole reason this surface is usable without a visual editor.
      const pdf = await previewDocumentTemplate(
        ctx,
        {
          name: input.name,
          blocks: input.blocks,
          fields: input.fields,
          style: input.style,
          numberPrefix: input.numberPrefix,
        },
        base,
      );
      return ok({
        dryRun: true,
        action: "create",
        resource: "document_template",
        preview: {
          name: input.name,
          blocks: Array.isArray(input.blocks) ? input.blocks.length : 0,
          fields: Array.isArray(input.fields) ? input.fields.length : 0,
          renderedBytes: pdf.byteLength,
          note: "Valid: the template rendered to a PDF of this size. Re-run with dry_run:false to save it, then preview it in the console.",
        },
      });
    }
    const created = await createDocumentTemplate(ctx, input, base);
    const target = `document_template:${created.id}`;
    await recordMcpAudit(gated, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "document_template.create",
      target,
      before: null,
      after: truncForAudit(projection(created)),
    });
    return ok({
      dryRun: false,
      applied: true,
      id: created.id,
      toolName: created.toolName,
      target,
    });
  } catch (e) {
    return failOf(e);
  }
}

export async function documentTemplateUpdate(
  principal: VerifiedToken,
  args: DocumentTemplateWriteArgs & { document_template_id: string },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const gated = gate(principal);
  if ("ok" in gated) return gated;
  const ctx = ctxOf(principal);
  const id = parseMcpId(args.document_template_id, "document_template_id");
  if (typeof id !== "bigint") return id;
  const patch: Parameters<typeof updateDocumentTemplate>[2] = {};
  if (args.name !== undefined) patch.name = normalizeTemplateName(args.name);
  if (args.slug !== undefined) patch.slug = args.slug;
  if (args.description !== undefined) patch.description = args.description;
  if (args.blocks !== undefined) patch.blocks = args.blocks;
  if (args.fields !== undefined) patch.fields = args.fields;
  if (args.style !== undefined) patch.style = args.style;
  if (args.number_prefix !== undefined) patch.numberPrefix = args.number_prefix;
  if (args.enabled !== undefined) patch.enabled = args.enabled;
  if (Object.keys(patch).length === 0) {
    return err(
      "no updatable fields provided (name, slug, description, blocks, fields, style, number_prefix, enabled)",
    );
  }
  try {
    const current = await getDocumentTemplate(ctx, id, base);
    const target = `document_template:${id}`;
    const before = projection(current);
    if (args.dry_run !== false) {
      // Same question as on create, with this template excluded from the uniqueness check: renaming
      // a slug to the one it already has is not a collision.
      const problem = await documentTemplateWriteProblem(ctx, patch, base, {
        deriveSlugFromName: false,
        excludeId: id,
      });
      if (problem) return err(problem);
      // Rendered, not just diffed: a block change that diffs as "blocks: 6 → 7" says nothing about
      // whether the seventh renders. Failing here is the point — the error names the block.
      const pdf = await previewDocumentTemplate(
        ctx,
        {
          id,
          name: patch.name,
          blocks: patch.blocks,
          fields: patch.fields,
          style: patch.style,
          numberPrefix: patch.numberPrefix,
        },
        base,
      );
      const previewAfter = projection({
        ...current,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
        ...(patch.description !== undefined
          ? { description: patch.description }
          : {}),
        ...(patch.numberPrefix !== undefined
          ? { numberPrefix: patch.numberPrefix }
          : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        // Every property the patch can carry, and for the same reason each one is here: the diff is
        // the client's only picture of what applying would do. A projection that takes the patch for
        // some properties and the stored value for others answers "nothing changes" to a write that
        // changes the agent's own argument list — confidently, which is the worst way to be wrong.
        // Shapes are re-read from the projection's own types, so a fields patch of another shape
        // shows up as a diff rather than a crash.
        ...(Array.isArray(patch.blocks) ? { blocks: patch.blocks } : {}),
        ...(Array.isArray(patch.fields)
          ? { fields: patch.fields as { name: string; type: string }[] }
          : {}),
        ...(patch.style !== undefined
          ? {
              // Merged over the SAVED style, the way the write merges it. From the patch alone, an
              // omitted optional (footerText) diffs as removed while the apply keeps it — the diff
              // describing a change the write will not make.
              style: parseDocumentStyle({
                ...current.style,
                ...(patch.style as Record<string, unknown>),
              }) as Record<string, unknown>,
            }
          : {}),
      });
      return ok({
        dryRun: true,
        target,
        diff: diffFields(before, previewAfter),
        renderedBytes: pdf.byteLength,
      });
    }
    const updated = await updateDocumentTemplate(ctx, id, patch, base);
    await recordMcpAudit(gated, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "document_template.update",
      target,
      before: truncForAudit(before),
      after: truncForAudit(projection(updated)),
    });
    return ok({ dryRun: false, applied: true, target });
  } catch (e) {
    return failOf(e);
  }
}

export async function documentTemplateDelete(
  principal: VerifiedToken,
  args: { document_template_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const gated = gate(principal);
  if ("ok" in gated) return gated;
  const ctx = ctxOf(principal);
  const id = parseMcpId(args.document_template_id, "document_template_id");
  if (typeof id !== "bigint") return id;
  try {
    const current = await getDocumentTemplate(ctx, id, base);
    const target = `document_template:${id}`;
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "delete",
        target,
        preview: {
          ...projection(current),
          note: "Documents already issued from this template keep their own frozen copy and stay readable.",
        },
      });
    }
    await deleteDocumentTemplate(ctx, id, base);
    await recordMcpAudit(gated, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "document_template.delete",
      target,
      before: truncForAudit(projection(current)),
      after: null,
    });
    return ok({ dryRun: false, applied: true, target });
  } catch (e) {
    return failOf(e);
  }
}
