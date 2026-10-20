-- Whether a usage row or a log line belongs to an anonymous visitor's session on the client channel
-- (issue #237): the source stays "client", so the tenant's client ceiling covers both, and this tells
-- the two apart in the Logs and on the dashboard. Written by the turn, never derived later, so a
-- conversation that passes to a signed-in user keeps what its anonymous turns were. A constant
-- default, so adding it does not rewrite either table.
ALTER TABLE "llm_usage" ADD COLUMN "anonymous" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "execution_logs" ADD COLUMN "anonymous" BOOLEAN NOT NULL DEFAULT false;
