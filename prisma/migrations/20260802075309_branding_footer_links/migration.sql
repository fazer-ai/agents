-- AlterTable
ALTER TABLE "app_branding" ADD COLUMN     "hide_github_link" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "site_url" TEXT,
ADD COLUMN     "support_email" TEXT;
