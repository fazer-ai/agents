-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "custom_attributes" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "custom_attributes" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "kanban_attributes" JSONB NOT NULL DEFAULT '{}';
