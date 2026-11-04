-- AlterTable
ALTER TABLE "chatwoot_deployments" ADD COLUMN "server_key" TEXT,
ADD COLUMN "former_base_urls" TEXT[] DEFAULT ARRAY[]::TEXT[];
