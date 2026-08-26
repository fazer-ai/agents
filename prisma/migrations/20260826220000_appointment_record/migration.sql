-- The platform's record that a commitment exists in a conversation, split out of the reminder jobs
-- that used to double as it (issue #376).
--
-- Before this, "is there an appointment?" was answered by "is an APPOINTMENT_REMINDER row live?".
-- A job is written because something has to be SENT; a record has to exist because something has to
-- be KNOWN, and conflating them made the record inherit every reason a job might legitimately not be
-- written — reminders switched off for the integration, or a booking sooner than the smallest
-- configured offset. In both cases `followUp.pauseWhileAppointment` was silently inert.

-- CreateTable
CREATE TABLE "appointments" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    -- The instant every decision reads. `start_iso` is the string the customer is told out loud,
    -- kept verbatim with whatever offset it arrived with.
    "start_at" TIMESTAMP(3) NOT NULL,
    "start_iso" TEXT NOT NULL,
    "summary" TEXT,
    "calendar_id" TEXT,
    "calendar_label" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "appointments_tenant_id_external_id_key" ON "appointments"("tenant_id", "external_id");

-- CreateIndex
CREATE INDEX "appointments_tenant_id_thread_id_idx" ON "appointments"("tenant_id", "thread_id");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: same tenant fence every tenant-scoped table carries (see 20260727000000_init).
ALTER TABLE "appointments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointments" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "appointments"
  USING (
    current_setting('app.is_super_admin', true) = 'on'
    OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'on'
    OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint
  );

-- Backfill: every appointment that is live RIGHT NOW exists only as a scheduler payload, so without
-- this every currently-booked appointment stops pausing follow-ups the moment this deploys.
--
-- Plain SET, never SET LOCAL: `appointments` carries FORCE ROW LEVEL SECURITY, so `tenant_isolation`
-- binds the table OWNER too, and MIGRATION_DATABASE_URL is only promised to be "superuser OR owner"
-- (docs/deploy.md). On managed Postgres the admin role is typically the owner without rolsuper, and
-- there an unguarded cross-tenant INSERT is refused. Outside a transaction SET LOCAL is a no-op with
-- only a warning, which is the same silent failure wearing the right words.
SET app.is_super_admin = 'on';

-- The freshest surviving arm per (tenant, event) wins, exactly as projectAppointmentEvents picked a
-- winner by updated_at. Tombstoned rows are skipped: a cancelled appointment is not live, and a
-- record that does not exist reads the same way to every reader.
--
-- The normalization is the one the sweep and parseStartMs already share (all-day dates become UTC
-- midnight; offset-less datetimes get a 'Z'). ONE guarded cast, in the LATERAL, feeding both the
-- filter and the inserted value: `pg_input_is_valid` decides inside a CASE, and an unreadable start
-- comes out NULL instead of raising. An `AND pg_input_is_valid(...) AND x::timestamptz > now()`
-- would not be safe, because Postgres does not promise to evaluate WHERE conjuncts left to right and
-- the cast could run first and abort the WHOLE migration on one bad row. A startISO can have reached
-- a payload from the model's own tool input, so bad rows are exactly what this expects to find; the
-- sweep's own SQL used the CASE form for the same reason.
--
-- Only future starts are carried over: a past appointment has no reader, since liveness is
-- `cancelled_at IS NULL AND start_at > now`.
INSERT INTO "appointments" (
  "tenant_id", "thread_id", "external_id", "start_at", "start_iso",
  "summary", "calendar_id", "calendar_label", "created_at", "updated_at"
)
SELECT DISTINCT ON (sj."tenant_id", sj."payload"->>'eventId')
       sj."tenant_id",
       sj."payload"->>'threadId',
       sj."payload"->>'eventId',
       norm.start_at,
       sj."payload"->>'startISO',
       nullif(sj."payload"->>'summary', ''),
       nullif(sj."payload"->>'calendarId', ''),
       nullif(sj."payload"->>'calendarLabel', ''),
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
  FROM "scheduler_jobs" sj
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN sj."payload"->>'startISO' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        THEN sj."payload"->>'startISO' || 'T00:00:00Z'
      WHEN sj."payload"->>'startISO' ~ '[Tt ][0-9]{2}:'
           AND sj."payload"->>'startISO' !~ '([Zz]|[+-][0-9]{2}:?[0-9]{2})$'
        THEN sj."payload"->>'startISO' || 'Z'
      ELSE sj."payload"->>'startISO'
    END AS start_iso
  ) raw
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN raw.start_iso IS NOT NULL
           AND pg_input_is_valid(raw.start_iso, 'timestamptz')
        THEN raw.start_iso::timestamptz AT TIME ZONE 'UTC'
      ELSE NULL
    END AS start_at
  ) norm
 WHERE sj."kind" = 'APPOINTMENT_REMINDER'
   AND sj."payload"->>'cancelledAt' IS NULL
   AND sj."payload"->>'eventId' IS NOT NULL
   AND sj."payload"->>'threadId' IS NOT NULL
   AND norm.start_at IS NOT NULL
   AND norm.start_at > (now() AT TIME ZONE 'UTC')
 ORDER BY sj."tenant_id", sj."payload"->>'eventId', sj."updated_at" DESC
ON CONFLICT ("tenant_id", "external_id") DO NOTHING;

RESET app.is_super_admin;
