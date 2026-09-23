import { describe, expect, test } from "bun:test";
import { configForBootLog } from "@/api/lib/logger";
import config from "@/config";

const MASK = "********";

// Every string the boot log prints in clear, by path. A new string field fails the fence below until
// it is classified: either its name matches the secret pattern, or it is added here as readable.
const READABLE_STRING_FIELDS = [
  "packageInfo.name",
  "packageInfo.version",
  "publicUrl",
  "env",
  "edition",
  "logLevel",
  "documentsStorageDir",
  "brandingStorageDir",
  "corsOrigin",
  "cdnUrl",
  "googleClientId",
  "allowedSignupDomains",
  "adminSignupDomains",
  "ttsCheck.url",
  "ttsCheck.mode",
  "ssrf.internalTargets",
  "hub.url",
  "hub.updateCheckUrl",
];

function clearStrings(obj: unknown, path = "", out: string[] = []): string[] {
  if (typeof obj === "string") {
    if (obj !== MASK) out.push(path);
  } else if (Array.isArray(obj)) {
    out.push(path);
  } else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      clearStrings(v, path ? `${path}.${k}` : k, out);
    }
  }
  return out;
}

describe("configForBootLog", () => {
  test.each([
    ["a 64-character token", "a".repeat(32) + "b".repeat(32)],
    ["a token short enough to escape the 50-character clip", "short-token-123"],
  ])("never prints the audio detector token, for %s", (_, token) => {
    const rendered = JSON.stringify(
      configForBootLog({
        ttsCheck: {
          url: "http://audio-check:8000",
          mode: "shadow",
          token,
          timeoutMs: 60000,
        },
      }),
    );
    expect(rendered).not.toContain(token.slice(0, 8));
    expect(JSON.parse(rendered).ttsCheck).toEqual({
      url: "http://audio-check:8000",
      mode: "shadow",
      token: MASK,
      timeoutMs: 60000,
    });
  });

  test("masks the secrets the old list named, at any depth", () => {
    const secrets = {
      apiKey: "k1",
      secret: "s1",
      jwtSecret: "j1",
      mcpJwtSecret: "m1",
      encryptionKey: "e1",
      databaseUrl: "postgres://u:p@h/db",
      langgraphDatabaseUrl: "postgres://u:p@h/lg",
    };
    const out = configForBootLog({ ...secrets, nested: { ...secrets } });
    for (const key of Object.keys(secrets)) {
      expect(out[key]).toBe(MASK);
      expect((out.nested as Record<string, unknown>)[key]).toBe(MASK);
    }
  });

  test("masks a secret added later by its name, with no list to join", () => {
    const out = configForBootLog({
      vendor: { apiToken: "t", clientSecret: "c", password: "p" },
    });
    expect(out.vendor).toEqual({
      apiToken: MASK,
      clientSecret: MASK,
      password: MASK,
    });
  });

  test("keeps a flag with a secret-sounding name readable", () => {
    const out = configForBootLog({
      setupTokenRequired: true,
      rateLimit: { credentialMax: 20 },
    });
    expect(out).toEqual({
      setupTokenRequired: true,
      rateLimit: { credentialMax: 20 },
    });
  });

  test("every string the real config prints in clear is one classified as readable", () => {
    expect(
      clearStrings(configForBootLog({ ...config, port: 1 })).sort(),
    ).toEqual([...READABLE_STRING_FIELDS].sort());
  });
});
