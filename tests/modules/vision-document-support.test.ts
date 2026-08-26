import { describe, expect, test } from "bun:test";
import { visionAcceptsDocuments } from "@/modules/vision/document-support";

// Which provider was picked is not the whole question: the base URL follows the CREDENTIAL and
// survives a provider change, so an agent moved from `openai-compatible` to `openai` keeps posting
// to the operator's own server. Getting this wrong in the permissive direction is not a 400 the
// operator can read — a server that ignores an unknown content part answers 200 with a plausible
// extraction of a document it never saw.
describe("visionAcceptsDocuments", () => {
  const table: Array<[string, string, string | null, boolean]> = [
    ["openai on its own endpoint", "openai", null, true],
    ["openai with the field left blank", "openai", "", true],
    ["openai with whitespace only", "openai", "   ", true],
    [
      "openai with the endpoint spelled out",
      "openai",
      "https://api.openai.com/v1",
      true,
    ],
    [
      "openai with a trailing slash",
      "openai",
      "https://api.openai.com/v1/",
      true,
    ],
    [
      "openai spelled in mixed case",
      "openai",
      "https://API.OpenAI.com/v1",
      true,
    ],
    // The lookalike: a host that merely STARTS with the official one is somebody else's server.
    [
      "a lookalike host",
      "openai",
      "https://api.openai.com.evil.example/v1",
      false,
    ],
    [
      "a host that only ends in the domain",
      "openai",
      "https://notapi.openai.com/v1",
      false,
    ],
    // Data residency: the SAME API under a regional hostname. Skipping a PDF there would be a
    // silent regression for exactly the customers who had to move region for legal reasons.
    [
      "the EU residency endpoint",
      "openai",
      "https://eu.api.openai.com/v1",
      true,
    ],
    [
      "the Japan residency endpoint",
      "openai",
      "https://jp.api.openai.com/v1",
      true,
    ],
    [
      "a region that does not exist yet",
      "openai",
      "https://zz.api.openai.com/v1",
      true,
    ],
    [
      "a proxy of the operator's",
      "openai",
      "https://llm.internal.example/v1",
      false,
    ],
    // Plaintext carrying an API key and a customer's document is not the official endpoint,
    // whatever the hostname claims.
    [
      "the official host over http",
      "openai",
      "http://api.openai.com/v1",
      false,
    ],
    ["something that is not a URL", "openai", "api.openai.com/v1", false],
    // Gemini and Anthropic put a document in the same content part as an image, so the address
    // cannot change the answer: an endpoint serving one serves the other.
    ["gemini anywhere", "gemini", "https://llm.internal.example/v1beta", true],
    ["gemini on its own endpoint", "gemini", null, true],
    [
      "anthropic anywhere",
      "anthropic",
      "https://llm.internal.example/v1",
      true,
    ],
    // These two are arbitrary endpoints by definition, official-looking URL or not.
    ["openrouter", "openrouter", null, false],
    [
      "openrouter pointed at OpenAI",
      "openrouter",
      "https://api.openai.com/v1",
      false,
    ],
    [
      "openai-compatible pointed at a residency host",
      "openai-compatible",
      "https://eu.api.openai.com/v1",
      false,
    ],
    [
      "openai-compatible",
      "openai-compatible",
      "https://llm.internal.example/v1",
      false,
    ],
    [
      "openai-compatible pointed at OpenAI",
      "openai-compatible",
      "https://api.openai.com/v1",
      false,
    ],
    ["a provider that does not exist", "made-up", null, false],
  ];

  for (const [name, provider, baseURL, expected] of table) {
    test(`${name} → ${expected ? "documents" : "images only"}`, () => {
      expect(visionAcceptsDocuments(provider, baseURL)).toBe(expected);
    });
  }
});
