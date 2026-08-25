import { type StructuredToolInterface, tool } from "@langchain/core/tools";
import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import { clipText } from "@/lib/text";
import { xmlAttr, xmlEscape } from "@/lib/xml";
import { sysCtx } from "@/modules/rag/documents";
import { createSuggestion, searchKnowledge } from "@/modules/rag/service";

// RAG tools the agent can call mid-turn. search_knowledge retrieves from the tenant's knowledge
// bases (RLS-scoped); suggest_kb_entry proposes a new entry that a human must approve before it is
// ever used (nothing enters a KB autonomously). Fail-closed: exposed only when explicitly
// allowlisted on the agent.

export { RAG_TOOL_NAMES, type RagToolName } from "./catalog";

export interface RagToolCtx {
  tenantId: bigint;
  base: PrismaClient;
  // Scope of the search/suggestion; empty ⇒ all of the tenant's knowledge bases (RLS-scoped).
  knowledgeBaseIds: bigint[];
  // Name + description of the selected bases, listed in the search_knowledge tool description so the
  // agent can reason about what is searchable. By default one tool searches across ALL of them; the
  // id backs the optional knowledge_base narrowing parameter (name -> id, names are not unique).
  knowledgeBases?: { id: bigint; name: string; description: string | null }[];
  threadId: string;
  // Optional grounding threshold: drop hits whose cosine distance exceeds this (lower = stricter;
  // 0 = identical). Undefined ⇒ no distance filtering (recall preserved). Tune empirically per agent.
  maxDistance?: number;
}

// Returned (instead of passages) when nothing clears the grounding bar. The runtime grounding
// directive (see prompt.ts) instructs the model to NOT fabricate and to offer a human on this.
const NO_GROUNDED_INFO =
  "No relevant information was found in the knowledge base for this query. Do not invent an answer: tell the customer you don't have that information and, if appropriate, offer to connect them with a human agent.";

// search_knowledge description: a base instruction plus, when known, the selected bases (name —
// description) so the model can judge whether the question is answerable from them. Each entry is
// length-bounded and the whole list capped, so a verbose KB description never bloats the prompt.
const SEARCH_BASE_DESC =
  "Search the knowledge base for information to help answer the customer. Returns the most relevant passages.";
// NOTE: The contract, not just the mechanics. Approval copies `content` into the knowledge base
// verbatim, and a later answer is grounded ONLY on what search returns — so a hedge written into the
// content ("solicita-se validação") is embedded and comes back as a hedge in every answer on that
// subject, forever (issue #81). Told only "propose an entry for human review", a model reasonably
// writes a message TO the reviewer, and hedging is the polite register for that. Naming the reader
// (the future retrieval, not the reviewer) and pointing doubt at `rationale` is the fix at the
// source, the same way grounding is a runtime invariant instead of a habit each tenant rediscovers.
const SUGGEST_BASE_DESC =
  "Propose a new knowledge-base entry for human review. It is queued for approval and is NOT used until a human approves it. On approval the `content` becomes the entry EXACTLY as you wrote it, and later answers are grounded on that text alone — so write it as a standalone statement that reads correctly with no conversation around it. Conditions, limits and exceptions that are PART OF THE FACT belong in the content and must be kept there ('free shipping above R$200', 'only for contracts signed after March'): dropping them would store a rule that is wrong outside its conditions. What does not belong is doubt ABOUT the fact — 'please confirm', 'subject to validation' — or any commentary about the suggestion itself, because approval turns that text into the answer the agent gives from then on. Uncertainty and provenance go in `rationale`, which the reviewer reads and which never enters the knowledge base.";

// Compact, length-bounded XML of the selected bases, shared by the search and suggest tool
// descriptions and appended at the END. The `name` attribute is the valid value for the
// `knowledge_base` arg; each description is the (clipped) element text. A total budget caps the block
// so a verbose KB never bloats the prompt (overflow noted as <more count="N"/>), and entries are
// dropped whole so the markup never gets cut mid-tag.
function knowledgeBasesXml(
  kbs: { name: string; description: string | null }[],
): string {
  const BUDGET = 1000;
  const els: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const k of kbs) {
    const d = k.description?.trim();
    const el = d
      ? `  <knowledge_base${xmlAttr("name", k.name)}>${xmlEscape(clipText(d, 140))}</knowledge_base>`
      : `  <knowledge_base${xmlAttr("name", k.name)}/>`;
    if (used + el.length > BUDGET && els.length > 0) {
      dropped++;
      continue;
    }
    els.push(el);
    used += el.length;
  }
  if (dropped > 0) els.push(`  <more count="${dropped}"/>`);
  return `<knowledge_bases>\n${els.join("\n")}\n</knowledge_bases>`;
}

