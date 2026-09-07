-- The SHAPE of a sample response the operator pasted in the tool editor, so the path pickers and the
-- caret completion survive a reopen (issue #566). Never the response itself: every value is replaced
-- by a stand-in of the same type before it is written, on the client AND again in the service, so
-- this column holds no third party's data by construction.
ALTER TABLE "tool_definitions" ADD COLUMN "sample_shape" JSONB;
