import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { AppError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import {
  parseCsv,
  parseImport,
  scanFileImport,
} from "@/modules/discovery/file-import";
import {
  hashExternalId,
  normalizeScannedPost,
  normalizeScannedPosts,
} from "@/modules/discovery/posts";
import {
  createLeadSource,
  deleteLeadSource,
  getLeadSource,
  listLeadSources,
  runLeadSource,
  updateLeadSource,
} from "@/modules/discovery/sources";
import { scanTiktokComments } from "@/modules/discovery/tiktok";
import { listLeads } from "@/modules/merchant/leads";
import { ensurePendingVaultEntryOn } from "@/modules/vault/service";

// Discovery sources: parser + normalization stay pure (no DB); run/bookkeeping
// tests use their own app-role client (TEST_APP_DATABASE_URL) so they run under
// real RLS, and skip when no test database is up.

// ---------------------------------------------------------------------------
// Pure: normalization
// ---------------------------------------------------------------------------

describe("discovery normalize", () => {
  test("maps common aliases and lowercases the platform", () => {
    const post = normalizeScannedPost({
      source: "TikTok",
      comment_id: "c-9",
      author: "Lan",
      username: "lan.88",
      content: "cần mua serum",
      url: "https://tiktok.com/x",
      group: "Skincare VN",
      posted_at: "2026-09-28T09:12:00Z",
    });
    expect(post).not.toBeNull();
    expect(post?.platform).toBe("tiktok");
    expect(post?.externalId).toBe("c-9");
    expect(post?.authorName).toBe("Lan");
    expect(post?.authorHandle).toBe("lan.88");
    expect(post?.text).toBe("cần mua serum");
    expect(post?.sourceUrl).toBe("https://tiktok.com/x");
    expect(post?.groupName).toBe("Skincare VN");
    expect(post?.postedAt?.toISOString()).toBe("2026-09-28T09:12:00.000Z");
  });

  test("drops rows that cannot be a post instead of failing the batch", () => {
    expect(normalizeScannedPost(null)).toBeNull();
    expect(normalizeScannedPost("a string")).toBeNull();
    expect(normalizeScannedPost({ author: "x" })).toBeNull(); // no text/platform
    expect(
      normalizeScannedPost({ platform: "myspace", author: "x", text: "y" }),
    ).toBeNull(); // platform outside LEAD_PLATFORMS
  });

  test("hashes a deterministic externalId when the row carries none", () => {
    const a = normalizeScannedPost({
      platform: "facebook",
      author: "Lan",
      text: "cần mua serum BHA",
    });
    const b = normalizeScannedPost({
      platform: "facebook",
      author: "Lan",
      text: "cần mua serum BHA",
    });
    expect(a?.externalId).toBe(b?.externalId);
    expect(a?.externalId.startsWith("h:")).toBe(true);
    // The same text under another platform is a different post.
    expect(hashExternalId("tiktok", "Lan", "cần mua serum BHA")).not.toBe(
      a?.externalId,
    );
  });

  test("batch dedupes on (platform, externalId), first occurrence wins", () => {
    const { posts, skipped, deduped } = normalizeScannedPosts([
      { platform: "tiktok", id: "1", author: "A", text: "one" },
      { platform: "tiktok", id: "1", author: "B", text: "dup" },
      {
        platform: "facebook",
        id: "1",
        author: "A",
        text: "same id, other platform",
      },
      { junk: true },
    ]);
    expect(posts).toHaveLength(2);
    expect(posts[0]?.authorName).toBe("A");
    expect(posts[1]?.platform).toBe("facebook");
    expect(skipped).toBe(1);
    expect(deduped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Pure: file_import parsing
// ---------------------------------------------------------------------------

describe("discovery file_import", () => {
  test("parseCsv handles quoted cells, escaped quotes and embedded commas", () => {
    const rows = parseCsv(
      'id,author,text\n"p-1","Lan","cần mua, gấp"\np-2,"Tr ""Bắp""",chốt đơn\n',
    );
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual(["p-1", "Lan", "cần mua, gấp"]);
    expect(rows[2]?.[1]).toBe('Tr "Bắp"');
  });

  test("parseImport reads JSONL lines and skips nothing it can salvage", () => {
    const content = [
      '{"platform":"tiktok","id":"a","author":"A","text":"cần mua"}',
      "",
      "not json at all",
      '{"platform":"facebook","id":"b","author":"B","text":"ai bán"}',
    ].join("\n");
    const records = parseImport(content, "jsonl");
    expect(records).toHaveLength(3); // blank line dropped, bad line kept as a skipped row
    const { posts, skipped } = normalizeScannedPosts(records);
    expect(posts).toHaveLength(2);
    expect(skipped).toBe(1);
  });

  test("parseImport accepts a top-level JSON array too", () => {
    const records = parseImport(
      '[{"platform":"web","id":"1","author":"A","text":"x"}]',
      "auto",
    );
    expect(records).toHaveLength(1);
  });

  test("auto format sniffs CSV by a non-JSON first character", () => {
    const records = parseImport(
      "id,author,text\np1,Lan,cần mua serum\n",
      "auto",
    );
    const { posts } = normalizeScannedPosts(
      // Rows without a platform only normalize once the source default lands.
      (records as Record<string, unknown>[]).map((r) => ({
        platform: "tiktok",
        ...r,
      })),
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]?.externalId).toBe("p1");
  });

  test("run-time content overrides the stored config, and the default platform fills rows without one", () => {
    const source = {
      name: "fixture rail",
      config: { platform: "tiktok", content: '{"id":"old"}' },
    };
    const raws = scanFileImport(source, {
      content: '{"id":"new","author":"A","text":"cần mua"}',
    });
    expect(raws).toHaveLength(1);
    expect((raws[0] as Record<string, unknown>).id).toBe("new");
    expect((raws[0] as Record<string, unknown>).platform).toBe("tiktok");
  });

  test("a source with no content anywhere fails as a config error, not a crash", () => {
    try {
      scanFileImport({ name: "empty", config: {} }, {});
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).statusCode).toBe(422);
      expect((e as AppError).message).toContain('"empty"');
    }
  });
});

// ---------------------------------------------------------------------------
// Pure: tiktok fixture scanner + registry refusal
// ---------------------------------------------------------------------------

describe("discovery tiktok fixture", () => {
  test("fixture mode returns the bundled comments as normalizable records", () => {
    const raws = scanTiktokComments({
      name: "tt",
      config: { mode: "fixture" },
    });
    expect(raws.length).toBeGreaterThanOrEqual(6);
    const { posts, skipped } = normalizeScannedPosts(raws);
    expect(skipped).toBe(0);
    for (const p of posts) {
      expect(p.platform).toBe("tiktok");
      expect(p.externalId.length).toBeGreaterThan(0);
    }
  });

  test("a keyword filter narrows the fixture (diacritics-folded)", () => {
    const all = scanTiktokComments({ name: "tt", config: { mode: "fixture" } });
    const filtered = scanTiktokComments({
      name: "tt",
      config: { mode: "fixture", keywords: ["serum"] },
    });
    expect(filtered.length).toBeLessThan(all.length);
    expect(filtered.length).toBeGreaterThan(0);
  });

  test("api mode refuses clearly instead of silently returning nothing", () => {
    try {
      scanTiktokComments({ name: "tt", config: { mode: "api" } });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).statusCode).toBe(400);
      expect((e as AppError).message).toContain("api");
    }
  });
});

describe("discovery source registry", () => {
  const ctx: TenantContext = {
    tenantId: 1n,
    userId: null,
    role: "TENANT_ADMIN",
  };

  test("an unknown kind is refused at write time and names the supported set", async () => {
    try {
      // The refusal happens before runScopedOn, so a stand-in base is enough.
      await createLeadSource(
        ctx,
        { name: "x", kind: "facebook_groups" },
        {} as PrismaClient,
      );
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).statusCode).toBe(422);
      expect((e as AppError).message).toContain("file_import");
      expect((e as AppError).message).toContain("threads_api");
      expect((e as AppError).message).toContain("tiktok_comments");
    }
  });

  test("a config that does not fit its kind is refused at write time", async () => {
    try {
      await createLeadSource(
        ctx,
        { name: "x", kind: "threads_api", config: { mode: "fixture" } },
        {} as PrismaClient,
      );
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
    }
  });
});

