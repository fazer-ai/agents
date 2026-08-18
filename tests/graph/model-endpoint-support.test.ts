import { describe, expect, test } from "bun:test";
import {
  MODEL_PROVIDERS,
  PROVIDERS_HONORING_BASE_URL,
} from "@/graph/model-config";
import { createChatModel } from "@/graph/models";

// Which providers actually SEND a configured endpoint, asked of the built instances rather than of
// the switch statement. The list is consumed as a rule (a caller with an endpoint to honor refuses
// the providers that would drop it), so a provider added to the factory with endpoint support — or
// an adapter that quietly gains or loses it on an upgrade — has to show up here rather than in a
// customer's traffic going somewhere they did not configure.

const PROBE = "https://probe.example.com/v1";

// Every field an adapter in this tree is known to park an endpoint on. Read broadly ON PURPOSE: the
// question is "does the configured host survive anywhere on the client", and a false negative here
// would silently bless a provider that drops it.
function endpointsOn(instance: unknown): string[] {
  const m = instance as Record<string, unknown> & {
    clientConfig?: { baseURL?: string };
    clientOptions?: { baseURL?: string };
  };
  return [
    m.clientConfig?.baseURL,
    m.clientOptions?.baseURL,
    m.apiUrl,
    m.anthropicApiUrl,
    m.baseUrl,
    m.baseURL,
  ].filter((v): v is string => typeof v === "string" && v !== "");
}

describe("which providers honor a configured base URL", () => {
  for (const provider of MODEL_PROVIDERS) {
    const honors = (PROVIDERS_HONORING_BASE_URL as readonly string[]).includes(
      provider,
    );
    test(`${provider} ${honors ? "sends" : "ignores"} the configured endpoint`, () => {
      const model = createChatModel({
        provider,
        model: "m",
        apiKey: "k",
        temperature: 0,
        baseURL: PROBE,
      });
      expect(endpointsOn(model).includes(PROBE)).toBe(honors);
    });
  }

  // The one that reads as an accident but is not: deepseek accepts a base URL and keeps its OWN.
  // Nothing throws, nothing warns, and the request leaves for the vendor's public endpoint.
  test("deepseek keeps its own endpoint rather than the configured one", () => {
    const model = createChatModel({
      provider: "deepseek",
      model: "deepseek-chat",
      apiKey: "k",
      temperature: 0,
      baseURL: PROBE,
    });
    const seen = endpointsOn(model);
    expect(seen).not.toContain(PROBE);
    expect(seen.some((u) => u.includes("deepseek.com"))).toBe(true);
  });
});
