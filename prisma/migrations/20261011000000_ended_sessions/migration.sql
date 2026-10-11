-- Sessions that logged out, named by their token's jti until that token expires. A global identity
-- table like users: no tenant, no RLS.
CREATE TABLE "ended_sessions" (
    "jti" TEXT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replaced" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ended_sessions_pkey" PRIMARY KEY ("jti")
);

CREATE INDEX "ended_sessions_user_id_idx" ON "ended_sessions"("user_id");

CREATE INDEX "ended_sessions_expires_at_idx" ON "ended_sessions"("expires_at");

ALTER TABLE "ended_sessions" ADD CONSTRAINT "ended_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
