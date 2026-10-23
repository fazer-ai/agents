-- The occurrence monitor's roles are renamed and its four step models become one (docs/occurrences.md):
-- `subjectField` is now `referenceField`, `problemField` is now `reasonField`, and `models` (one per
-- step) is now `model`, the reading's. The field keys themselves are unchanged, so the readings and
-- themes stored under them keep counting. A block without the old keys is left alone, so running this
-- twice changes nothing the second time. A saved dashboard panel's `subjects` view is now `references`.
-- A value already under the new name wins, unless it is a JSON null. Prisma runs the file outside a
-- transaction, so it opens its own: FORCE is restored even if a statement fails (docs/deploy.md).

BEGIN;

ALTER TABLE "tenants" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "dashboard_panels" NO FORCE ROW LEVEL SECURITY;

UPDATE "tenants"
   SET "settings" = jsonb_set(
         "settings",
         '{occurrences}',
         (("settings" -> 'occurrences') - 'subjectField' - 'problemField' - 'models')
           || jsonb_build_object(
                'referenceField',
                COALESCE(
                  NULLIF("settings" -> 'occurrences' -> 'referenceField', 'null'::jsonb),
                  NULLIF("settings" -> 'occurrences' -> 'subjectField', 'null'::jsonb),
                  'null'::jsonb),
                'reasonField',
                COALESCE(
                  NULLIF("settings" -> 'occurrences' -> 'reasonField', 'null'::jsonb),
                  NULLIF("settings" -> 'occurrences' -> 'problemField', 'null'::jsonb),
                  'null'::jsonb),
                'model',
                COALESCE(
                  NULLIF("settings" -> 'occurrences' -> 'model', 'null'::jsonb),
                  NULLIF("settings" -> 'occurrences' -> 'models' -> 'reading', 'null'::jsonb),
                  'null'::jsonb)))
 WHERE jsonb_typeof("settings" -> 'occurrences') = 'object'
   AND ("settings" -> 'occurrences') ?| ARRAY['subjectField', 'problemField', 'models'];

UPDATE "dashboard_panels"
   SET "query" = jsonb_set("query", '{view}', '"references"'::jsonb)
 WHERE "query" ->> 'source' = 'occurrences'
   AND "query" ->> 'view' = 'subjects';

ALTER TABLE "dashboard_panels" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;

COMMIT;
