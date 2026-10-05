-- A per-tool switch that writes an expected response clip at info instead of paging at warn (issue #1044).
-- Off for every existing row: a tool keeps alerting until the operator turns it on.
ALTER TABLE "tool_definitions" ADD COLUMN "silence_truncation_alert" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "code_tool_definitions" ADD COLUMN "silence_truncation_alert" BOOLEAN NOT NULL DEFAULT false;
