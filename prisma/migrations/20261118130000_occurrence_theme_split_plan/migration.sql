-- A split decided for a large theme and not finished in its round (docs/occurrences.md, "Themes"): its
-- parts, its reason and the sentences already placed, so the next round asks only the rest and the
-- split stays one move of the members. Null when no split is pending.
ALTER TABLE "occurrence_themes" ADD COLUMN "split_plan" JSONB;
