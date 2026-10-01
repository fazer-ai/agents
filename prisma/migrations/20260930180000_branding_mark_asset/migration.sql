-- The square symbol the collapsed sidebar shows in place of the logo, one file per theme like the logo and the favicon.
ALTER TABLE "app_branding" ADD COLUMN "mark_dark_key" TEXT,
ADD COLUMN "mark_light_key" TEXT;
