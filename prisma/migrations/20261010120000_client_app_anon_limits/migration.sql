-- What an anonymous visitor of an embedding app may cost: new sessions one address opens per hour,
-- and messages one session sends per minute. Defaults on every existing app. Additive: the previous
-- release ignores the columns.
ALTER TABLE "client_apps" ADD COLUMN "anon_sessions_per_hour" INTEGER NOT NULL DEFAULT 20;
ALTER TABLE "client_apps" ADD COLUMN "anon_messages_per_min" INTEGER NOT NULL DEFAULT 10;
