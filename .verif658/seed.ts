// Verificador #658 — semeia o tenant/instancia/agente/inbox usado por todos os cenarios.
// Roda com as URLs do banco de TESTE da worktree ja no env (ver run.sh).
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { seedChatwootInstance } from "@/tests/utils/chatwoot";

const suUrl = process.env.MIGRATION_DATABASE_URL as string;
const su = new PrismaClient({ adapter: new PrismaPg({ connectionString: suUrl }) });

const slug = `v658-${Date.now()}`;
const t = await su.tenant.create({ data: { name: "V658", slug } });
const tenantId = t.id;
const inst = await seedChatwootInstance(su, {
  tenantId,
  accountId: 9,
  baseUrl: `https://chat.v658-${Date.now()}.example.com`,
  adminToken: encryptJson("ADMIN"),
});
const instanceId = inst.id;
const llmKey = await su.vaultEntry.create({
  data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
  select: { id: true },
});
const debounceOff = process.env.SEED_DEBOUNCE_OFF === "1";
const agent = await su.agent.create({
  data: {
    tenantId,
    name: "Atendente",
    systemPrompt: "Você é uma secretária prestativa.",
    modelConfig: {
      provider: "openai",
      model: "gpt-4o-mini",
      credentialRef: `vault:${llmKey.id}`,
    },
    settings: debounceOff
      ? { split: { enabled: false }, debounce: { enabled: false } }
      : { split: { enabled: false } },
  },
});
await su.chatwootAgentBot.create({
  data: {
    tenantId,
    chatwootInstanceId: instanceId,
    agentId: agent.id,
    chatwootAgentBotId: 9,
    accessToken: encryptJson("BOT"),
    webhookSecret: encryptJson("S"),
    webhookRouteTokenHash: `v658-route-${slug}`,
    name: "Atendente",
  },
});
await su.inbox.create({
  data: {
    tenantId,
    chatwootInstanceId: instanceId,
    chatwootInboxId: 7,
    name: "Suporte",
    agentId: agent.id,
  },
});

// Conversas pedidas pelo cenario, no formato conv:contactInboxId (contactInboxId vazio = NULO).
const convSpecs = (process.env.SEED_CONVS ?? "").split(",").filter(Boolean);
for (const spec of convSpecs) {
  const [convRaw, ciRaw] = spec.split(":");
  const convId = Number(convRaw);
  const ci = ciRaw ? Number(ciRaw) : null;
  let contactId: bigint | null = null;
  if (ci !== null) {
    const existing = await su.contact.findFirst({
      where: { tenantId, chatwootInstanceId: instanceId, chatwootContactId: 880000 + ci },
      select: { id: true },
    });
    contactId =
      existing?.id ??
      (
        await su.contact.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootContactId: 880000 + ci,
            name: "C",
          },
          select: { id: true },
        })
      ).id;
  }
  await su.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      ...(ci !== null ? { contactInboxId: ci, contactId } : {}),
      status: "pending",
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(),
    },
  });
}

console.log(
  JSON.stringify({ tenantId: String(tenantId), instanceId: String(instanceId), slug }),
);
await su.$disconnect();
