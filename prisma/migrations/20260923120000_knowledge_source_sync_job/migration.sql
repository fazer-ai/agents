-- A knowledge base can mirror a help center portal (issue #794). Add-value only: the value is first
-- used by application code, never by this file.
ALTER TYPE "SchedulerJobKind" ADD VALUE 'KNOWLEDGE_SOURCE_SYNC';
