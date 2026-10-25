-- A flagged theme that missed every rule keeps its flags for the monitor's hold (docs/occurrences.md,
-- "Flags"): the first round it missed them, null while a rule is met or the theme is not flagged.
ALTER TABLE "occurrence_themes" ADD COLUMN "flag_unmet_since" TIMESTAMP(3);