// ---------------------------------------------------------------------------
// DB-backed: a source run end to end, with real RLS
// ---------------------------------------------------------------------------

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;

let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;

if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

const appDb = app as PrismaClient;
let tenantId = 0n;
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

function scoped<T>(fn: (db: ScopedDb) => Promise<T>): Promise<T> {
  return runScopedOn(appDb, ctx(), fn);
}

// Six realistic posts plus a duplicate and a malformed line: the full normalize
// -> dedupe -> score -> match path is exercised by the one scan.
const FIXTURE_JSONL = [
  '{"platform":"facebook","id":"fb-1001","author":"Lan Anh","group":"Hội skincare Việt Nam","text":"Cần mua serum BHA chính hãng, ai bán inbox em với ạ"}',
  '{"platform":"tiktok","id":"tt-2001","author":"Minh Trí","text":"áo thun form rộng này giá bao nhiêu v shop, size L còn không"}',
  '{"platform":"threads","id":"thr-3001","author":"Thu Hà","text":"dùng 2 tuần thấy da đỡ dầu hẳn, recommend nha"}',
  '{"platform":"facebook","id":"fb-1002","author":"Shop Mỹ Phẩm X","text":"em pass lại quần jeans ống rộng size M mặc 1 lần, 200k bao ship"}',
  '{"platform":"zalo","id":"zl-4001","author":"Hải Đăng","text":"có ai bán granola ít đường không mn, tìm mua ăn sáng mà toàn loại ngọt"}',
  '{"platform":"facebook","id":"fb-1003","author":"Phương Nhi","text":"kem chống nắng này da nhạy cảm dùng được không chị, phí ship bao nhiêu ạ"}',
  '{"platform":"facebook","id":"fb-1001","author":"Lan Anh","text":"duplicate line"}',
  '{"platform":"facebook","id":"bad-1","author":"No Text"}',
].join("\n");

