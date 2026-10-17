import { trackSocket } from "@/api/features/realtime/realtime.service";
import { isSessionLoggedOut } from "@/api/lib/auth";
import { WS_CLOSE } from "@/api/lib/realtime";
import { ServiceUnavailableError } from "@/lib/errors";

// Registers a just-upgraded socket for revocation FIRST, then re-reads its session. The upgrade
// authenticated earlier, and a password change landing in between would sweep before this socket
// existed; in this order either the sweep closes it or the re-check refuses it. True when the
// session still holds; otherwise the socket is already closed (1011 on a transient DB failure, so
// the client retries).
export async function registerAndRecheck(
  ws: {
    id: unknown;
    raw: { close(code?: number, reason?: string): void };
    close(code?: number, reason?: string): void;
    data: { getAuthUser(): Promise<unknown> };
  },
  user: { id: bigint; sessionId?: string },
): Promise<boolean> {
  trackSocket(user.id, String(ws.id), ws.raw, user.sessionId);
  let current: unknown;
  try {
    current = await ws.data.getAuthUser();
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      ws.close(WS_CLOSE.INTERNAL_ERROR, "retry");
      return false;
    }
    current = null;
  }
  if (!current) {
    // A logout signs the tab out (4401); a password change asks it to reconnect under the
    // re-issued cookie (4409), which the tab holding that cookie can.
    const loggedOut =
      user.sessionId !== undefined &&
      (await isSessionLoggedOut(user.sessionId).catch(() => false));
    if (loggedOut) ws.close(WS_CLOSE.UNAUTHORIZED, "session ended");
    else ws.close(WS_CLOSE.CREDENTIALS_CHANGED, "session revoked");
    return false;
  }
  return true;
}
