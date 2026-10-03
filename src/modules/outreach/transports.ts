import type {
  OutreachAccount,
  OutreachJob,
} from "@/../generated/prisma/client";
import config from "@/config";
import { AppError } from "@/lib/errors";
import { fetchBounded } from "@/lib/outbound";
import { sanitizeErrorMessage } from "@/lib/redact";
import { clipText } from "@/lib/text";
import type { OutreachTransport } from "./shared";

// Transports turn an approved job into an actual touch. The interface is kept
// deliberately small: the worker reserves the account's rate-limit slot and
// resolves the credential BEFORE calling in (so no transaction spans the
// network), hands the transport everything it needs, and finalizes on the
// result. Transports never see a ScopedDb and never write job rows.

export interface OutreachSendInput {
  account: Pick<
    OutreachAccount,
    "id" | "platform" | "handle" | "transport" | "credentialRef"
  >;
  job: Pick<OutreachJob, "id" | "kind" | "body">;
  lead: {
    authorName: string;
    authorHandle: string | null;
    sourceUrl: string | null;
  };
  // The resolved vault value for account.credentialRef (whatever JSON shape the
  // entry holds), or null when the account carries no credential.
  credential: unknown;
  fetchImpl?: typeof fetch;
}

// What the send attempt produced. `sent` = it left through the transport;
// `ready_for_manual` = the account's transport is `manual`, no send happened,
// the operator performs it and confirms via mark-sent.
export type OutreachSendOutcome = "sent" | "ready_for_manual";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ERROR_LEN = 500;

// The vault shape a zca_bridge credential is expected to carry: a JSON object
// with the bridge's shared token and optionally a per-account baseUrl override.
// A bare string secret is read as the token alone.
function credentialParts(credential: unknown): {
  token: string | null;
  baseUrl: string | null;
} {
  if (typeof credential === "string" && credential.trim() !== "") {
    return { token: credential, baseUrl: null };
  }
  if (credential && typeof credential === "object") {
    const bag = credential as Record<string, unknown>;
    return {
      token: typeof bag.token === "string" ? bag.token : null,
      baseUrl: typeof bag.baseUrl === "string" ? bag.baseUrl : null,
    };
  }
  return { token: null, baseUrl: null };
}

// `manual`: nothing goes out on the wire. The job becomes READY_FOR_MANUAL and
// the rate-limit slot the worker already reserved stays consumed - the account
// budget was spent the moment this send was handed to a human.
function sendManual(): OutreachSendOutcome {
  return "ready_for_manual";
}

// `zca_bridge`: POST the send to the zca-bridge sidecar (an operator-run service holding
// the real Zalo account session). The bridge URL is deployment config
// (config.outreach.zcaBridgeUrl, default localhost:4001) unless the account's credential
// names a per-account override. The body names the job, the sending account and the
// recipient, and nothing else - the bridge owns session state, we own the audit trail.
// A thrown error means retryable (network, timeout, non-2xx); the worker applies its
// attempt budget, so the bridge being down never gives up the job.
async function sendZcaBridge(input: OutreachSendInput): Promise<"sent"> {
  const { token, baseUrl } = credentialParts(input.credential);
  const root = (baseUrl ?? config.outreach.zcaBridgeUrl).replace(/\/+$/, "");
  if (root === "") {
    throw new AppError(
      "zca bridge is not configured (set ZCA_BRIDGE_URL or a credential baseUrl)",
      502,
    );
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const { res, body } = await fetchBounded(
    `${root}/send`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        account: {
          platform: input.account.platform,
          handle: input.account.handle,
        },
        kind: input.job.kind,
        body: input.job.body,
        target: {
          name: input.lead.authorName,
          handle: input.lead.authorHandle,
          sourceUrl: input.lead.sourceUrl,
        },
        // The bridge dedupes retries on this, so an attempt that lands but whose
        // response we lost cannot double-send when the job retries.
        dedupeKey: `job:${String(input.job.id)}`,
      }),
      redirect: "error",
    },
    { timeoutMs: REQUEST_TIMEOUT_MS, fetchImpl: input.fetchImpl },
  );
  if (!res.ok) {
    throw new Error(
      `zca bridge answered ${res.status}: ${sanitizeErrorMessage(clipText(body.text, 200), MAX_ERROR_LEN)}`,
    );
  }
  return "sent";
}

export async function sendOutreach(
  input: OutreachSendInput,
): Promise<OutreachSendOutcome> {
  switch (input.account.transport as OutreachTransport) {
    case "manual":
      return sendManual();
    case "zca_bridge":
      return sendZcaBridge(input);
    default:
      // A transport name that slipped past validation (schema change, manual
      // SQL): fail the job loudly rather than pretending a send happened.
      throw new AppError(
        `unsupported outreach transport "${input.account.transport}"`,
        422,
      );
  }
}