// When offerScope is true (>= 2 bases), the tool exposes an optional knowledge_base narrowing
// parameter. The directive deliberately biases the model toward the default (search everything):
// a wrong single-base pick silently misses the answer in the others, so narrowing must be the rare,
// high-confidence exception, not the habit.
function searchDescription(
  kbs: { name: string; description: string | null }[] | undefined,
  offerScope: boolean,
): string {
  if (!kbs || kbs.length === 0) return SEARCH_BASE_DESC;
  const base = offerScope
    ? `${SEARCH_BASE_DESC} The available knowledge bases are listed in \`<knowledge_bases>\` below. Leave knowledge_base unset to search across all of them: this is the default and almost always the right choice. Only set knowledge_base to one of the listed names when you are highly confident the answer lives exclusively in that base; picking the wrong one will miss relevant information in the others.`
    : `${SEARCH_BASE_DESC} The available knowledge bases are listed in \`<knowledge_bases>\` below.`;
  return `${base}\n\n${knowledgeBasesXml(kbs)}`;
}

// suggest_kb_entry description: the base instruction plus, when bases are known, where the entry
// lands. With >= 2 bases the model MUST pick a target (knowledge_base required); with a single base
// it is filed there automatically (no choice to make).
function suggestDescription(
  kbs: { name: string; description: string | null }[] | undefined,
  requireBase: boolean,
): string {
  if (!kbs || kbs.length === 0) return SUGGEST_BASE_DESC;
  const base = requireBase
    ? `${SUGGEST_BASE_DESC} Set knowledge_base to the base this entry belongs in — one of those listed in \`<knowledge_bases>\` below.`
    : `${SUGGEST_BASE_DESC} It will be filed under the base listed in \`<knowledge_bases>\` below.`;
  return `${base}\n\n${knowledgeBasesXml(kbs)}`;
}

// Pull a stable, customer-safe source descriptor from the chunk metadata for the playground source list.
function chunkSource(meta: unknown): { title?: string; url?: string } {
  if (!meta || typeof meta !== "object") return {};
  const m = meta as Record<string, unknown>;
  const title = typeof m.title === "string" ? m.title : undefined;
  const url =
    typeof m.sourceUrl === "string"
      ? m.sourceUrl
      : typeof m.url === "string"
        ? m.url
        : undefined;
  return { ...(title ? { title } : {}), ...(url ? { url } : {}) };
}

// Resolve which base ids a search call targets. A valid knowledge_base pick scopes to EVERY base
// with that name (KnowledgeBase.name is not unique per tenant, so nothing is silently excluded);
// an unknown/unset pick falls back to all selected bases (empty ⇒ undefined ⇒ all of the tenant's
// bases, RLS-scoped).
export function resolveSearchScope(
  pick: string | undefined,
  named: { id: bigint; name: string }[],
  fallback: bigint[],
): bigint[] | undefined {
  if (pick) {
    const ids = named.filter((k) => k.name === pick).map((k) => k.id);
    if (ids.length) return ids;
  }
  return fallback.length ? fallback : undefined;
}

// Resolve the SINGLE base a suggestion targets (a suggestion lands in exactly one base). A valid pick
// wins — the first base with that name, since names are not unique; with no pick (single-base case)
// we default to the only / first selected base. null ⇒ no base is configured, so the tool reports it
// and does nothing.
export function resolveSuggestTarget(
  pick: string | undefined,
  named: { id: bigint; name: string }[],
  fallback: bigint[],
): bigint | null {
  if (pick) {
    const match = named.find((k) => k.name === pick);
    if (match) return match.id;
  }
  return named[0]?.id ?? fallback[0] ?? null;
}

