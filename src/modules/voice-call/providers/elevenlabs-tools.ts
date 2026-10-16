// The agent's tools on ElevenLabs Agents. The platform's model only calls a tool declared on the
// agent itself, so each one is declared there as a "client" tool: the call's own socket then carries
// the call to this side, which runs it and answers on the same socket. Declared again only when the
// set changes, since every declaration creates tool resources on the ElevenLabs side.

import { createHash } from "node:crypto";
import { clipText } from "@/lib/text";
import type { VoiceTool } from "./types";

const API = "https://api.elevenlabs.io";
const RESPONSE_TIMEOUT_SECS = 10;

// end_call goes in the same list, as a system tool. Declared beside the list under
// built_in_tools, the platform accepts the request and drops end_call: the agent then has no way to
// hang up, which is what made every model "refuse" to end a call.
const END_CALL = {
  type: "system",
  name: "end_call",
  description:
    "Encerra a ligação. Use logo depois de se despedir: quando a conversa terminou, quando a pessoa disse que não quer mais nada ou pediu para desligar.",
  params: { system_tool_type: "end_call" },
};

type Schema = Record<string, unknown>;

/** ElevenLabs takes a subset of JSON Schema, and every property has to carry a description. */
export function elevenLabsSchema(schema: Schema, name: string): Schema {
  let type = schema.type;
  if (Array.isArray(type)) type = type.find((t) => t !== "null");
  if (!type && Array.isArray(schema.anyOf)) {
    const branch = (schema.anyOf as Schema[]).find((s) => s.type !== "null");
    if (branch) return elevenLabsSchema({ ...branch, ...pick(schema) }, name);
  }
  const out: Schema = {
    type: typeof type === "string" ? type : "string",
    description:
      typeof schema.description === "string" && schema.description.trim()
        ? schema.description
        : name,
  };
  if (Array.isArray(schema.enum)) out.enum = schema.enum;
  if (out.type === "object") {
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    out.properties = Object.fromEntries(
      Object.entries(props).map(([key, value]) => [
        key,
        elevenLabsSchema(value, key),
      ]),
    );
    out.required = Array.isArray(schema.required) ? schema.required : [];
  }
  if (out.type === "array")
    out.items = elevenLabsSchema(
      (schema.items ?? { type: "string" }) as Schema,
      `${name} (item)`,
    );
  return out;
}

function pick(schema: Schema): Schema {
  return typeof schema.description === "string"
    ? { description: schema.description }
    : {};
}

export function elevenLabsToolDefs(
  tools: VoiceTool[] = [],
  toolSound: string | null = null,
) {
  return tools.map((tool) => {
    const { description: _, ...parameters } = elevenLabsSchema(
      { type: "object", ...tool.parameters },
      tool.name,
    );
    return {
      type: "client",
      name: tool.name,
      description: tool.description || tool.name,
      expects_response: true,
      response_timeout_secs: RESPONSE_TIMEOUT_SECS,
      // "auto" plays it only when the agent did not speak before calling the tool.
      ...(toolSound
        ? { tool_call_sound: toolSound, tool_call_sound_behavior: "auto" }
        : {}),
      parameters,
    };
  });
}

const declared = new Map<string, string>();

export interface ToolSyncOptions {
  apiKey: string;
  agentId: string;
  toolSound?: string | null;
  fetchImpl?: typeof fetch;
}

/** Declares the call's tools and end_call on the ElevenLabs agent, unless that set is already there. */
export async function syncElevenLabsTools(
  options: ToolSyncOptions,
  tools: VoiceTool[] = [],
): Promise<void> {
  const body = JSON.stringify({
    conversation_config: {
      agent: {
        prompt: {
          tools: [
            ...elevenLabsToolDefs(tools, options.toolSound ?? null),
            END_CALL,
          ],
        },
      },
    },
  });
  const digest = createHash("sha256").update(body).digest("hex");
  if (declared.get(options.agentId) === digest) return;
  const res = await (options.fetchImpl ?? fetch)(
    `${API}/v1/convai/agents/${encodeURIComponent(options.agentId)}`,
    {
      method: "PATCH",
      headers: {
        "xi-api-key": options.apiKey,
        "content-type": "application/json",
      },
      body,
    },
  );
  if (!res.ok) {
    const detail = clipText(await res.text(), 300);
    throw new Error(
      `elevenlabs: declaring the tools failed with ${res.status}: ${detail}`,
    );
  }
  declared.set(options.agentId, digest);
}
