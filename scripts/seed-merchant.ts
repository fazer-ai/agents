#!/usr/bin/env bun

import { PrismaPg } from "@prisma/adapter-pg";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { ingestLead, type LeadIngestInput } from "@/modules/merchant/leads";
import { createMerchantProduct } from "@/modules/merchant/products";
// Merchant MVP demo seed: ~10 Vietnamese catalog products across 3 niches
// (fashion / cosmetics / healthy snacks) plus ~8 social posts run through the
// same ingest path the REST endpoint uses, so the leads land pre-scored with
// their product matches. Idempotent: products and leads are skipped when a row
// with the same name/text already exists on the tenant.
import { PrismaClient } from "../generated/prisma/client";

// Same connection choice as seed-local-demo: the migration/superuser URL, so the
// script can seed any tenant without a session. runScopedOn still injects
// tenant_id and sets the GUC exactly like the runtime path.
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("MIGRATION_DATABASE_URL (or DATABASE_URL) required");
  process.exit(1);
}
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url }),
});

const PRODUCTS: {
  name: string;
  description: string;
  price: number;
  stock: number;
  tags: string[];
}[] = [
  {
    name: "Áo thun form rộng basic",
    description: "Áo thun unisex cotton 2 chiều, form rộng streetwear.",
    price: 149000,
    stock: 120,
    tags: ["áo thun", "form rộng", "thời trang", "basic"],
  },
  {
    name: "Áo thun oversize in hình",
    description: "Áo thun oversize in hình nghệ thuật, vải dày 250gsm.",
    price: 189000,
    stock: 80,
    tags: ["áo thun", "oversize", "unisex"],
  },
  {
    name: "Áo sơ mi linen nữ",
    description: "Sơ mi linen thoáng mát, tôn dáng, hợp đi làm lẫn đi chơi.",
    price: 259000,
    stock: 45,
    tags: ["áo sơ mi", "linen", "thời trang nữ"],
  },
  {
    name: "Quần jeans ống rộng",
    description: "Jeans ống rộng cạp cao, chất denim mềm không co giãn.",
    price: 329000,
    stock: 60,
    tags: ["quần jeans", "ống rộng", "denim"],
  },
  {
    name: "Serum trị mụn BHA 2%",
    description: "Serum BHA 2% cho da dầu mụn, giảm tắc lỗ chân lông.",
    price: 289000,
    stock: 200,
    tags: ["serum", "trị mụn", "bha", "da dầu", "mỹ phẩm"],
  },
  {
    name: "Serum vitamin C sáng da",
    description: "Vitamin C 10% làm sáng da, mờ thâm sau mụn.",
    price: 319000,
    stock: 150,
    tags: ["serum", "vitamin c", "sáng da", "mờ thâm"],
  },
  {
    name: "Kem chống nắng SPF50+",
    description: "Kem chống nắng thấm nhanh không bết, phù hợp da nhạy cảm.",
    price: 199000,
    stock: 180,
    tags: ["kem chống nắng", "sunscreen", "spf50", "da nhạy cảm"],
  },
  {
    name: "Snack rong biển sấy giòn",
    description: "Rong biển sấy giòn ít dầu, hợp ăn vặt healthy.",
    price: 35000,
    stock: 500,
    tags: ["snack", "rong biển", "healthy", "ăn vặt"],
  },
  {
    name: "Hạt granola mix vị",
    description: "Granola yến mạch + hạt + trái khô, ít đường.",
    price: 89000,
    stock: 300,
    tags: ["granola", "hạt", "healthy", "ăn sáng", "snack"],
  },
  {
    name: "Trà detox thảo mộc",
    description: "Trà thảo mộc detox hỗ trợ tiêu hóa, 20 túi lọc.",
    price: 129000,
    stock: 90,
    tags: ["trà", "detox", "thảo mộc", "healthy"],
  },
];

const POSTS: LeadIngestInput[] = [
  {
    platform: "facebook",
    authorName: "Nguyễn Thảo",
    text: "Cần mua serum trị mụn cho da dầu, budget 300k. Chị nào dùng tốt tư vấn em với",
    groupName: "Hội mỹ phẩm chính hãng",
    sourceUrl: "https://facebook.com/groups/mypham/posts/101",
  },
  {
    platform: "zalo",
    authorName: "Trần Minh",
    text: "Ai bán áo thun form rộng giá rẻ không ạ, em cần 2 cái",
    groupName: "Nhóm sinh viên HCM",
  },
  {
    platform: "threads",
    authorName: "Lan Anh",
    authorHandle: "@lananh.fit",
    text: "Tìm snack vặt healthy ăn buổi chiều, ai có gợi ý không",
  },
  {
    platform: "facebook",
    authorName: "Phạm Thu Hà",
    text: "Serum vitamin C nào tốt mọi người ơi, giá tầm bao nhiêu là hợp lý",
    groupName: "Review mỹ phẩm VN",
  },
  {
    platform: "facebook",
    authorName: "Đỗ Quỳnh",
    text: "Mình pass lại áo sơ mi linen mặc đúng 1 lần, 150k bao ship",
    groupName: "Chợ đồ cũ Hà Nội",
  },
  {
    platform: "zalo",
    authorName: "Lê Minh Đức",
    text: "Cần tìm kem chống nắng cho da nhạy cảm, shop nào còn hàng ship gấp giúp em",
    groupName: "Nhóm skincare",
  },
  {
    platform: "threads",
    authorName: "Vy Trần",
    authorHandle: "@vytea",
    text: "Ai có granola ăn sáng healthy không recommend em với, muốn mua",
  },
  {
    platform: "facebook",
    authorName: "Hoàng Nam",
    text: "Quần jeans ống rộng size M còn hàng không shop ơi, bao nhiêu tiền",
    groupName: "Thời trang nam nữ",
  },
];

