import { describe, expect, test } from "bun:test";
import { redactEndpoint } from "@/modules/audit/projection";

// A URL in an audit row outlives the record it describes: the trail is append-only and the live read
// surfaces that return these URLs whole are not. `redactEndpoint` is what stands between an operator
// pasting a token into an endpoint and that token being permanent.
//
// A table rather than a fixture per caller, because the rule is ONE and the callers are two. It was
// briefly two rules — the alert channel keeping only its origin, the outbound subscription keeping
// its path as well, on the reasoning that its column is in the clear. That reasoning ran from where
// a value is stored to whether it is a secret, and those are unrelated: both families accept the
// same arbitrary HTTPS destination, and the destinations operators point them at (Discord, Slack)
// carry the credential in the PATH.

const CASES: Array<[what: string, url: string, redacted: string]> = [
  // The three places a credential hides in the abstract, one at a time, then all at once.
  ["userinfo", "https://user:pw@example.com/hook", "https://example.com/…"],
  ["query", "https://example.com/hook?token=abc", "https://example.com/…"],
  ["fragment", "https://example.com/hook#token=abc", "https://example.com/…"],
  [
    "all three",
    "https://user:pw@example.com/hook?token=abc#more=xyz",
    "https://example.com/…",
  ],
  // A bare token as the username, with no password: userinfo is the whole of it.
  [
    "bare userinfo",
    "https://sk-live-abc@example.com/hook",
    "https://example.com/…",
  ],
  // And the place it actually turns up. These two are why there is no `keep the path` setting.
  [
    "a Discord webhook",
    "https://discord.com/api/webhooks/123/TOKENHERE",
    "https://discord.com/…",
  ],
  [
    "a Slack webhook",
    "https://hooks.slack.com/services/T00/B00/TOKENHERE",
    "https://hooks.slack.com/…",
  ],
  // Nothing secret in it, and the path still goes: the row's `target` is what identifies the record.
  ["an ordinary endpoint", "https://example.com/hook", "https://example.com/…"],
  // The port is part of the host and is kept: it identifies the endpoint and holds no secret.
  ["a port", "https://example.com:8443/a/b", "https://example.com:8443/…"],
  // Not `http(s)`, and the rule does not ask: userinfo is userinfo under any scheme.
  [
    "another scheme",
    "ftp://u:hunter2@files.example.com/x",
    "ftp://files.example.com/…",
  ],
];

describe("redactEndpoint", () => {
  for (const [what, url, redacted] of CASES) {
    test(`${what}: ${url}`, () => {
      expect(redactEndpoint(url)).toBe(redacted);
    });
  }

  test("a string that is not a URL yields nothing", () => {
    // Not parseable, so no part of it can be shown to be safe — including the whole of it.
    for (const bad of ["", "not a url", "///", "example.com/hook"]) {
      expect(redactEndpoint(bad)).toBe("…");
    }
  });

  test("no case in the table leaks the secret it carries", () => {
    // The table above is read by eye; this is the assertion that does not depend on that.
    const SECRETS = ["pw", "abc", "xyz", "sk-live-abc", "TOKENHERE", "hunter2"];
    for (const [what, url, redacted] of CASES) {
      for (const secret of SECRETS) {
        if (!url.includes(secret)) continue;
        expect(`${what} keeps ${secret}: ${redacted.includes(secret)}`).toBe(
          `${what} keeps ${secret}: false`,
        );
      }
    }
  });
});
