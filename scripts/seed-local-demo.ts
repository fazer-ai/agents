#!/usr/bin/env bun

import { PrismaPg } from "@prisma/adapter-pg";
import { encryptJson } from "@/api/lib/crypto";
// Local-only demo seed (NOT for prod): a tenant + TENANT_ADMIN + one conversation whose activity
// trail has a successful tool AND a FAILED tool, so the operator console renders the tool-error
// marker (the feature in fix(conversations): surface tool-call errors). Connects via the superuser
// URL to bypass RLS while writing explicit tenant_id rows (same approach as set-admin).
import { emailEquals } from "@/lib/email-match";
import { PrismaClient } from "../generated/prisma/client";

const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("MIGRATION_DATABASE_URL (or DATABASE_URL) required");
  process.exit(1);
}
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url }),
});

const EMAIL = "admin@fazer.ai";
const PASSWORD = "demo12345";

async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: "local-demo" },
    update: {},
    create: { name: "Clínica Demo (local)", slug: "local-demo" },
  });

  const passwordHash = await Bun.password.hash(PASSWORD, {
    algorithm: "bcrypt",
    cost: 10,
  });
  const existing = await prisma.user.findFirst({
    where: { email: emailEquals(EMAIL) },
    select: { id: true },
  });
  const person = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: { passwordHash },
        select: { id: true },
      })
    : await prisma.user.create({
        data: { email: EMAIL, passwordHash, name: "Admin Demo" },
        select: { id: true },
      });
  await prisma.tenantUser.upsert({
    where: { tenantId_userId: { tenantId: tenant.id, userId: person.id } },
    update: { role: "TENANT_ADMIN" },
    create: { tenantId: tenant.id, userId: person.id, role: "TENANT_ADMIN" },
  });

  const deployment = await prisma.chatwootDeployment.upsert({
    where: { tenantId: tenant.id },
    update: {},
    create: {
      tenantId: tenant.id,
      baseUrl: "http://chatwoot.local",
      adminToken: encryptJson("local-demo-dummy-token"),
    },
  });

  const instance = await prisma.chatwootInstance.upsert({
    where: { tenantId_accountId: { tenantId: tenant.id, accountId: 1 } },
    update: {},
    create: {
      tenantId: tenant.id,
      deploymentId: deployment.id,
      accountId: 1,
      serverKey: "local-demo-server",
      accountName: "Clínica Demo",
    },
  });

  let conv = await prisma.conversation.findFirst({
    where: {
      tenantId: tenant.id,
      chatwootInstanceId: instance.id,
      chatwootConversationId: 1001,
    },
  });
  if (!conv) {
    conv = await prisma.conversation.create({
      data: {
        tenantId: tenant.id,
        chatwootInstanceId: instance.id,
        chatwootConversationId: 1001,
        contactInboxId: 1,
        status: "open",
        assigneeType: "AgentBot",
        threadId: `${tenant.id}:${instance.id}:1001`,
        lastEventAt: new Date(),
        lastInboundAt: new Date(),
      },
    });
  }

  // Idempotent: re-running replaces the demo turn's rows.
  await prisma.executionLog.deleteMany({
    where: {
      tenantId: tenant.id,
      conversationId: conv.id,
      turnId: "turn-demo-1",
    },
  });
  const common = {
    tenantId: tenant.id,
    conversationId: conv.id,
    turnId: "turn-demo-1",
    source: "inbox",
    threadId: conv.threadId,
  };
  await prisma.executionLog.create({
    data: {
      ...common,
      stage: "tool",
      level: "info",
      status: "ok",
      durationMs: 240,
      detail: {
        tool: "search_knowledge",
        args: { query: "horário de funcionamento" },
        output: "A clínica atende de segunda a sexta, das 8h às 18h.",
      },
    },
  });
  await prisma.executionLog.create({
    data: {
      ...common,
      stage: "tool",
      level: "warn",
      status: "error",
      durationMs: 1530,
      detail: {
        tool: "check_calendar_availability",
        args: { date: "2026-07-01", period: "manhã" },
      },
      errorMessage:
        "Google Calendar API: 401 invalid_grant — credential expired or revoked. Re-link the calendar integration.",
    },
  });

  console.log(
    JSON.stringify(
      {
        tenantId: String(tenant.id),
        conversationId: String(conv.id),
        email: EMAIL,
        password: PASSWORD,
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
