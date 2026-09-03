import { describe, expect, test } from "bun:test";
import {
  SECRET_TYPE_IDS as CLIENT_SECRET_TYPE_IDS,
  SECRET_TYPE_META,
} from "@/client/lib/secretTypes";
import {
  SECRET_TYPES,
  SECRET_TYPE_IDS as SERVER_SECRET_TYPE_IDS,
} from "@/modules/vault/secret-types";

// The client mirror (src/client/lib/secretTypes.ts) must stay in lockstep with the server catalog
// (src/modules/vault/secret-types.ts) — otherwise a new credential kind is usable server-side but
// invisible in the credential-type picker (exactly what happened when openrouter was added only to
// the server catalog). This test fails the moment either list drifts from the other.
describe("secret-types client mirror", () => {
  test("client id set matches the server id set", () => {
    const clientIds: string[] = [...CLIENT_SECRET_TYPE_IDS].sort();
    const serverIds: string[] = [...SERVER_SECRET_TYPE_IDS].sort();
    expect(clientIds).toEqual(serverIds);
  });

  test("client meta (service + testable) matches the server catalog for every type", () => {
    for (const type of SECRET_TYPES) {
      const meta = SECRET_TYPE_META[type.id as keyof typeof SECRET_TYPE_META];
      expect(meta?.service).toBe(type.service);
      expect(!!meta?.testable).toBe(!!type.test);
    }
  });

  // NOTE: `needsParamName` is the one meta field the two copies have to agree on for the SERVER's sake,
  // and it became load-bearing with issue #488: the write now REFUSES a param name on a kind that
  // declares none, and the form is what keeps the console from ever sending one (it submits
  // `paramName: undefined` unless its own copy says the kind needs it). Drift in either direction
  // is a save the operator cannot fix — the form does not render the input for a kind it thinks
  // takes no name, so the refusal would name a field with nowhere to go.
  test("client needsParamName matches the server catalog for every type", () => {
    for (const type of SECRET_TYPES) {
      const meta = SECRET_TYPE_META[type.id as keyof typeof SECRET_TYPE_META];
      expect(!!meta?.needsParamName).toBe(!!type.needsParamName);
    }
  });
});
