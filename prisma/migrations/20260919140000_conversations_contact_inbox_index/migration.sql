-- CreateIndex
-- CONCURRENTLY porque `conversations` é tabela quente e o `migrate deploy` roda no contêiner NOVO
-- com o VELHO ainda servindo (docs/deploy.md): o build comum toma SHARE, que conflita com o
-- ROW EXCLUSIVE de cada escrita do espelho, e o receptor pararia durante o build inteiro.
-- O DROP antes é o que impede um build interrompido de deixar um índice `indisvalid = false`, que o
-- Postgres recusa usar em silêncio (.claude/rules/prisma.md).
DROP INDEX IF EXISTS "conversations_tenant_id_chatwoot_instance_id_contact_inbox__idx";
CREATE INDEX CONCURRENTLY "conversations_tenant_id_chatwoot_instance_id_contact_inbox__idx" ON "conversations"("tenant_id", "chatwoot_instance_id", "contact_inbox_id");
