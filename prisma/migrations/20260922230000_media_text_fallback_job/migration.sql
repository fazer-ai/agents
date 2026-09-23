-- A reply whose attachment the channel rejected is sent again as text, once (issue #587). Add-value
-- only: the value is first used by application code, never by this file.
ALTER TYPE "SchedulerJobKind" ADD VALUE 'MEDIA_TEXT_FALLBACK';
