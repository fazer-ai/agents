-- WHAT THE SIBLING DELIVERY'S ROUTE DOES WITH A MESSAGE IT DOES NOT ANSWER (issue #540, window 3).
-- An observer beside a responder stands down because the responder's OWN delivery of the same
-- message folds it into memory, and that was decided by reading the responder's mode at the moment
-- the observer asked -- not by what the responder's delivery actually resolved. A switch flipped
-- between two concurrent deliveries of one message therefore silences the observer about a message
-- nothing recorded, or has it repeat one that was.
--
-- Nullable, and never backfilled: a row written before this column says nothing about its route, and
-- a reader that meets a null falls back to the mode reading every delivery used to make.
ALTER TABLE "chatwoot_webhook_deliveries"
  ADD COLUMN "route_remembers" BOOLEAN;
