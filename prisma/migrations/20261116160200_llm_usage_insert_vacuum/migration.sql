-- THE INDEX-ONLY READ OF THE MONTH'S COST NEEDS THE VISIBILITY MAP TO KEEP UP WITH THE APPENDS.
-- `llm_usage` is append-mostly, so autovacuum visits it only on its insert trigger, which by default
-- waits for 1000 + 20% of the table, which on a busy ledger is days of writes. Every row written
-- since lives on a page not yet marked all-visible, and the index-only scan of 20261116160000 fetches
-- the heap for each of them: measured on a busy production ledger, the rows written since its last
-- pass cost 140k buffers through the index, close to half of what the poll paid before the index.
--
-- A fixed trigger of 10k inserts, whatever the table's size, bounds those fetches to the last 10k
-- rows: measured on a 1.4M-row copy, 10k unvisited rows cost the poll 4.6k buffers, the same order
-- as right after a VACUUM. An insert-triggered pass reads only the pages not yet all-visible.
ALTER TABLE "llm_usage" SET (
    autovacuum_vacuum_insert_threshold = 10000,
    autovacuum_vacuum_insert_scale_factor = 0
);
