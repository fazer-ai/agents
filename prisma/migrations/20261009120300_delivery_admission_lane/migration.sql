-- THE LANE OF A STORED DELIVERY, BESIDE ITS BODY (issue #1199). The drain admits stored rows into two
-- lanes, customer messages and everything else, and the lane was read from the encrypted body after
-- the row was fetched. With the customer-message lane full, a backlog of those rows filled every page
-- the drain read, and a status or assignment change stored behind them waited for the backlog to
-- shrink. The ack now writes the lane, and the drain reads only the rows of a lane with room.
--
-- Nullable with no default: a catalog change, no rewrite. A row an older build wrote has no body and
-- is never drained; a null lane on a row that has one reads as a customer message's.
ALTER TABLE "chatwoot_webhook_deliveries" ADD COLUMN "admission_lane" TEXT;
