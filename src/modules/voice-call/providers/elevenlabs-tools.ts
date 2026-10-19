// The agent's tools on ElevenLabs Agents. The platform's model only calls a tool declared on the
// agent itself, so each one is declared there as a "client" tool: the call's own socket then carries
// the call to this side, which runs it and answers on the same socket. Declared again only when the
// set changes, since every declaration creates tool resources on the ElevenLabs side.

import { createHash } from "node:crypto";
import config from "@/config";
import { clipText } from "@/lib/text";
import type { ConfigDigests } from "./config-digests";
import { forgetElevenLabsAgent, keyedFetch } from "./elevenlabs-agent";
import type { VoiceTool } from "./types";

const API = "https://api.elevenlabs.io";
// Each link more patient than the one below it, as HTTP_TOOL_TIMEOUT_MS asks: a tool that writes
// (a booking) settles on its own deadline before this side answers the engine, so a slow one is
// never reported as failed and retried while it still commits. The engine waits longer still, and
// accepts at most 120 s, so on a call an HTTP tool gets the instance's deadline only up to 100 s.
export const CALL_HTTP_TOOL_TIMEOUT_MS = Math.min(
  config.agent.httpToolTimeoutMs,
  100_000,
);
export const VOICE_TOOL_TIMEOUT_MS = CALL_HTTP_TOOL_TIMEOUT_MS + 5_000;
const RESPONSE_TIMEOUT_SECS = Math.ceil(VOICE_TOOL_TIMEOUT_MS / 1000) + 5;

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

const SCALARS = new Set(["string", "number", "integer", "boolean"]);
const NULL: Schema = { type: "null" };
// A value whose type the schema does not constrain (`{}`, a description alone, or `items` or
// `properties` with no `type`, which only apply when the value is an array or an object) may be any
// JSON value: declared as a plain string it would reach the tool as text, a number or an object
// included.
const ANY: Schema = { type: "any" };
const CONSTRAINTS = ["type", "anyOf", "oneOf", "enum", "const"];
const unconstrained = (schema: Schema) =>
  CONSTRAINTS.every((key) => schema[key] === undefined);

// The types a value may take, when ElevenLabs cannot declare them as one: two or more, or one scalar
// that may also be null. Null cannot be declared at all, and dropping it would take away what the
// tool does with it (clearing a field, where leaving it out keeps it), so a nullable scalar travels
// as a union too. A nullable object or array keeps its shape instead, and so cannot be null on a call.
function unionAlternatives(schema: Schema): Schema[] | null {
  if (unconstrained(schema)) return [ANY];
  // A dictionary (an object whose keys are the caller's, `additionalProperties` with no `properties`)
  // has no fields ElevenLabs could list: declared as an empty object, it reaches the tool empty.
  if (isDictionary(schema)) return [{ type: "object" }];
  // An enum with no type whose values are not all one scalar type (`[1, "a"]`, or one with null)
  // cannot be declared as a list of one type: it travels as JSON, and only its own values are read.
  if (
    schema.type === undefined &&
    schema.anyOf === undefined &&
    schema.oneOf === undefined &&
    Array.isArray(schema.enum) &&
    !enumType(schema.enum)
  )
    return [{ enum: schema.enum }];
  let all: Schema[] | null = null;
  if (Array.isArray(schema.type))
    all = schema.type.map((type) => ({ ...schema, type }) as Schema);
  else {
    const branches = schema.anyOf ?? schema.oneOf;
    if (Array.isArray(branches)) all = branches as Schema[];
  }
  if (!all) return null;
  const nonNull = all.filter((b) => b.type !== "null");
  const nullable = nonNull.length < all.length;
  const only = nonNull[0];
  if (nonNull.length > 1) return nullable ? [...nonNull, NULL] : nonNull;
  if (nullable && only && SCALARS.has(String(only.type))) return [only, NULL];
  return null;
}

const typeName = (s: Schema) => {
  if (s === ANY) return "any type";
  const name = typeof s.type === "string" ? s.type : "value";
  return Array.isArray(s.enum)
    ? `${name} (one of ${s.enum.map((v) => JSON.stringify(v)).join(", ")})`
    : name;
};

/**
 * ElevenLabs takes a subset of JSON Schema, and every property has to carry a description. A union of
 * types, which it cannot declare, travels as a string holding the value as JSON, and the description
 * names the types it may be; `fromElevenLabsArgs` turns it back before the tool runs. A value the
 * schema leaves unconstrained travels the same way, as any type.
 */
