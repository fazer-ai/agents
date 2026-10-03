import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import { AppError } from "@/lib/errors";
import { fetchBounded } from "@/lib/outbound";
import { parseInput } from "@/lib/parse-input";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { clipText } from "@/lib/text";
import { tryResolveApiKeyEntry } from "@/modules/vault/service";

// threads_api scanner: keyword search over the official Threads API
// (GET graph.threads.net/v1.0/search). The token lives in the vault, referenced
// by config.credentialRef ("vault:<id>"); without it the scan refuses cleanly,
// which is the expected state until an operator connects one.

export const THREADS_GRAPH_BASE = "https://graph.threads.net/v1.0";

export const threadsConfigSchema = z
  .object({
    credentialRef: z.string().min(1).max(200),
    keywords: z.array(z.string().min(1).max(200)).min(1).max(20),
    searchType: z.enum(["TOP", "MOST_RECENT"]).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type ThreadsConfig = z.infer<typeof threadsConfigSchema>;

interface ThreadsSearchItem {
  id?: string;
  text?: string;
  username?: string;
  permalink?: string;
  timestamp?: string;
}

export async function scanThreadsApi(
  ctx: TenantContext,
  source: { name: string; config: unknown },
  base: PrismaClient,
): Promise<unknown[]> {
  const cfg = parseInput(threadsConfigSchema, source.config, "config");
  // Vault read is DB-only, so it borrows a scoped transaction; the fetch below
  // happens after it resolves - no network I/O inside a tenant transaction.
  const credential = await runScopedOn(base, ctx, (db) =>
    tryResolveApiKeyEntry(db, cfg.credentialRef),
  );
  if (credential.state !== "ok") {
    throw new AppError(
      `source ${source.name} needs a Threads access token: point config.credentialRef at a filled vault entry`,
      400,
      "errors.merchantSourceCredentialRequired",
      { name: source.name },
    );
  }
  const out: unknown[] = [];
  for (const keyword of cfg.keywords) {
    const url = new URL(`${THREADS_GRAPH_BASE}/search`);
    url.searchParams.set("q", keyword);
    url.searchParams.set(
      "search_type",
      cfg.searchType === "TOP" ? "TOP" : "MOST_RECENT",
    );
    url.searchParams.set("fields", "id,text,username,permalink,timestamp");
    url.searchParams.set("limit", String(cfg.limit ?? 25));
    url.searchParams.set("access_token", credential.secret);
    // fetchBounded, never a bare fetch: headers AND body share one timer and
    // the reply lands already capped, so a stalled or oversized page cannot
    // pin the scan lane.
    const { res, body } = await fetchBounded(
      url.toString(),
      {},
      { timeoutMs: 15_000 },
    );
    if (!res.ok) {
      const detail = clipText(body.text, 300);
      throw new AppError(
        `threads search failed: HTTP ${res.status}${detail ? ` - ${detail}` : ""}`,
        502,
      );
    }
    const page = JSON.parse(body.text) as { data?: ThreadsSearchItem[] };
    for (const item of page.data ?? []) {
      // Search returns username only; authorName falls back to it (a post with
      // neither is dropped at normalize).
      out.push({
        platform: "threads",
        externalId: item.id,
        authorName: item.username,
        authorHandle: item.username ? `@${item.username}` : undefined,
        text: item.text,
        sourceUrl: item.permalink,
        postedAt: item.timestamp,
      });
    }
  }
  return out;
}
