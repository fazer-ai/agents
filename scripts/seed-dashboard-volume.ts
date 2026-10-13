#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { encryptJson } from "@/api/lib/crypto";
import { emailEquals } from "@/lib/email-match";
import { PrismaClient } from "../generated/prisma/client";

// Local-only volume seed for the dashboard (NOT for prod): one tenant with twelve months of traffic
// averaging about 9,000 conversations a day (growing from about 6,300 to 11,700 across the year),
// two to three billed calls each, and a flow log for the last 30 days only, as retention leaves it.
// Also an Agent Bot with a known route token and secret, so a signed Chatwoot webhook can be posted
// to the local app (the token, the secret and a sample command are printed at the end).
//
// bun scripts/seed-dashboard-volume.ts            (MIGRATION_DATABASE_URL: the superuser URL)
// Triggers are off while it writes (session_replication_role = replica): history is not a change.

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error("MIGRATION_DATABASE_URL required");
  process.exit(1);
}
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url }),
});

const EMAIL = "painel@local.test";
const PASSWORD = "painel12345";
const DAYS = 365;
const LOG_DAYS = 30;
const ROUTE_TOKEN = "painel-local-route-token";
const SECRET = "painel-local-secret";

async function main() {
  const existing = await prisma.tenant.findUnique({
    where: { slug: "painel-volume" },
  });
  if (existing) {
    console.error(
      `tenant painel-volume already exists (id ${existing.id}); drop the database to reseed`,
    );
    process.exit(1);
  }
  const tenant = await prisma.tenant.create({
    data: { name: "Painel com volume (local)", slug: "painel-volume" },
  });
  const passwordHash = await Bun.password.hash(PASSWORD, {
    algorithm: "bcrypt",
    cost: 10,
  });
  const found = await prisma.user.findFirst({
    where: { email: emailEquals(EMAIL) },
  });
  const person = found
    ? await prisma.user.update({
        where: { id: found.id },
        data: { passwordHash },
      })
    : await prisma.user.create({
        data: { email: EMAIL, passwordHash, name: "Painel" },
      });
  await prisma.tenantUser.create({
    data: { tenantId: tenant.id, userId: person.id, role: "TENANT_ADMIN" },
  });
  const deployment = await prisma.chatwootDeployment.create({
    data: {
      tenantId: tenant.id,
      baseUrl: "http://chatwoot.local",
      adminToken: encryptJson("painel-dummy-token"),
    },
  });
  const instance = await prisma.chatwootInstance.create({
    data: {
      tenantId: tenant.id,
      deploymentId: deployment.id,
      accountId: 1,
      serverKey: "painel-local-server",
      accountName: "Painel",
    },
  });
  const agent = (name: string) =>
    prisma.agent.create({
      data: {
        tenantId: tenant.id,
        name,
        systemPrompt: "Atenda com cordialidade.",
        modelConfig: { provider: "openai", model: "gpt-6-luna" },
      },
    });
  const ana = await agent("Ana (atendimento)");
  const beto = await agent("Beto (vendas)");
  const inbox = (n: number, name: string, agentId: bigint | null) =>
    prisma.inbox.create({
      data: {
        tenantId: tenant.id,
        chatwootInstanceId: instance.id,
        chatwootInboxId: n,
        name,
        agentId,
        channelType: "Channel::Whatsapp",
      },
    });
  const inboxes = [
    await inbox(1, "WhatsApp principal", ana.id),
    await inbox(2, "WhatsApp vendas", beto.id),
    await inbox(3, "Site", ana.id),
    await inbox(4, "E-mail", null),
  ];
  await prisma.chatwootAgentBot.create({
    data: {
      tenantId: tenant.id,
      chatwootInstanceId: instance.id,
      agentId: ana.id,
      chatwootAgentBotId: 7,
      accessToken: encryptJson("painel-bot-token"),
      webhookSecret: encryptJson(SECRET),
      webhookRouteTokenHash: createHash("sha256")
        .update(ROUTE_TOKEN)
        .digest("hex"),
      name: "Ana",
    },
  });

  const t = tenant.id;
  const inboxIds = `ARRAY[${inboxes.map((i) => i.id).join(",")}]::bigint[]`;
  const agentIds = `ARRAY[${ana.id},${beto.id}]::bigint[]`;
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        "SET LOCAL session_replication_role = replica",
      );
      await tx.$executeRawUnsafe("SELECT setseed(0.1383)");
      // One row per day: how many conversations started, and the first conversation number.
      await tx.$executeRawUnsafe(`
        CREATE TEMP TABLE seed_days ON COMMIT DROP AS
        SELECT d, n, SUM(n) OVER (ORDER BY d) - n AS before FROM (
          SELECT d, round(9000 * (0.7 + 0.6 * i / ${DAYS - 1}.0)
                          * CASE extract(isodow FROM d) WHEN 6 THEN 0.8 WHEN 7 THEN 0.65 ELSE 1.08 END
                          * (0.9 + random() * 0.2))::int AS n
            FROM generate_series(0, ${DAYS - 1}) i,
                 LATERAL (SELECT (date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => ${DAYS - 1} - i))::timestamp AS d) x
        ) y`);
      const [days] = await tx.$queryRawUnsafe<{ total: number }[]>(
        "SELECT SUM(n)::int AS total, AVG(n)::int AS avg FROM seed_days",
      );
      console.log(`conversations: ${days?.total}`);
      await tx.$executeRawUnsafe(`
        INSERT INTO conversations (tenant_id, chatwoot_instance_id, inbox_id, chatwoot_conversation_id,
                                   status, resolved_by, assignee_type, thread_id, labels, created_at,
                                   updated_at, last_inbound_at, chatwoot_created_at, chatwoot_first_reply_at)
        SELECT ${t}, ${instance.id}, (${inboxIds})[1 + (k % 4)], cid,
               CASE WHEN r < 0.62 THEN 'resolved' WHEN r < 0.8 THEN 'open' ELSE 'pending' END,
               CASE WHEN r < 0.38 THEN 'agent' WHEN r < 0.5 THEN 'human' WHEN r < 0.55 THEN 'followup_abandonment'
                    WHEN r < 0.62 THEN 'legacy_unknown' END,
               CASE WHEN r2 < 0.55 THEN 'AgentBot' WHEN r2 < 0.8 THEN 'User' END,
               '${t}:${instance.id}:' || cid,
               CASE WHEN r2 < 0.3 THEN ARRAY['vendas'] WHEN r2 < 0.5 THEN ARRAY['suporte']
                    WHEN r2 < 0.6 THEN ARRAY['suporte', 'urgente'] WHEN r2 < 0.65 THEN ARRAY['financeiro']
                    ELSE ARRAY[]::text[] END,
               at, at, at + make_interval(secs => r * 172800),
               CASE WHEN r2 < 0.7 THEN at END,
               CASE WHEN r2 < 0.7 THEN at + make_interval(secs => 5 + r * r * 7200) END
          FROM (
            SELECT (sd.before + k)::int AS cid, k, random() AS r, random() AS r2,
                   sd.d + make_interval(secs => random() * 86399) AS at
              FROM seed_days sd, generate_series(1, sd.n) k
          ) x
         WHERE at < now() AT TIME ZONE 'UTC'`);
      console.log("ledger");
      await tx.$executeRawUnsafe(`
        INSERT INTO llm_usage (tenant_id, agent_id, conversation_id, inbox_id, model, node, source,
                               prompt_tokens, completion_tokens, cached_read_tokens, cost_usd,
                               duration_ms, turn_id, created_at)
        SELECT c.tenant_id, CASE WHEN c.inbox_id = (${inboxIds})[2] THEN (${agentIds})[2] ELSE (${agentIds})[1] END,
               c.id, c.inbox_id,
               CASE WHEN random() < 0.7 THEN 'gpt-6-luna' WHEN random() < 0.6 THEN 'gpt-5.6-luna' ELSE 'claude-haiku-5-5' END,
               CASE WHEN g = 1 AND random() < 0.1 THEN 'vision' WHEN g = 3 THEN 'observer' END,
               'inbox', 800 + (random() * 4000)::int, 40 + (random() * 400)::int, (random() * 2000)::int,
               round((0.0004 + random() * 0.006)::numeric, 10),
               300 + (random() * random() * 20000)::int, c.id || '-' || g,
               c.created_at + make_interval(secs => g * 40 + random() * 600)
          FROM conversations c, generate_series(1, 2 + (c.id % 2)::int) g
         WHERE c.tenant_id = ${t} AND (c.assignee_type IS DISTINCT FROM 'User' OR c.id % 3 = 0)`);
      console.log("flow log (last 30 days)");
      await tx.$executeRawUnsafe(`
        INSERT INTO execution_logs (tenant_id, turn_id, conversation_id, agent_id, inbox_id, thread_id,
                                    stage, level, status, source, detail, created_at)
        SELECT c.tenant_id, c.id || '-h', c.id, ${ana.id}, c.inbox_id, c.thread_id,
               CASE WHEN r < 0.4 THEN 'tool' ELSE 'handoff' END,
               'info', 'ok', 'inbox',
               CASE WHEN r < 0.4 THEN '{"tool":"handoff_to_human","handedOff":true}'::jsonb
                    WHEN r < 0.6 THEN '{"outcome":"opened_after_skip","reason":"needs_human","assigned":"agent"}'::jsonb
                    WHEN r < 0.7 THEN '{"outcome":"opened_after_skip","reason":"not_for_us","assigned":"routing"}'::jsonb
                    WHEN r < 0.85 THEN '{"outcome":"guardrail_handoff","assigned":"team"}'::jsonb
                    ELSE '{"outcome":"taken_over"}'::jsonb END,
               c.created_at + interval '3 minutes'
          FROM (SELECT c.*, random() AS r FROM conversations c
                 WHERE c.tenant_id = ${t} AND c.created_at >= (now() AT TIME ZONE 'UTC') - interval '${LOG_DAYS} days'
                   AND (c.resolved_by = 'human' OR c.assignee_type = 'User')) c`);
      await tx.$executeRawUnsafe(`
        INSERT INTO execution_logs (tenant_id, turn_id, conversation_id, agent_id, inbox_id, thread_id,
                                    stage, level, status, source, detail, created_at)
        SELECT c.tenant_id, c.id || '-s', c.id, ${ana.id}, c.inbox_id, c.thread_id, 'tool', 'info', 'ok', 'inbox',
               jsonb_build_object('tool', 'skip_reply', 'skipReason',
                 (ARRAY['needs_human','not_for_us','spam','out_of_scope'])[1 + (c.id % 4)::int]),
               c.created_at + interval '1 minute'
          FROM conversations c
         WHERE c.tenant_id = ${t} AND c.created_at >= (now() AT TIME ZONE 'UTC') - interval '${LOG_DAYS} days'
           AND c.id % 9 = 0`);
      await tx.$executeRawUnsafe(`
        INSERT INTO execution_logs (tenant_id, turn_id, conversation_id, agent_id, inbox_id, thread_id,
                                    stage, level, status, source, detail, created_at)
        SELECT c.tenant_id, c.id || '-f' || g, c.id, ${ana.id}, c.inbox_id, c.thread_id, 'generate', 'info', 'ok', 'inbox',
               jsonb_build_object('trigger', 'followup', 'outcome', CASE WHEN g = 3 THEN 'templated' ELSE 'messaged' END),
               c.created_at + make_interval(hours => 20 * g)
          FROM conversations c, generate_series(1, 1 + (c.id % 3)::int) g
         WHERE c.tenant_id = ${t} AND c.created_at >= (now() AT TIME ZONE 'UTC') - interval '${LOG_DAYS} days'
           AND c.id % 7 = 0`);
      await tx.$executeRawUnsafe(`
        INSERT INTO execution_logs (tenant_id, turn_id, conversation_id, agent_id, inbox_id, thread_id,
                                    stage, level, status, source, detail, created_at)
        SELECT c.tenant_id, c.id || '-p', c.id, ${ana.id}, c.inbox_id, c.thread_id,
               (ARRAY['tool','generate','deliver'])[1 + (c.id % 3)::int],
               CASE WHEN c.id % 5 = 0 THEN 'error' ELSE 'warn' END, 'error', 'inbox',
               CASE WHEN c.id % 3 = 0 THEN jsonb_build_object('tool', (ARRAY['kanban_move_card','search_knowledge','check_calendar_availability'])[1 + (c.id % 3)::int]) ELSE '{}'::jsonb END,
               c.created_at + interval '2 minutes'
          FROM conversations c
         WHERE c.tenant_id = ${t} AND c.created_at >= (now() AT TIME ZONE 'UTC') - interval '${LOG_DAYS} days'
           AND c.id % 41 = 0`);
      console.log("knowledge suggestions");
      const kb = await tx.knowledgeBase.create({
        data: { tenantId: t, name: "Base principal" },
      });
      await tx.$executeRawUnsafe(`
        INSERT INTO approval_queue_items (tenant_id, knowledge_base_id, thread_id, proposed_content, status,
                                          agent_id, normalized_hash, created_at, updated_at)
        SELECT c.tenant_id, ${kb.id}, c.thread_id, 'Sugestão ' || c.id,
               (ARRAY['PENDING','APPROVED','REJECTED','DISCARDED'])[1 + (c.id % 4)::int]::"ApprovalStatus",
               ${ana.id}, 'h' || c.id, c.created_at + interval '10 minutes', c.created_at + interval '10 minutes'
          FROM conversations c
         WHERE c.tenant_id = ${t} AND c.id % 400 = 0`);
    },
    { timeout: 3_600_000, maxWait: 60_000 },
  );
  console.log("analyze");
  for (const table of [
    "conversations",
    "llm_usage",
    "execution_logs",
    "approval_queue_items",
  ])
    await prisma.$executeRawUnsafe(`ANALYZE ${table}`);
  const [stats] = await prisma.$queryRawUnsafe<
    { convs: number; days: number; ledger: number; logs: number }[]
  >(`
    SELECT (SELECT COUNT(*)::int FROM conversations WHERE tenant_id = ${t}) AS convs,
           (SELECT COUNT(DISTINCT created_at::date)::int FROM conversations WHERE tenant_id = ${t}) AS days,
           (SELECT COUNT(*)::int FROM llm_usage WHERE tenant_id = ${t}) AS ledger,
           (SELECT COUNT(*)::int FROM execution_logs WHERE tenant_id = ${t}) AS logs`);
  console.log(
    JSON.stringify(
      {
        tenantId: String(t),
        email: EMAIL,
        password: PASSWORD,
        ...stats,
        perDay: stats ? Math.round(stats.convs / stats.days) : null,
        webhook: {
          routeToken: ROUTE_TOKEN,
          secret: SECRET,
          chatwootInboxId: 1,
        },
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