export function elevenLabsSchema(schema: Schema, name: string): Schema {
  const description =
    typeof schema.description === "string" && schema.description.trim()
      ? schema.description
      : name;
  const alternatives = unionAlternatives(schema);
  if (alternatives)
    return {
      type: "string",
      description: `${description} (a JSON value: ${alternatives.map(typeName).join(" or ")})`,
    };
  let type =
    schema.type ??
    constType(schema.const) ??
    (Array.isArray(schema.enum) ? enumType(schema.enum) : undefined);
  if (Array.isArray(type)) type = type.find((t) => t !== "null");
  const branches = schema.anyOf ?? schema.oneOf;
  if (!type && Array.isArray(branches)) {
    const branch = (branches as Schema[]).find((s) => s.type !== "null");
    if (branch) return elevenLabsSchema({ ...branch, ...pick(schema) }, name);
  }
  const out: Schema = {
    type: typeof type === "string" ? type : "string",
    description,
  };
  if (Array.isArray(schema.enum)) out.enum = schema.enum;
  // A constant (a discriminator such as `kind: { const: "person" }`) is the one value the tool takes:
  // ElevenLabs has no `const`, so it is declared as an enum of one.
  else if (constType(schema.const)) out.enum = [schema.const];
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

const matches = (alternative: Schema, value: unknown): boolean => {
  if (alternative.type === undefined && Array.isArray(alternative.enum))
    return alternative.enum.some(
      (allowed) => JSON.stringify(allowed) === JSON.stringify(value),
    );
  switch (alternative.type) {
    case "number":
      return typeof value === "number";
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "array":
      return Array.isArray(value);
    case "object":
      return !!value && typeof value === "object" && !Array.isArray(value);
    case "null":
      return value === null;
    case "any":
      return true;
    default:
      return value !== null;
  }
};

/**
 * The arguments the engine sent, as the tool's own schema takes them: a union declared as a JSON
 * string (`elevenLabsSchema`) is parsed back when the result is one of its types, and left as it came
 * otherwise, for the tool's own validation to answer.
 */
export function fromElevenLabsArgs(schema: Schema, value: unknown): unknown {
  const alternatives = unionAlternatives(schema);
  if (alternatives) {
    if (typeof value !== "string") return value;
    try {
      const parsed: unknown = JSON.parse(value);
      return alternatives.some((a) => matches(a, parsed)) ? parsed : value;
    } catch {
      return value;
    }
  }
  // A nullable shape is declared as its one non-null branch (`elevenLabsSchema`), and read the same.
  const branches = schema.anyOf ?? schema.oneOf;
  if (!schema.type && Array.isArray(branches)) {
    const branch = (branches as Schema[]).find((s) => s.type !== "null");
    if (branch) return fromElevenLabsArgs(branch, value);
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === "object")
    return value.map((item) =>
      fromElevenLabsArgs(schema.items as Schema, item),
    );
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        props[key] ? fromElevenLabsArgs(props[key], v) : v,
      ]),
    );
  }
  return value;
}

// The JSON type of a scalar constant, or undefined for none (or one ElevenLabs cannot list).
function constType(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "boolean")
    return typeof value;
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  return undefined;
}

// The one JSON type every value of an enum has (integers among numbers count as numbers), or
// undefined when they differ or one is not a scalar ElevenLabs can list (its type is undefined, which
// differs from any other, or is the only one).
function enumType(values: unknown[]): string | undefined {
  const types = new Set(values.map(constType));
  if (types.size === 2 && types.has("integer") && types.has("number"))
    return "number";
  return types.size === 1 ? [...types][0] : undefined;
}

function isDictionary(schema: Schema): boolean {
  const props = schema.properties as Record<string, unknown> | undefined;
  return (
    schema.type === "object" &&
    (!props || Object.keys(props).length === 0) &&
    schema.additionalProperties !== undefined &&
    schema.additionalProperties !== false
  );
}

function pick(schema: Schema): Schema {
  return typeof schema.description === "string"
    ? { description: schema.description }
    : {};
}

// A tool's arguments, when they are a dictionary themselves (keys the caller chooses), are one JSON
// field under this name: ElevenLabs takes only an object of declared fields as a tool's parameters.
const ROOT_DICTIONARY_FIELD = "arguments";

/** A tool's parameters as ElevenLabs takes them: always an object of declared fields. */
export function elevenLabsParameters(parameters: Schema, name: string): Schema {
  const root = { type: "object", ...parameters };
  if (isDictionary(root))
    return {
      type: "object",
      properties: {
        [ROOT_DICTIONARY_FIELD]: {
          type: "string",
          description: `${name} (a JSON value: object)`,
        },
      },
      required: [ROOT_DICTIONARY_FIELD],
    };
  const { description: _, ...declared } = elevenLabsSchema(root, name);
  return declared;
}

/** The arguments the engine sent for a tool, as the tool's own schema takes them. */
export function fromElevenLabsToolArgs(
  parameters: Schema,
  value: unknown,
): unknown {
  const root = { type: "object", ...parameters };
  if (!isDictionary(root)) return fromElevenLabsArgs(root, value);
  const raw = (value as Record<string, unknown> | null)?.[
    ROOT_DICTIONARY_FIELD
  ];
  if (typeof raw !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : value;
  } catch {
    return value;
  }
}

export function elevenLabsToolDefs(
  tools: VoiceTool[] = [],
  toolSound: string | null = null,
) {
  return tools.map((tool) => {
    const parameters = elevenLabsParameters(tool.parameters, tool.name);
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

export interface ToolSyncOptions {
  apiKey: string;
  agentId: string;
  toolSound?: string | null;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** What the agent was last declared with (`EngineHold.declaredDigest`). */
  declared?: string | null;
  /** Runs before a declaration is sent, to forget the recorded one it may replace. */
  onDeclaring?: () => Promise<void>;
  /** Where a gone agent's configuration is forgotten; the database by default. */
  configDigests?: ConfigDigests;
}

/**
 * Declares the call's tools and end_call on the ElevenLabs agent, unless that set is already there.
 * Answers the digest it declared, or null when it declared nothing.
 */
export async function syncElevenLabsTools(
  options: ToolSyncOptions,
  tools: VoiceTool[] = [],
): Promise<string | null> {
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
  if (options.declared === digest) return null;
  await options.onDeclaring?.();
  const res = await keyedFetch(
    options.fetchImpl ?? fetch,
    options.apiKey,
    `${API}/v1/convai/agents/${encodeURIComponent(options.agentId)}`,
    {
      method: "PATCH",
      signal: options.signal,
      headers: { "content-type": "application/json" },
      body,
    },
  );
  if (!res.ok) {
    if (res.status === 404)
      await forgetElevenLabsAgent(options.agentId, options.configDigests);
    const detail = clipText(await res.text(), 300);
    throw new Error(
      `elevenlabs: declaring the tools failed with ${res.status}: ${detail}`,
    );
  }
  return digest;
}
