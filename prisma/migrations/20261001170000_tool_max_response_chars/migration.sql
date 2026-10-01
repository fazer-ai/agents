-- An HTTP tool's own ceiling on what the model receives (issue #1016). Nullable and without a default:
-- every existing row reads NULL, which is the 4000 the runtime has always used.
ALTER TABLE "tool_definitions" ADD COLUMN "max_response_chars" INTEGER;
