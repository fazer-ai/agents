-- HTTP statuses a tool declares as results rather than integration failures (issue #59).
-- Empty default keeps the existing behavior, where every non-2xx is logged warn and alerts.
ALTER TABLE "tool_definitions" ADD COLUMN "expected_statuses" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
