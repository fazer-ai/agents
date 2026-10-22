import config from "@/config";
import { NEW_AGENT_CONTEXT_MESSAGES } from "@/modules/guardrails/settings";

/**
 * The settings an agent is born with, on every door that creates one (create and import). A server
 * running in development logs tool values from creation, so a fresh local database does not begin
 * each test round by switching it on agent by agent; anywhere else the default stays off. A bag that
 * already says either way keeps what it says. Only `NODE_ENV` decides: nothing in the request or the
 * database can turn it on.
 */
export function withCreationDefaults<T>(settings: T): T {
  if (config.env !== "development") return settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    return settings;
  const bag = settings as Record<string, unknown>;
  const raw = bag.observability;
  const obs =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  if ("logToolValues" in obs) return settings;
  return {
    ...bag,
    observability: { ...obs, logToolValues: true },
  } as T;
}

/**
 * What an agent created from scratch is born with, in every environment: the input guardrail reads
 * the last two exchanges as context. Only the create door applies it. A clone copies its source and an
 * import its bundle, and an agent saved before the setting existed keeps judging the message alone,
 * so no verdict changes under anyone on upgrade. A bag that already says either way keeps what it says.
 */
export function withNewAgentDefaults<T>(settings: T): T {
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    return settings;
  const bag = settings as Record<string, unknown>;
  const guardrails = asBag(bag.guardrails);
  const input = asBag(guardrails.input);
  if ("contextMessages" in input) return settings;
  return {
    ...bag,
    guardrails: {
      ...guardrails,
      input: { ...input, contextMessages: NEW_AGENT_CONTEXT_MESSAGES },
    },
  } as T;
}

function asBag(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

// Whether a stored settings block holds nothing but what `withNewAgentDefaults` stamped: nobody
// configured it, so a write that replaces the bag without naming it keeps it rather than being refused
// for dropping a block, or quietly turning the window off.
function isUntouchedCreationDefault(value: unknown): boolean {
  const guardrails = asBag(value);
  const input = asBag(guardrails.input);
  return (
    Object.keys(guardrails).length === 1 &&
    Object.keys(input).length === 1 &&
    input.contextMessages === NEW_AGENT_CONTEXT_MESSAGES
  );
}

export function keepCreationDefaults(next: unknown, before: unknown): void {
  if (!next || typeof next !== "object" || Array.isArray(next)) return;
  const settings = next as Record<string, unknown>;
  const stored = asBag(before).guardrails;
  if (settings.guardrails === undefined && isUntouchedCreationDefault(stored))
    settings.guardrails = structuredClone(stored);
}
