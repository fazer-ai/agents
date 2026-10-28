-- Passkeys (WebAuthn): the credentials, their registration challenges and the spent sign-in
-- challenges. Global identity tables like users: no tenant, no RLS.

-- CreateEnum
CREATE TYPE "WebauthnChallengeType" AS ENUM ('REGISTRATION', 'CONDITIONAL_REGISTRATION');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "passkey_prompt_dismiss_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "passkey_prompt_dismissed_at" TIMESTAMP(3),
ADD COLUMN     "webauthn_user_handle" TEXT;

-- CreateTable
CREATE TABLE "passkeys" (
    "id" TEXT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "public_key" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "device_type" TEXT NOT NULL,
    "backed_up" BOOLEAN NOT NULL,
    "name" TEXT,
    "provider" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "passkeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webauthn_challenges" (
    "id" TEXT NOT NULL,
    "type" "WebauthnChallengeType" NOT NULL,
    "challenge" TEXT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webauthn_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webauthn_consumed_challenges" (
    "challenge_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webauthn_consumed_challenges_pkey" PRIMARY KEY ("challenge_hash")
);

-- CreateIndex
CREATE INDEX "passkeys_user_id_idx" ON "passkeys"("user_id");

-- CreateIndex
CREATE INDEX "webauthn_challenges_expires_at_idx" ON "webauthn_challenges"("expires_at");

-- CreateIndex
CREATE INDEX "webauthn_consumed_challenges_expires_at_idx" ON "webauthn_consumed_challenges"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "users_webauthn_user_handle_key" ON "users"("webauthn_user_handle");

-- AddForeignKey
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

