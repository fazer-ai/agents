import { describe, expect, test } from "bun:test";
import {
  SECRET_TYPE_IDS as CLIENT_SECRET_TYPE_IDS,
  dialableBaseUrl as clientDialable,
  SECRET_TYPE_META,
} from "@/client/lib/secretTypes";
import {
  SECRET_TYPES,
  SECRET_TYPE_IDS as SERVER_SECRET_TYPE_IDS,
} from "@/modules/vault/secret-types";
import { dialableBaseUrl as serverDialable } from "@/modules/vault/service";

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

  // NOTE: the base-URL pair, load-bearing since issue #504 for the same reason `needsParamName`
  // became load-bearing with #488: the write now REFUSES a base URL on a kind that declares none,
  // and the form is what keeps the console from ever sending one — it submits the field only when
  // its own copy says the kind takes one. Drift here is a save the operator cannot fix, because the
  // form renders no input for a kind it thinks takes no URL, and the refusal would name a field with
  // nowhere to go.
  //
  // The client keeps the pair as two booleans because that is what the form asks (render the input /
  // mark it required); the SERVER holds one field, so "required but not supported" cannot be
  // written there. This test is what stops the client from writing it.
  // NOTE: the two GATES, not just the two declarations. The console decides with this — the tool
  // editor accepts a relative url_template only when a credential supplies a base — and the runtime
  // dials with it, so the day they disagree an operator saves a tool the runtime refuses to build.
  // The unknown kind is in here on purpose: both sides refuse nothing for a kind they do not know,
  // and a client that gated it would blank a base URL a newer build wrote.
  test("the two dialableBaseUrl agree, kind by kind and past the catalog", () => {
    const BASE = "https://elsewhere.invalid";
    for (const id of SERVER_SECRET_TYPE_IDS) {
      expect([id, clientDialable(id, BASE)]).toEqual([
        id,
        serverDialable(id, BASE),
      ]);
    }
    for (const unknown of [null, "kind_from_a_future_build", "toString"]) {
      expect([unknown, clientDialable(unknown, BASE)]).toEqual([
        unknown,
        serverDialable(unknown, BASE),
      ]);
    }
    // NOTE: a floor — an assertion that both sides answered `null` for everything would pass while
    // proving nothing about the kinds that DO carry one.
    expect(
      SERVER_SECRET_TYPE_IDS.filter((id) => clientDialable(id, BASE) === BASE)
        .length,
    ).toBe(9);
  });

  test("the client base-URL pair matches the server's single declaration", () => {
    for (const type of SECRET_TYPES) {
      const meta = SECRET_TYPE_META[type.id as keyof typeof SECRET_TYPE_META];
      expect(!!meta?.supportsBaseUrl).toBe(type.baseUrl != null);
      expect(!!meta?.requiresBaseUrl).toBe(type.baseUrl === "required");
      if (meta?.requiresBaseUrl) expect(meta.supportsBaseUrl).toBe(true);
    }
  });
});
