import { z } from "zod";
import { AppError } from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { normalizeVi } from "@/modules/merchant/scorer";
import fixtureComments from "./fixtures/tiktok-comments.json";

// tiktok_comments scanner: comment mining on videos. `mode: "fixture"` reads a
// bundled sample of Vietnamese TikTok comments (the dev/test rail); `mode:
// "api"` is where the real fetch lands once a TikTok credential/API path is
// chosen (TikTok has no public comment-search API for arbitrary keywords), and
// today it refuses cleanly instead of silently returning nothing.

export const tiktokConfigSchema = z
  .object({
    mode: z.enum(["fixture", "api"]),
    // Optional keyword filter applied to the comment text (diacritics-folded
    // contains, same normalization the lead scorer uses).
    keywords: z.array(z.string().min(1).max(200)).max(20).optional(),
  })
  .strict();
export type TiktokConfig = z.infer<typeof tiktokConfigSchema>;

interface FixtureComment {
  id: string;
  authorName: string;
  authorHandle?: string;
  text: string;
  videoTitle?: string;
  videoUrl?: string;
  postedAt?: string;
  likeCount?: number;
}

function matchesKeywords(
  text: string,
  keywords: string[] | undefined,
): boolean {
  if (!keywords || keywords.length === 0) return true;
  const normalized = normalizeVi(text);
  return keywords.some((kw) => normalized.includes(normalizeVi(kw.trim())));
}

export function scanTiktokComments(source: {
  name: string;
  config: unknown;
}): unknown[] {
  const cfg = parseInput(tiktokConfigSchema, source.config, "config");
  if (cfg.mode === "api") {
    throw new AppError(
      `tiktok_comments api mode is not implemented yet - run it in fixture mode or use file_import`,
      400,
      "errors.merchantSourceModeUnsupported",
      { mode: cfg.mode, kind: "tiktok_comments" },
    );
  }
  return (fixtureComments as FixtureComment[])
    .filter((c) => matchesKeywords(c.text, cfg.keywords))
    .map((c) => ({
      platform: "tiktok",
      externalId: c.id,
      authorName: c.authorName,
      authorHandle: c.authorHandle ? `@${c.authorHandle}` : undefined,
      text: c.text,
      // A TikTok comment's "community" is the video it was left under.
      groupName: c.videoTitle,
      sourceUrl: c.videoUrl,
      postedAt: c.postedAt,
    }));
}