async function main() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { id: "asc" } });
  if (!tenant) {
    console.error("No tenant found - run /setup or bun set-admin first");
    process.exit(1);
  }
  const ctx: TenantContext = {
    tenantId: tenant.id,
    userId: null,
    role: "TENANT_ADMIN",
    actorType: "system",
  };
  const tenantId = tenant.id;

  let productsCreated = 0;
  for (const p of PRODUCTS) {
    const exists = await runScopedOn(prisma, ctx, (db) =>
      db.merchantProduct.findFirst({
        where: { name: p.name },
        select: { id: true },
      }),
    );
    if (exists) continue;
    await createMerchantProduct(ctx, p, prisma);
    productsCreated++;
  }
  console.log(
    `Products: ${productsCreated} created, ${PRODUCTS.length - productsCreated} already present`,
  );

  let leadsCreated = 0;
  for (const post of POSTS) {
    const exists = await runScopedOn(prisma, ctx, (db) =>
      db.lead.findFirst({
        where: {
          platform: post.platform,
          authorName: post.authorName,
          text: post.text,
        },
        select: { id: true },
      }),
    );
    if (exists) continue;
    const lead = await ingestLead(ctx, post, prisma);
    leadsCreated++;
    console.log(
      `  lead ${lead.id}: score=${lead.score} matches=${lead.matches.map((m) => m.productName).join(", ") || "-"}`,
    );
  }
  console.log(
    `Leads: ${leadsCreated} ingested, ${POSTS.length - leadsCreated} already present`,
  );

  // A couple of orders so /orders renders real rows: one CONFIRMED off the
  // serum lead, one PAID off the áo thun lead.
  const orderCount = await runScopedOn(prisma, ctx, (db) =>
    db.merchantOrder.count(),
  );
  if (orderCount === 0) {
    const serumLead = await runScopedOn(prisma, ctx, (db) =>
      db.lead.findFirst({
        where: { text: { contains: "serum trị mụn" } },
        select: { id: true },
      }),
    );
    const shirtLead = await runScopedOn(prisma, ctx, (db) =>
      db.lead.findFirst({
        where: { text: { contains: "áo thun form rộng" } },
        select: { id: true },
      }),
    );
    const productIdByName = new Map(
      (
        await runScopedOn(prisma, ctx, (db) =>
          db.merchantProduct.findMany({ select: { id: true, name: true } }),
        )
      ).map((p) => [p.name, p.id] as const),
    );
    await runScopedOn(prisma, ctx, async (db) => {
      const order1 = await db.merchantOrder.create({
        data: {
          tenantId,
          leadId: serumLead?.id ?? null,
          contactName: "Nguyễn Thảo",
          contactPhone: "0901234567",
          contactAddress: "Quận 1, TP.HCM",
          status: "CONFIRMED",
          totalAmount: 289000,
          note: "Chốt qua inbox, COD",
        },
        select: { id: true },
      });
      // Flat createMany, not a nested write: the tenancy extension injects
      // tenant_id only on top-level args (and its rows name it here anyway).
      await db.merchantOrderItem.createMany({
        data: [
          {
            tenantId,
            orderId: order1.id,
            productId: productIdByName.get("Serum trị mụn BHA 2%") ?? null,
            qty: 1,
            unitPrice: 289000,
          },
        ],
      });
      const order2 = await db.merchantOrder.create({
        data: {
          tenantId,
          leadId: shirtLead?.id ?? null,
          contactName: "Trần Minh",
          contactPhone: "0912345678",
          contactAddress: "Quận Bình Thạnh, TP.HCM",
          status: "PAID",
          totalAmount: 298000,
          note: "Đã chuyển khoản",
        },
        select: { id: true },
      });
      await db.merchantOrderItem.createMany({
        data: [
          {
            tenantId,
            orderId: order2.id,
            productId: productIdByName.get("Áo thun form rộng basic") ?? null,
            qty: 2,
            unitPrice: 149000,
          },
        ],
      });
    });
    console.log("Orders: 2 created");
  } else {
    console.log(`Orders: ${orderCount} already present, skipped`);
  }
}

main()
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
