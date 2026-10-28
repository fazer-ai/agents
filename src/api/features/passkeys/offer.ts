import type { SessionSignIn } from "@/api/lib/auth";
import prisma from "@/api/lib/prisma";

// Every number behind the passkey offer after a password sign-in. The cooldown and the cap are vendor
// guidance (Corbado: about 30 days, at most three tries), not research; tune them here.
export const PASSKEY_OFFER = {
  // A password or Google sign-in this recent stands in for the proof registering a passkey asks for,
  // so the offer right after a login does not ask for the password the person just typed.
  freshSignInMs: 5 * 60 * 1000,
  cooldownMs: 30 * 24 * 60 * 60 * 1000,
  maxDismissals: 3,
} as const;

// Whether a recent sign-in stands in for the proof registering a passkey asks for. A passkey sign-in
// proves the device, not the account's credential, so it never does: a stolen unlocked phone would
// otherwise plant a second passkey with nothing typed. A token minted without a method never does
// either (a password change re-signs the cookie without being a sign-in).
export function recentSignInProves(
  signIn: SessionSignIn | undefined,
  now = new Date(),
): boolean {
  if (!signIn || signIn.method === "passkey") return false;
  const age = now.getTime() - signIn.at.getTime();
  return age >= 0 && age <= PASSKEY_OFFER.freshSignInMs;
}

// When the offer stands, until when: the end of the recent sign-in window, after which "Create
// passkey" would need the password again, so the card goes away with it. Offered only right after a
// password sign-in, to an account with no passkey, outside the cooldown and under the cap.
export async function passkeyOfferWindow(
  userId: bigint,
  signIn: SessionSignIn | undefined,
  now = new Date(),
): Promise<Date | null> {
  if (signIn?.method !== "password" || !recentSignInProves(signIn, now)) {
    return null;
  }
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      passkeyPromptDismissedAt: true,
      passkeyPromptDismissCount: true,
      _count: { select: { passkeys: true } },
    },
  });
  if (!row || row._count.passkeys > 0) return null;
  if (row.passkeyPromptDismissCount >= PASSKEY_OFFER.maxDismissals) return null;
  const last = row.passkeyPromptDismissedAt;
  if (last && now.getTime() - last.getTime() <= PASSKEY_OFFER.cooldownMs) {
    return null;
  }
  return new Date(signIn.at.getTime() + PASSKEY_OFFER.freshSignInMs);
}

// One refusal per cooldown. A retry after a lost response, or the same offer declined in two tabs,
// lands inside the cooldown and changes nothing, so it cannot spend the cap; the conditional write
// keeps two concurrent requests from both counting.
export async function dismissPasskeyOffer(userId: bigint, now = new Date()) {
  await prisma.user.updateMany({
    where: {
      id: userId,
      OR: [
        { passkeyPromptDismissedAt: null },
        {
          passkeyPromptDismissedAt: {
            lt: new Date(now.getTime() - PASSKEY_OFFER.cooldownMs),
          },
        },
      ],
    },
    data: {
      passkeyPromptDismissedAt: now,
      passkeyPromptDismissCount: { increment: 1 },
    },
  });
}
