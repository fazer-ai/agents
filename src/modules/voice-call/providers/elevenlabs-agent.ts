// The agent on the customer's ElevenLabs account that carries an agent's calls. The agents console is
// where it is configured: this creates it on first use and keeps it in step with `settings.calls`,
// and nothing about it is meant to be edited on the ElevenLabs dashboard (a later sync overwrites
// it). The prompt, the greeting and the language are not stored there: they go with each call, as
// overrides the agent is created to allow. The tools are declared per call (./elevenlabs-tools.ts).

import { createHash } from "node:crypto";
import { clipText } from "@/lib/text";
import type { CallsConfig } from "../settings";
import { type ConfigDigests, dbConfigDigests } from "./config-digests";
import {
  CONFIG_HOLD_LEASE_MS,
  CONFIG_HOLD_WAIT_MS,
  dbEngineHold,
  type HoldEngineAgent,
} from "./engine-hold";

const API = "https://api.elevenlabs.io";

export interface ElevenLabsAgentSpec {
  name: string;
  /** The agent's own prompt. Each call replaces it with the prompt it builds (the conversation's
   *  history included); stored here so the agent on the account reads as the one configured. */
  prompt: string;
  voice: string;
  calls: CallsConfig;
}

/** The agent's settings as ElevenLabs reads them; only what the console configures, plus the call's audio format. */
export function elevenLabsAgentConfig(spec: ElevenLabsAgentSpec) {
  const { calls } = spec;
  return {
    name: spec.name,
    conversation_config: {
      asr: {
        user_input_audio_format: "pcm_16000",
        provider: calls.asrModel,
        quality: "high",
        keywords: calls.keywords,
      },
      tts: {
        agent_output_audio_format: "pcm_16000",
        voice_id: spec.voice,
        model_id: calls.ttsModel,
        speed: calls.speed,
      },
      turn: {
        turn_eagerness: calls.turnEagerness,
        silence_end_call_timeout: calls.silenceEndCallSecs ?? -1,
      },
      conversation: {
        max_duration_seconds: calls.maxDurationSecs,
        // Off is spelled with nulls: leaving the object out keeps whatever was there.
        background_sound: {
          source_type: calls.backgroundSound ? "preset" : null,
          source_id: calls.backgroundSound,
          volume: calls.backgroundVolume,
          crossfade_loop: true,
        },
      },
      agent: {
        language: "pt",
        first_message: "",
        prompt: { prompt: spec.prompt, llm: calls.llm },
      },
    },
    platform_settings: {
      // The call's note on Chatwoot is this summary; inferred, it comes back in English.
      summary_language: "pt",
      overrides: {
        conversation_config_override: {
          agent: {
            prompt: { prompt: true },
            first_message: true,
            language: true,
          },
        },
      },
    },
  };
}

export type AccessCheck =
  | { ok: true }
  | {
      ok: false;
      reason: "invalid_key" | "missing_permission" | "unreachable";
      detail: string;
    };

/** What ElevenLabs says in a refusal, without the JSON around it: `detail.message`, or `detail`. */
export function refusalText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    const detail = parsed.detail;
    if (typeof detail === "string") return clipText(detail, 300);
    if (detail && typeof detail === "object") {
      const message = (detail as { message?: unknown }).message;
      if (typeof message === "string") return clipText(message, 300);
    }
  } catch {
    // Not JSON: the body as it came.
  }
  return clipText(body, 300);
}

/** The key's problem a 401 names, whichever request it answered. */
function keyRefusal(
  status: number,
  body: string,
): "invalid_key" | "missing_permission" | null {
  if (status !== 401) return null;
  return /permission|missing_permissions/i.test(body)
    ? "missing_permission"
    : "invalid_key";
}

/** A request ElevenLabs answered with a refusal; `keyProblem` when the refusal is the key's. */
export class ElevenLabsRefusal extends Error {
  constructor(
    what: string,
    readonly status: number,
    readonly text: string,
    readonly keyProblem: "invalid_key" | "missing_permission" | null,
  ) {
    super(`elevenlabs: ${what} failed with ${status}: ${text}`);
  }
}

// What Bun refuses in a header value: NUL, CR, LF, and anything past Latin-1.
const UNSENDABLE_IN_HEADER = /[\0\r\n\u0100-\uffff]/;

/**
 * A request to ElevenLabs on a tenant's key. A key the runtime will not send as a header (a newline
 * pasted with it) would fail inside fetch, and Bun's message for that carries the header VALUE, the
 * write-only key, which would reach the caller, the call's hangup reason and the logs. Such a key is
 * refused here instead, as what it is, a key ElevenLabs could never accept, without the key in it.
 */