function searchTool(ctx: RagToolCtx) {
  const named = (ctx.knowledgeBases ?? []).filter((k) => k.name.trim());
  const distinctNames = [...new Set(named.map((k) => k.name))];
  // Only expose the narrowing parameter when there are >= 2 bases to choose between; with one (or
  // none named) the choice is meaningless and the default already searches it.
  const offerScope = distinctNames.length >= 2;
  const schema = offerScope
    ? z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(10).optional(),
        knowledge_base: z
          .enum(distinctNames as [string, ...string[]])
          .optional(),
      })
    : z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(10).optional(),
      });

  // responseFormat "content_and_artifact": the model sees the passage string (`content`), while the
  // ToolMessage also carries a structured `{ sources }` artifact for INTERNAL traceability (the
  // playground trace / observability) — never surfaced to the customer.
  return tool(
    async ({
      query,
      limit,
      knowledge_base,
    }: {
      query: string;
      limit?: number;
      knowledge_base?: string;
    }) => {
      const hits = await searchKnowledge({
        ctx: sysCtx(ctx.tenantId),
        query,
        knowledgeBaseIds: resolveSearchScope(
          knowledge_base,
          named,
          ctx.knowledgeBaseIds,
        ),
        limit: limit ?? 5,
        base: ctx.base,
      });
      const grounded =
        ctx.maxDistance != null
          ? hits.filter((h) => h.distance <= (ctx.maxDistance as number))
          : hits;
      if (grounded.length === 0) {
        return [NO_GROUNDED_INFO, { sources: [] }] as const;
      }
      // Structured sources for the playground's Sources panel (INTERNAL traceability only) so the
      // operator can see which passages grounded the answer. `marker` is a 1-based display index for
      // that list — never echoed to the customer (the content below carries no bracket marker).
      const sources = grounded.map((h, i) => ({
        marker: `[${i + 1}]`,
        chunkId: String(h.id),
        knowledgeBaseId: String(h.knowledgeBaseId),
        kb: h.knowledgeBaseName,
        documentId: String(h.documentId),
        documentTitle: h.documentTitle,
        ...chunkSource(h.metadata),
      }));
      // Attribute each passage with its source KB (so the model can ground its answer naturally), but
      // WITHOUT a bracket marker: the model never sees a [n] to copy, so none can leak into the reply.
      const content = grounded
        .map((h) => `(source: ${h.knowledgeBaseName}) ${h.content}`)
        .join("\n\n");
      return [content, { sources }] as const;
    },
    {
      name: "search_knowledge",
      description: searchDescription(ctx.knowledgeBases, offerScope),
      schema,
      responseFormat: "content_and_artifact",
    },
  );
}

function suggestTool(ctx: RagToolCtx) {
  const named = (ctx.knowledgeBases ?? []).filter((k) => k.name.trim());
  const distinctNames = [...new Set(named.map((k) => k.name))];
  // With >= 2 bases to choose between, the target base is REQUIRED: the model must say where the
  // entry belongs (otherwise it silently lands in the first base, and the reviewer can't tell intent
  // from accident). With one base (or none named) there is no choice, so the parameter is omitted.
  const requireBase = distinctNames.length >= 2;
  const content = z
    .string()
    .min(1)
    .describe(
      "The entry itself, stored verbatim on approval. A standalone statement that stands on its own with no conversation around it. Keep the conditions and exceptions that make it true; leave out doubt about whether it is true, requests to validate it, and notes to the reviewer.",
    );
  const title = z
    .string()
    .optional()
    .describe("Short label for the entry, for the reviewer and the listing.");
  const rationale = z
    .string()
    .optional()
    .describe(
      "For the reviewer only, never stored in the knowledge base: where this came from and anything you could not confirm.",
    );
  const schema = requireBase
    ? z.object({
        content,
        knowledge_base: z.enum(distinctNames as [string, ...string[]]),
        title,
        rationale,
      })
    : z.object({ content, title, rationale });

  return tool(
    async (args: {
      content: string;
      title?: string;
      rationale?: string;
      knowledge_base?: string;
    }) => {
      const targetId = resolveSuggestTarget(
        args.knowledge_base,
        named,
        ctx.knowledgeBaseIds,
      );
      if (targetId == null) {
        return "No knowledge base is configured for suggestions.";
      }
      await createSuggestion({
        ctx: sysCtx(ctx.tenantId),
        knowledgeBaseId: targetId,
        proposedContent: args.content,
        proposedTitle: args.title,
        rationale: args.rationale,
        threadId: ctx.threadId,
        base: ctx.base,
      });
      return "Suggestion queued for human review. It will NOT be used until a human approves it.";
    },
    {
      name: "suggest_kb_entry",
      description: suggestDescription(ctx.knowledgeBases, requireBase),
      schema,
    },
  );
}

// allowed undefined/empty ⇒ no RAG tools (fail-closed); otherwise only the named subset.
export function buildRagTools(
  ctx: RagToolCtx,
  allowed?: Iterable<string>,
): StructuredToolInterface[] {
  if (!allowed) return [];
  const set = new Set(allowed);
  const all = [searchTool(ctx), suggestTool(ctx)];
  return all.filter((t) => set.has(t.name));
}
