import { describe, expect, test } from "bun:test";

// The preload pins the signup policy to the defaults. The probe proves it in a child `bun test`
// that inherits a policy from where it beats `.env`, the shell. It reads `config` only, so it runs
// without the test database (ALLOW_NO_DB, and no test database URL to connect to).
const PROBE = "./tests/fixtures/signup-policy/defaults.probe.ts";

function probeUnder(policy: Record<string, string>) {
  const run = Bun.spawnSync({
    cmd: ["bun", "test", PROBE],
    env: {
      ...process.env,
      ALLOW_NO_DB: "1",
      TEST_MIGRATION_DATABASE_URL: "",
      TEST_APP_DATABASE_URL: "",
      ...policy,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: run.exitCode, output: run.stderr.toString() };
}

describe("the preload keeps a developer's signup policy out of the suite", () => {
  const policies: Record<string, Record<string, string>> = {
    "signup on": { SIGNUP_ENABLED: "true" },
    "an allowed domain": { ALLOWED_SIGNUP_DOMAINS: "example.com" },
    "an admin domain inside the allowed one": {
      ALLOWED_SIGNUP_DOMAINS: "example.com",
      ADMIN_SIGNUP_DOMAINS: "example.com",
    },
    // config.ts refuses to load this one: an admin domain outside the allowed list.
    "a policy config.ts would refuse": {
      ALLOWED_SIGNUP_DOMAINS: "example.com",
      ADMIN_SIGNUP_DOMAINS: "other.example",
    },
  };

  for (const [name, policy] of Object.entries(policies)) {
    test(name, () => {
      const { exitCode, output } = probeUnder(policy);
      expect(output).toContain("1 pass");
      expect(exitCode).toBe(0);
    }, 30_000);
  }
});
