-- Retired in #137 (code stopped reading it), un-named in every query shape by #176 (`@ignore`),
-- shipped that way in v1.10.0. Dropping it now means rollback is supported down to v1.10.0 and not
-- past it (issue #149).
ALTER TABLE "tool_definitions" DROP COLUMN "risk_tier";
