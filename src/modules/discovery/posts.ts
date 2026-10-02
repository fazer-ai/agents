import { createHash } from "node:crypto";
import { z } from "zod";
import { LEAD_PLATFORMS, type LeadIngestInput } from "@/modules/merchant/leads";

// Discovery: what every source kind produces - one upstream social post/comment,
// normalized so the ingest pipeline sees the same shape whatever scanned it.
// `externalId` is the post's upstream id; together with (tenant, platform) it is
// the dedupe key on Lead (Postgres treats NULL as distinct, so manual leads
// never collide, but a scanned post always carries one - see hashExternalId).

export type ScannedPlatform = LeadIngestInput["platform"];

export interface ScannedPost {
  platform: ScannedPlatform;
  externalId: string;
  authorName: string;
  authorHandle?: string;
  text: string;
  sourceUrl?: string;
  groupName?: string;
  postedAt?: Date;
}

// Field aliases a pasted file may use for each canonical field; the first match
// wins. Kept generous on purpose: the file rail is how operators drop exports
// from scraper tools and spreadsheets in without a transform step.
const FIELD_ALIASES: Record<string, readonly string[]> = {
  platform: ["platform", "source", "channel"],
  externalId: [
    "externalId",
    "external_id",
    "id",
    "postId",
    "post_id",
    "commentId",
    "comment_id",
    "cid",
  ],
  authorName: [
    "authorName",
    "author_name",
    "author",
    "name",
    "nickname",
    "user",
  ],
  authorHandle: [
    "authorHandle",
    "author_handle",
    "handle",
    "username",
    "unique_id",
  ],
  text: ["text", "content", "body", "message", "comment"],
  sourceUrl: ["sourceUrl", "source_url", "url", "link", "permalink"],
  groupName: [
    "groupName",
    "group_name",
    "group",
    "community",
    "videoTitle",
    "video_title",
  ],
  postedAt: [
    "postedAt",
    "posted_at",
    "createdAt",
    "created_at",
    "timestamp",
    "create_time",
    "time",
  ],
};

function pick(raw: Record<string, unknown>, field: string): unknown {
  for (const key of FIELD_ALIASES[field] ?? [field]) {
    const v = raw[key];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

// Deterministic id for a post that has no upstream one (a CSV row, a pasted
// line), so re-importing the same file dedupes instead of duplicating leads.
export function hashExternalId(
  platform: string,
  authorName: string,
  text: string,
): string {
  const digest = createHash("sha256")
    .update(`${platform}${authorName}${text}`)
    .digest("hex")
    .slice(0, 24);
  return `h:${digest}`;
}

function toText(v: unknown): string | undefined {
  if (typeof v === "string") {
    const s = v.trim();
    return s === "" ? undefined : s;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

function toPostedAt(v: unknown): Date | undefined {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v;
  if (typeof v === "number" && Number.isFinite(v)) {
    // Unix seconds vs milliseconds: anything past ~2001 in ms stays ms,
    // anything plausibly seconds (< 1e12) is seconds.
    const ms = Math.abs(v) < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "") return undefined;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

export const scannedPostSchema = z.object({
  platform: z.enum(LEAD_PLATFORMS),
  externalId: z.string().min(1).max(500),
  authorName: z.string().min(1).max(300),
  authorHandle: z.string().max(300).optional(),
  text: z.string().min(1).max(20000),
  sourceUrl: z.string().max(2000).optional(),
  groupName: z.string().max(300).optional(),
  postedAt: z.date().optional(),
});

// One loosely-shaped record -> one ScannedPost, or null when the record cannot
// be a post (missing/invalid text, unknown platform). Never throws: a malformed
// row in an import is a skipped row, not a failed run.
export function normalizeScannedPost(raw: unknown): ScannedPost | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const platform = toText(pick(record, "platform"))?.toLowerCase();
  const authorName = toText(pick(record, "authorName"));
  const text = toText(pick(record, "text"));
  if (!platform || !authorName || !text) return null;
  const externalId =
    toText(pick(record, "externalId")) ??
    hashExternalId(platform, authorName, text);
  const parsed = scannedPostSchema.safeParse({
    platform,
    externalId,
    authorName,
    authorHandle: toText(pick(record, "authorHandle")),
    text,
    sourceUrl: toText(pick(record, "sourceUrl")),
    groupName: toText(pick(record, "groupName")),
    postedAt: toPostedAt(pick(record, "postedAt")),
  });
  return parsed.success ? parsed.data : null;
}

// Whole-batch normalize + in-batch dedupe on (platform, externalId): the first
// occurrence of a key wins, later ones count as deduped - the same answer the
// lead table's unique key would give, without spending writes on it.
export function normalizeScannedPosts(raws: readonly unknown[]): {
  posts: ScannedPost[];
  skipped: number;
  deduped: number;
} {
  const seen = new Set<string>();
  const posts: ScannedPost[] = [];
  let skipped = 0;
  let deduped = 0;
  for (const raw of raws) {
    const post = normalizeScannedPost(raw);
    if (!post) {
      skipped++;
      continue;
    }
    const key = `${post.platform}${post.externalId}`;
    if (seen.has(key)) {
      deduped++;
      continue;
    }
    seen.add(key);
    posts.push(post);
  }
  return { posts, skipped, deduped };
}
