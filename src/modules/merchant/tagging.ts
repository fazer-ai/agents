import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { NotFoundError } from "@/lib/errors";
import { fetchBounded } from "@/lib/outbound";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { auditMutation } from "@/modules/audit/service";
import {
  getMerchantProduct,
  type MerchantProductDto,
  type ProductAttributes,
} from "./products";
import { normalizeVi } from "./scorer";

// PIM-lite auto-tagger: one product at a time is sent to the LOCAL OpenAI-shaped gateway,
// which classifies it into the shop taxonomy below and extracts the facets
// (size/color/material/price segment) a customer would filter on. The write happens ONLY on
// a verified-JSON success: a refusal, a network failure or an answer that is not the
// declared shape leaves the row untouched, so tagSource="llm" is never stamped on a guess.
// The gateway call sits OUTSIDE any runScoped transaction: a scoped tx pins a pooled
// connection and a 15-40s LLM round-trip inside one would drain the pool - the flow is
// read (scoped) -> fetch (no tx) -> write (scoped).

// The shop taxonomy the model must pick from. Vietnamese display labels, one
// node per category; "khác" is the honest fallback the prompt instructs.
export const MERCHANT_CATEGORIES = [
  "thời trang nữ",
  "thời trang nam",
  "mỹ phẩm/skincare",
  "thực phẩm/snack",
  "phụ kiện",
  "khác",
] as const;
export type MerchantCategory = (typeof MERCHANT_CATEGORIES)[number];

// Loopback gateway, no auth header (docs/task: the local swe-2 endpoint). A
// constant rather than config because nothing else may be reached: widening
// this to operator input would need the SSRF guard's vocabulary.
export const TAGGING_GATEWAY_URL = "http://127.0.0.1:8399/v1/chat/completions";
export const TAGGING_MODEL = "swe-2-medium";
// The gateway answers in ~15-40s; 90s is headroom past the worst observed latency,
// not a guess at the mean. fetchBounded bounds headers AND body under one timer.
export const TAGGING_TIMEOUT_MS = 90_000;
// A tagging answer is a small JSON object; a megabyte of it is an error, not a reply.
const TAGGING_BODY_CAP = 256_000;

const attributeValueSchema = z.union([
  z.string().max(300),
  z.number(),
  z.boolean(),
]);
// `attributes` stays `z.unknown()`: a constrained record would let a
// model-chosen key reach a refusal path. Each VALUE is checked in
// parseTaggingResponse, where a bad one fails the answer like a schema miss.
const taggingResultSchema = z.object({
  category: z.string().min(1).max(200),
  tags: z.array(z.string().min(1).max(100)).max(50).default([]),
  attributes: z.record(z.string(), z.unknown()).default({}),
});
export interface TaggingResult {
  category: string;
  tags: string[];
  attributes: ProductAttributes;
}

// Category names the model returns get normalized the way the scorer normalizes
// post text (diacritics stripped, lowercased) so "Thời trang nữ" and "thoi trang
// nu" land on the same node. An off-taxonomy name maps to "khác" rather than
// inventing a seventh bucket nobody else can filter on.
const CATEGORY_BY_NORMALIZED: Record<string, MerchantCategory> =
  Object.fromEntries(
    MERCHANT_CATEGORIES.map((c) => [normalizeVi(c), c]),
  ) as Record<string, MerchantCategory>;

export function normalizeCategory(raw: string): MerchantCategory {
  const key = normalizeVi(raw).trim();
  return CATEGORY_BY_NORMALIZED[key] ?? "khác";
}

// Extracts the strict JSON object out of a chat-completion CONTENT string.
// Accepts a bare object or one wrapped in a markdown fence; refuses (null) on
// prose-only answers, truncated JSON, or a payload outside the declared shape —
// each reads the same to the caller: the model did not answer usefully.
export function parseTaggingResponse(content: string): TaggingResult | null {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? content).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
  const result = taggingResultSchema.safeParse(parsed);
  if (!result.success) return null;
  const attributes: ProductAttributes = {};
  for (const [key, value] of Object.entries(result.data.attributes)) {
    const parsedValue = attributeValueSchema.safeParse(value);
    if (!parsedValue.success) return null;
    attributes[key] = parsedValue.data;
  }
  return { ...result.data, attributes };
}

// Manual tags are never silently overwritten: the LLM's list is UNIONED onto
// the existing one, existing entries keep their original casing and position.
// Dedupe key: diacritics stripped, edges trimmed, inner whitespace collapsed —
// "Trị mụn" and "TRỊ  MỤN" are the same tag to a shopper.
function tagKey(tag: string): string {
  return normalizeVi(tag).trim().replace(/\s+/g, " ");
}

export function mergeTags(existing: string[], llmTags: string[]): string[] {
  const seen = new Set(existing.map(tagKey));
  const out = [...existing];
  for (const tag of llmTags) {
    const key = tagKey(tag);
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(tag.trim());
    }
  }
  return out;
}

