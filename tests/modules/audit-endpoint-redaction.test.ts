import { describe, expect, test } from "bun:test";
import { redactEndpoint } from "@/modules/audit/projection";

// A URL in an audit row outlives the record it describes: the trail is append-only and the live read
// surfaces that return these URLs whole are not. `redactEndpoint` is what stands between an operator
// pasting a token into an endpoint and that token being permanent.
//
// A table rather than a fixture per caller, because the rule is one and the callers are two: an
// outbound webhook subscription keeps its path (the column is in the clear and the trail is read to
// tell two endpoints on one host apart), an alert channel does not (its column is ENCRYPTED at rest
// precisely because a Discord webhook carries its token in the PATH).

const CASES: Array<[url: string, origin: string, path: string]> = [
  // The three places a credential hides, one at a time, then all at once.
  [
    "https://user:pw@example.com/hook",
    "https://example.com/…",
    "https://example.com/hook",
  ],
  [
    "https://example.com/hook?token=abc",
    "https://example.com/…",
    "https://example.com/hook",
  ],
  [
    "https://example.com/hook#token=abc",
    "https://example.com/…",
    "https://example.com/hook",
  ],
  [
    "https://user:pw@example.com/hook?token=abc#more=xyz",
    "https://example.com/…",
    "https://example.com/hook",
  ],
  // A bare token as the username, with no password: userinfo is the whole of it.
  [
    "https://sk-live-abc@example.com/hook",
    "https://example.com/…",
    "https://example.com/hook",
  ],
  // Nothing to remove: the ordinary case is returned as it was, minus the trailing nothing.
  [
    "https://example.com/hook",
    "https://example.com/…",
    "https://example.com/hook",
  ],
  // The port is part of the host and is kept: it identifies the endpoint and holds no secret.
  [
    "https://example.com:8443/a/b",
    "https://example.com:8443/…",
    "https://example.com:8443/a/b",
  ],
  // A Discord webhook, which is why `origin` exists at all: the token IS the path.
  [
    "https://discord.com/api/webhooks/123/TOKENHERE",
    "https://discord.com/…",
    "https://discord.com/api/webhooks/123/TOKENHERE",
  ],
];

describe("redactEndpoint", () => {
  for (const [url, origin, path] of CASES) {
    test(`origin: ${url}`, () => {
      expect(redactEndpoint(url, "origin")).toBe(origin);
    });
    test(`path: ${url}`, () => {
      expect(redactEndpoint(url, "path")).toBe(path);
    });
  }

  test("a string that is not a URL yields nothing, on either setting", () => {
    // Not parseable, so no part of it can be shown to be safe — including the whole of it.
    for (const bad of ["", "not a url", "///", "example.com/hook"]) {
      expect(redactEndpoint(bad, "origin")).toBe("…");
      expect(redactEndpoint(bad, "path")).toBe("…");
    }
  });

  test("no case in the table leaks the secret it carries", () => {
    // The table above is read by eye; this is the assertion that does not depend on that.
    for (const [url, origin] of CASES) {
      for (const secret of ["pw", "abc", "xyz", "sk-live-abc"]) {
        if (!url.includes(secret)) continue;
        expect(origin.includes(secret)).toBe(false);
      }
    }
  });
});