export async function keyedFetch(
  fetchImpl: typeof fetch,
  apiKey: string,
  url: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Promise<Response> {
  if (UNSENDABLE_IN_HEADER.test(apiKey))
    throw new ElevenLabsRefusal(
      "sending the key",
      0,
      "the stored key is not a valid header value",
      "invalid_key",
    );
  return fetchImpl(url, {
    ...init,
    headers: { ...init.headers, "xi-api-key": apiKey },
  });
}

async function refusal(
  what: string,
  res: Response,
): Promise<ElevenLabsRefusal> {
  const body = await res.text();
  return new ElevenLabsRefusal(
    what,
    res.status,
    refusalText(body),
    keyRefusal(res.status, body),
  );
}

/** Whether a key can run ElevenLabs Agents: a text-to-speech-only key answers 401 on the agents list. */
export async function checkElevenLabsAgentsAccess(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AccessCheck> {
  let res: Response;
  try {
    res = await keyedFetch(
      fetchImpl,
      apiKey,
      `${API}/v1/convai/agents?page_size=1`,
      { signal: deadline() },
    );
  } catch (err) {
    if (err instanceof ElevenLabsRefusal && err.keyProblem)
      return { ok: false, reason: err.keyProblem, detail: err.text };
    return { ok: false, reason: "unreachable", detail: (err as Error).message };
  }
  if (res.ok) return { ok: true };
  const body = await res.text();
  const detail = refusalText(body);
  const keyProblem = keyRefusal(res.status, body);
  if (keyProblem) return { ok: false, reason: keyProblem, detail };
  return {
    ok: false,
    reason: "unreachable",
    detail: `${res.status} ${detail}`,
  };
}

// Every request to ElevenLabs is bounded, its body included: a call's setup and the Playground's
// ticket wait on them, and a provider that stalls would leave the person in silence.
const REQUEST_TIMEOUT_MS = 15_000;
const deadline = () => AbortSignal.timeout(REQUEST_TIMEOUT_MS);

/**
 * The id of the agent carrying these calls on ElevenLabs, created when `agentId` is null or no longer
 * exists there, and patched when the configuration changed since it was last written (`digests`).
 */
export async function ensureElevenLabsAgent(
  apiKey: string,
  agentId: string | null,
  spec: ElevenLabsAgentSpec,
  fetchImpl: typeof fetch = fetch,
  digests: ConfigDigests = dbConfigDigests(),
  holdEngine: HoldEngineAgent = dbEngineHold(CONFIG_HOLD_LEASE_MS),
): Promise<string> {
  const body = JSON.stringify(elevenLabsAgentConfig(spec));
  // The key is part of what was written: the same settings under another account are unchecked there.
  const digest = createHash("sha256")
    .update(apiKey)
    .update("\0")
    .update(body)
    .digest("hex");
  const headers = { "content-type": "application/json" };
  if (agentId) {
    // Read without the hold first: a digest written under a hold is true, and most setups find it.
    if ((await digests.read(agentId)) === digest) return agentId;
    // The write, its digest and the read before them under one hold, across processes: two writes
    // whose answers came back out of order would otherwise record the one ElevenLabs no longer has.
    const hold = await holdEngine(
      agentId,
      AbortSignal.timeout(CONFIG_HOLD_WAIT_MS),
    );
    let res: Response;
    try {
      if (hold.configDigest === digest) return agentId;
      await hold.markConfigured(null);
      res = await keyedFetch(
        fetchImpl,
        apiKey,
        `${API}/v1/convai/agents/${encodeURIComponent(agentId)}`,
        { method: "PATCH", headers, body, signal: deadline() },
      );
      if (res.ok) {
        await hold.markConfigured(digest);
        return agentId;
      }
    } finally {
      await hold.release();
    }
    if (res.status !== 404) throw await refusal("updating the agent", res);
  }
  const res = await keyedFetch(
    fetchImpl,
    apiKey,
    `${API}/v1/convai/agents/create`,
    { method: "POST", headers, body, signal: deadline() },
  );
  if (!res.ok) throw await refusal("creating the agent", res);
  const created = (await res.json()) as { agent_id?: string };
  if (!created.agent_id) throw new Error("elevenlabs: created agent has no id");
  await digests.write(created.agent_id, digest);
  return created.agent_id;
}

/**
 * Forgets what an agent was written with, for one ElevenLabs says is gone: the next setup then finds
 * out for itself, and creates it again, instead of trusting a write to an agent that is no more.
 */
export async function forgetElevenLabsAgent(
  agentId: string,
  digests: ConfigDigests = dbConfigDigests(),
): Promise<void> {
  await digests.write(agentId, null);
}

/** Deletes an agent on ElevenLabs; best-effort, for one this process created and then did not keep. */
export async function deleteElevenLabsAgent(
  apiKey: string,
  agentId: string,
  fetchImpl: typeof fetch = fetch,
  digests: ConfigDigests = dbConfigDigests(),
): Promise<void> {
  try {
    await digests.write(agentId, null);
    await keyedFetch(
      fetchImpl,
      apiKey,
      `${API}/v1/convai/agents/${encodeURIComponent(agentId)}`,
      { method: "DELETE", signal: deadline() },
    );
  } catch {
    // An agent left behind is unused, not wrong: nothing points at it.
  }
}

// How long the conversation's analysis takes to be ready once the call is over: ElevenLabs runs it
// right after, and a few seconds is the usual.
const SUMMARY_ATTEMPTS = 6;
const SUMMARY_WAIT_MS = 5_000;

/**
 * The summary ElevenLabs writes of a conversation once it is over (`analysis.transcript_summary`), on
 * the tenant's own key; null when it is not ready in time or cannot be read.
 */
export async function elevenLabsCallSummary(
  apiKey: string,
  conversationId: string,
  deps: {
    fetchImpl?: typeof fetch;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<string | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const wait =
    deps.wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt < SUMMARY_ATTEMPTS; attempt++) {
    if (attempt > 0) await wait(SUMMARY_WAIT_MS);
    const res = await keyedFetch(
      fetchImpl,
      apiKey,
      `${API}/v1/convai/conversations/${encodeURIComponent(conversationId)}`,
      { signal: deadline() },
    ).catch(() => null);
    if (!res?.ok) continue;
    const body = (await res.json().catch(() => null)) as {
      status?: string;
      analysis?: { transcript_summary?: string | null } | null;
    } | null;
    const summary = body?.analysis?.transcript_summary?.trim();
    if (summary) return summary;
    if (body?.status === "failed") return null;
  }
  return null;
}