// The prompt is Vietnamese end-to-end: the catalog language, the taxonomy and
// the example values are all in the words a VN shopkeeper writes.
function buildTaggingMessages(product: {
  name: string;
  description: string | null;
  price: number;
  tags: string[];
}): { role: "system" | "user"; content: string }[] {
  const system = [
    "Bạn là trợ lý phân loại sản phẩm cho một shop bán hàng online ở Việt Nam.",
    "Nhiệm vụ: đọc tên và mô tả sản phẩm, chọn MỘT category trong taxonomy cố định,",
    "gợi ý tags tìm kiếm (từ khóa khách hay gõ, có thể không dấu) và trích các thuộc tính.",
    `Taxonomy category (chọn đúng một): ${MERCHANT_CATEGORIES.join(", ")}.`,
    "Trả lời DUY NHẤT một object JSON hợp lệ, không markdown, không giải thích:",
    '{"category": "...", "tags": ["..."], "attributes": {"size": "...", "color": "...", "material": "...", "priceSegment": "rẻ|trung bình|cao cấp"}}',
    'Quy tắc: category phải là một trong taxonomy, không chắc thì chọn "khác";',
    "tags tối đa 8, viết thường, từ ngắn gọn; attributes chỉ ghi khi suy ra được từ mô tả, không bịa;",
    'priceSegment: "rẻ" dưới 100k, "trung bình" 100k-500k, "cao cấp" trên 500k.',
  ].join("\n");
  const user = [
    `Tên sản phẩm: ${product.name}`,
    product.description ? `Mô tả: ${product.description}` : null,
    `Giá: ${product.price} VND`,
    product.tags.length > 0
      ? `Tags hiện có (do shop tự gán): ${product.tags.join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export interface TaggingDeps {
  base?: PrismaClient;
  fetchImpl?: typeof fetch;
  gatewayUrl?: string;
  timeoutMs?: number;
}

export type TaggingOutcome =
  | { ok: true; product: MerchantProductDto }
  | { ok: false; reason: "gateway" | "unparseable"; detail?: string };

const PRODUCT_TAG_SELECT = {
  id: true,
  name: true,
  description: true,
  price: true,
  tags: true,
  category: true,
  attributes: true,
  tagSource: true,
} as const;

// Re-runs the tagger on one product. Exported for POST /products/:id/retag and
// for the import flow's fire-and-forget kick-off — both want "tag this row".
export async function tagMerchantProductWithLlm(
  ctx: TenantContext,
  id: bigint,
  deps: TaggingDeps = {},
): Promise<TaggingOutcome> {
  const base = deps.base ?? basePrisma;
  const row = await runScopedOn(base, ctx, (db) =>
    db.merchantProduct.findUnique({
      where: { id },
      select: PRODUCT_TAG_SELECT,
    }),
  );
  if (!row) {
    throw new NotFoundError(
      "product not found",
      "errors.merchantProductNotFound",
    );
  }

  const { res, body } = await fetchBounded(
    deps.gatewayUrl ?? TAGGING_GATEWAY_URL,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: TAGGING_MODEL,
        messages: buildTaggingMessages({
          name: row.name,
          description: row.description,
          price: Number(row.price),
          tags: row.tags,
        }),
        temperature: 0,
        stream: false,
      }),
    },
    {
      timeoutMs: deps.timeoutMs ?? TAGGING_TIMEOUT_MS,
      cap: TAGGING_BODY_CAP,
      fetchImpl: deps.fetchImpl,
    },
  );
  if (!res.ok) {
    return { ok: false, reason: "gateway", detail: `HTTP ${res.status}` };
  }

  let completion: unknown;
  try {
    completion = JSON.parse(body.text);
  } catch {
    return { ok: false, reason: "gateway", detail: "non-JSON gateway reply" };
  }
  const content = (
    completion as {
      choices?: { message?: { content?: unknown } }[];
    }
  ).choices?.[0]?.message?.content;
  const parsed =
    typeof content === "string" ? parseTaggingResponse(content) : null;
  if (!parsed) {
    return { ok: false, reason: "unparseable" };
  }

  await runScopedOn(base, ctx, async (db) => {
    // Re-read inside the write tx: the tags the merge must preserve are the ones
    // stored NOW, not the ones the first read saw (a manual edit can land while
    // the gateway thinks).
    const current = await db.merchantProduct.findUnique({
      where: { id },
      select: PRODUCT_TAG_SELECT,
    });
    if (!current) {
      throw new NotFoundError(
        "product not found",
        "errors.merchantProductNotFound",
      );
    }
    const merged = mergeTags(current.tags, parsed.tags);
    const updated = await db.merchantProduct.update({
      where: { id },
      data: {
        category: normalizeCategory(parsed.category),
        attributes: parsed.attributes,
        tags: merged,
        taggedAt: new Date(),
        tagSource: "llm",
      },
      select: {
        category: true,
        attributes: true,
        tags: true,
        tagSource: true,
      },
    });
    await auditMutation(db, ctx, {
      action: "merchant_product.update",
      target: `merchant_product:${id}`,
      before: {
        category: current.category,
        attributes: current.attributes,
        tags: current.tags,
        tagSource: current.tagSource ?? null,
      },
      after: {
        category: updated.category,
        tags: updated.tags,
        attributes: updated.attributes,
        tagSource: updated.tagSource,
      },
    });
  });

  return { ok: true, product: await getMerchantProduct(ctx, id, base) };
}

// Fire-and-forget wrapper for the import path: a tagging failure must never
// surface as an import failure, so it is logged and swallowed. `taggedAt` on
// the row is the completion signal the console polls.
export function kickOffTagging(
  ctx: TenantContext,
  id: bigint,
  deps: TaggingDeps = {},
): void {
  void tagMerchantProductWithLlm(ctx, id, deps).catch((err: unknown) => {
    logger.warn(
      { productId: String(id), err: String(err) },
      "merchant product auto-tag failed",
    );
  });
}
