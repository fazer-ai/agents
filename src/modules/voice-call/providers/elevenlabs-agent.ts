// The agent on the customer's ElevenLabs account that carries an agent's calls. The agents console is
// where it is configured: this creates it on first use and keeps it in step with `settings.calls`,
// and nothing about it is meant to be edited on the ElevenLabs dashboard (a later sync overwrites
// it). The prompt, the greeting and the language are not stored there: they go with each call, as
// overrides the agent is created to allow. The tools are declared per call (./elevenlabs-tools.ts).

import { createHash } from "node:crypto";
import { clipText } from "@/lib/text";
import type { CallsConfig } from "../settings";

const API = "https://api.elevenlabs.io";

export interface ElevenLabsAgentSpec {
  name: string;
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
        quality: "high",
        keywords: calls.keywords,
      },
      tts: {
        agent_output_audio_format: "pcm_16000",
        voice_id: spec.voice,
        model_id: "eleven_flash_v2_5",
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
        prompt: { prompt: "Configurado pelo fazer.ai agents.", llm: calls.llm },
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

/** Whether a key can run ElevenLabs Agents: a text-to-speech-only key answers 401 on the agents list. */
export async function checkElevenLabsAgentsAccess(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AccessCheck> {
  let res: Response;
  try {
    res = await fetchImpl(`${API}/v1/convai/agents?page_size=1`, {
      headers: { "xi-api-key": apiKey },
    });
  } catch (err) {
    return { ok: false, reason: "unreachable", detail: (err as Error).message };
  }
  if (res.ok) return { ok: true };
  const detail = clipText(await res.text(), 300);
  if (res.status === 401 && /permission|missing_permissions/i.test(detail))
    return { ok: false, reason: "missing_permission", detail };
  if (res.status === 401) return { ok: false, reason: "invalid_key", detail };
  return {
    ok: false,
    reason: "unreachable",
    detail: `${res.status} ${detail}`,
  };
}

const synced = new Map<string, string>();

/**
 * The id of the agent carrying these calls on ElevenLabs, created when `agentId` is null or no longer
 * exists there, and patched when the configuration changed since this process last wrote it.
 */
export async function ensureElevenLabsAgent(
  apiKey: string,
  agentId: string | null,
  spec: ElevenLabsAgentSpec,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const body = JSON.stringify(elevenLabsAgentConfig(spec));
  const digest = createHash("sha256").update(body).digest("hex");
  const headers = { "xi-api-key": apiKey, "content-type": "application/json" };
  if (agentId) {
    if (synced.get(agentId) === digest) return agentId;
    const res = await fetchImpl(
      `${API}/v1/convai/agents/${encodeURIComponent(agentId)}`,
      { method: "PATCH", headers, body },
    );
    if (res.ok) {
      synced.set(agentId, digest);
      return agentId;
    }
    if (res.status !== 404)
      throw new Error(
        `elevenlabs: updating the agent failed with ${res.status}: ${clipText(await res.text(), 300)}`,
      );
  }
  const res = await fetchImpl(`${API}/v1/convai/agents/create`, {
    method: "POST",
    headers,
    body,
  });
  if (!res.ok)
    throw new Error(
      `elevenlabs: creating the agent failed with ${res.status}: ${clipText(await res.text(), 300)}`,
    );
  const created = (await res.json()) as { agent_id?: string };
  if (!created.agent_id) throw new Error("elevenlabs: created agent has no id");
  synced.set(created.agent_id, digest);
  return created.agent_id;
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
    const res = await fetchImpl(
      `${API}/v1/convai/conversations/${encodeURIComponent(conversationId)}`,
      { headers: { "xi-api-key": apiKey } },
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
