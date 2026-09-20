-- CreateIndex
CREATE INDEX "conversations_tenant_id_chatwoot_instance_id_contact_inbox__idx" ON "conversations"("tenant_id", "chatwoot_instance_id", "contact_inbox_id");
