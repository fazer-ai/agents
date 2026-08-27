-- What an operator-authored HTTP tool declares about the appointment its response describes
-- (issue #352). Nullable and defaulted to nothing: every existing tool declares nothing, which is
-- exactly what they do today.
--
-- DDL only. There is nothing to backfill — a tool that never carried this column never registered an
-- appointment, and inventing a declaration for it would start writing records from a response shape
-- nobody has stated.
ALTER TABLE "tool_definitions" ADD COLUMN "appointment" JSONB;