describe.skipIf(!dbUp)("discovery source runs", () => {
  beforeAll(async () => {
    if (!su) return;
    const t = await su.tenant.create({
      data: { name: "Discovery", slug: `discovery-${process.pid}` },
    });
    tenantId = t.id;
    // Catalog for the scorer to match against.
    await scoped((db) =>
      db.merchantProduct.createMany({
        data: [
          {
            tenantId,
            name: "Serum BHA 2%",
            price: 250000,
            tags: ["serum", "bha", "trị mụn"],
          },
          {
            tenantId,
            name: "Áo thun form rộng",
            price: 180000,
            tags: ["áo thun", "basic"],
          },
          {
            tenantId,
            name: "Granola ít đường",
            price: 120000,
            tags: ["granola", "ăn sáng"],
          },
          {
            tenantId,
            name: "Kem chống nắng SPF50",
            price: 320000,
            tags: ["kem chống nắng"],
          },
        ],
      }),
    );
  });

  afterAll(async () => {
    if (su && tenantId) {
      await su.$executeRawUnsafe(
        `DELETE FROM lead_product_matches WHERE tenant_id = ${tenantId}`,
      );
      await su.$executeRawUnsafe(
        `DELETE FROM leads WHERE tenant_id = ${tenantId}`,
      );
      await su.$executeRawUnsafe(
        `DELETE FROM lead_sources WHERE tenant_id = ${tenantId}`,
      );
      await su.$executeRawUnsafe(
        `DELETE FROM merchant_products WHERE tenant_id = ${tenantId}`,
      );
      await su.$executeRawUnsafe(
        `DELETE FROM vault_entries WHERE tenant_id = ${tenantId}`,
      );
      await su.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`,
      );
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("file_import run: scans, dedupes in-batch, scores, matches and books ok", async () => {
    const source = await createLeadSource(
      ctx(),
      {
        name: "FB group export",
        kind: "file_import",
        config: { format: "jsonl" },
      },
      appDb,
    );
    const run = await runLeadSource(
      ctx(),
      BigInt(source.id),
      { content: FIXTURE_JSONL },
      appDb,
    );
    expect(run.scanned).toBe(8);
    expect(run.skipped).toBe(1); // the line without text
    expect(run.deduped).toBe(1); // the repeated fb-1001
    expect(run.new).toBe(6);
    expect(run.leads).toHaveLength(6);

    // Scoring: buyer-intent posts score high, the seller post is capped, the
    // chatter line stays low; catalog matches land where the text names a
    // product or its tag.
    const page = await listLeads(ctx(), { sourceId: BigInt(source.id) }, appDb);
    expect(page.items).toHaveLength(6);
    const byText = new Map(page.items.map((l) => [l.text, l]));
    const serum = byText.get(
      "Cần mua serum BHA chính hãng, ai bán inbox em với ạ",
    );
    expect(serum?.score).toBeGreaterThanOrEqual(60);
    expect(serum?.matches.some((m) => m.productName === "Serum BHA 2%")).toBe(
      true,
    );
    expect(
      byText.get(
        "em pass lại quần jeans ống rộng size M mặc 1 lần, 200k bao ship",
      )?.score,
    ).toBeLessThanOrEqual(10);
    expect(
      byText.get("dùng 2 tuần thấy da đỡ dầu hẳn, recommend nha")?.score,
    ).toBeLessThanOrEqual(40);

    // Bookkeeping landed on the source row.
    expect(run.source.lastStatus).toBe("ok");
    expect(run.source.lastError).toBeNull();
    expect(run.source.lastRunAt).not.toBeNull();
    const stored = await getLeadSource(ctx(), BigInt(source.id), appDb);
    expect(stored.lastStatus).toBe("ok");
    expect(stored.leadCount).toBe(6);
  });

  test("a second run of the same export dedupes every post", async () => {
    // Its own externalIds - the dedupe key is tenant-wide, so reusing the
    // shared fixture would collide with the first test's leads, not "dedupe".
    const content = FIXTURE_JSONL.replaceAll(
      /"(fb|tt|thr|zl|bad)-/g,
      '"dup-$1-',
    );
    const source = await createLeadSource(
      ctx(),
      {
        name: "Dedupe rail",
        kind: "file_import",
        config: { format: "jsonl", content },
      },
      appDb,
    );
    const first = await runLeadSource(ctx(), BigInt(source.id), {}, appDb);
    expect(first.new).toBe(6);

    const second = await runLeadSource(ctx(), BigInt(source.id), {}, appDb);
    expect(second.scanned).toBe(8);
    expect(second.skipped).toBe(1);
    // One in-batch duplicate plus six hits on the stored dedupe key.
    expect(second.deduped).toBe(7);
    expect(second.new).toBe(0);
    expect(second.leads).toHaveLength(0);
    expect(second.source.lastStatus).toBe("ok");
  });

  test("a failed run still writes lastStatus/lastError on the source", async () => {
    const source = await createLeadSource(
      ctx(),
      {
        name: "Empty rail",
        kind: "file_import",
        config: {},
      },
      appDb,
    );
    await expect(
      runLeadSource(ctx(), BigInt(source.id), {}, appDb),
    ).rejects.toBeInstanceOf(AppError);
    const stored = await getLeadSource(ctx(), BigInt(source.id), appDb);
    expect(stored.lastStatus).toBe("error");
    expect(stored.lastError).toContain("no content");
    expect(stored.lastRunAt).not.toBeNull();
  });

  test("a credentialRef naming no vault entry is refused at write", async () => {
    await expect(
      createLeadSource(
        ctx(),
        {
          name: "Threads search",
          kind: "threads_api",
          config: {
            credentialRef: "vault:999999999",
            keywords: ["cần mua"],
          },
        },
        appDb,
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      translationKey: "errors.vaultRefNotFound",
      field: "config.credentialRef",
    });
  });

  test("threads_api with an unfilled credential fails cleanly and books error", async () => {
    // A pending vault entry exists (so the write passes) but holds no secret -
    // the state tryResolveApiKeyEntry cannot run on.
    const { ref } = await runScopedOn(appDb, ctx(), (db) =>
      ensurePendingVaultEntryOn(db, ctx(), {
        name: `threads-${process.pid}`,
      }),
    );
    const source = await createLeadSource(
      ctx(),
      {
        name: "Threads search",
        kind: "threads_api",
        config: {
          credentialRef: ref,
          keywords: ["cần mua"],
        },
      },
      appDb,
    );
    try {
      await runLeadSource(ctx(), BigInt(source.id), {}, appDb);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).statusCode).toBe(400);
    }
    const stored = await getLeadSource(ctx(), BigInt(source.id), appDb);
    expect(stored.lastStatus).toBe("error");
    expect(stored.lastError).toContain("credential");
  });

  test("tiktok fixture mode scans the bundled comments through the same rail", async () => {
    const source = await createLeadSource(
      ctx(),
      {
        name: "TikTok fixture",
        kind: "tiktok_comments",
        config: { mode: "fixture" },
      },
      appDb,
    );
    const run = await runLeadSource(ctx(), BigInt(source.id), {}, appDb);
    expect(run.new).toBeGreaterThanOrEqual(6);
    const page = await listLeads(ctx(), { sourceId: BigInt(source.id) }, appDb);
    expect(
      page.items.every(
        (l) => l.platform === "tiktok" && l.sourceId === source.id,
      ),
    ).toBe(true);
  });

  test("deleting a source keeps its leads (sourceId cleared)", async () => {
    const source = await createLeadSource(
      ctx(),
      {
        name: "Throwaway",
        kind: "file_import",
        config: {
          format: "jsonl",
          content:
            '{"platform":"web","id":"del-1","author":"A","text":"cần mua sữa rửa mặt"}',
        },
      },
      appDb,
    );
    const run = await runLeadSource(ctx(), BigInt(source.id), {}, appDb);
    expect(run.new).toBe(1);
    await deleteLeadSource(ctx(), BigInt(source.id), appDb);
    const page = await listLeads(ctx(), {}, appDb);
    const lead = page.items.find((l) => l.externalId === "del-1");
    expect(lead).toBeDefined();
    expect(lead?.sourceId).toBeNull();
    expect(lead?.sourceName).toBeNull();
  });

  test("a kind change revalidates the stored config; running a missing source 404s", async () => {
    const source = await createLeadSource(
      ctx(),
      {
        name: "Switcher",
        kind: "file_import",
        config: {},
      },
      appDb,
    );
    // threads_api needs credentialRef + keywords: a bare kind switch must refuse.
    await expect(
      updateLeadSource(
        ctx(),
        BigInt(source.id),
        { kind: "threads_api" },
        appDb,
      ),
    ).rejects.toBeInstanceOf(AppError);
    const after = await getLeadSource(ctx(), BigInt(source.id), appDb);
    expect(after.kind).toBe("file_import");

    await expect(
      runLeadSource(ctx(), 424242424n, {}, appDb),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("listLeadSources returns every source with its lead count", async () => {
    const sources = await listLeadSources(ctx(), appDb);
    expect(sources.length).toBeGreaterThanOrEqual(4);
    const fb = sources.find((s) => s.name === "FB group export");
    expect(fb?.leadCount).toBe(6);
    expect(fb?.lastStatus).toBe("ok");
    const gone = sources.find((s) => s.name === "Throwaway");
    expect(gone).toBeUndefined();
  });
});
