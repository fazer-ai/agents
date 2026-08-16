import { describe, expect, test } from "bun:test";
import { buildOnboardingEnv } from "@/../scripts/gen-onboarding-env";

describe("buildOnboardingEnv", () => {
  test("derives the two-role URLs + secrets from PUBLIC_URL", () => {
    const env = buildOnboardingEnv({
      publicUrl: "https://agents.example.com/",
    });

    // Trailing slash trimmed.
    expect(env.PUBLIC_URL).toBe("https://agents.example.com");

    // Superuser URL uses the postgres user; runtime URL uses the app role; they differ.
    const migration = new URL(env.MIGRATION_DATABASE_URL);
    const runtime = new URL(env.DATABASE_URL);
    expect(migration.username).toBe("postgres");
    expect(runtime.username).toBe("fazerai_app");
    expect(migration.password).not.toBe(runtime.password);
    expect(migration.password.length).toBeGreaterThan(0);
    expect(runtime.password.length).toBeGreaterThan(0);

    // Same host/port/db on both; default service host is the compose service name.
    expect(migration.hostname).toBe("postgres");
    expect(runtime.hostname).toBe("postgres");
    expect(migration.port).toBe("5432");
    expect(runtime.pathname).toBe("/fazerai_agents_db");

    // The checkpointer pool is the runtime (non-superuser) role, never the migration URL.
    expect(env.LANGGRAPH_DATABASE_URL).toBe(env.DATABASE_URL);

    // Postgres container creds match the migration (superuser) URL.
    expect(env.POSTGRES_USER).toBe("postgres");
    expect(env.POSTGRES_PASSWORD).toBe(migration.password);

    // ENCRYPTION_KEY must be comfortably over the 32-char minimum (32 bytes → 64 hex).
    expect(env.ENCRYPTION_KEY.length).toBe(64);
    expect(env.JWT_SECRET.length).toBe(64);
  });

  test("honors host/port/name/user overrides", () => {
    const env = buildOnboardingEnv({
      publicUrl: "https://x.example.com",
      dbHost: "db",
      dbPort: 5433,
      dbName: "mydb",
      pgUser: "owner",
      appUser: "app_role",
    });
    const runtime = new URL(env.DATABASE_URL);
    expect(runtime.hostname).toBe("db");
    expect(runtime.port).toBe("5433");
    expect(runtime.pathname).toBe("/mydb");
    expect(runtime.username).toBe("app_role");
    expect(new URL(env.MIGRATION_DATABASE_URL).username).toBe("owner");
  });

  test("rejects a PUBLIC_URL without a scheme", () => {
    expect(() =>
      buildOnboardingEnv({ publicUrl: "agents.example.com" }),
    ).toThrow(/must start with http/);
  });

  test("rejects an unsafe app role name", () => {
    expect(() =>
      buildOnboardingEnv({ publicUrl: "https://x.com", appUser: 'a"; DROP' }),
    ).toThrow(/app role name/);
  });

  test("generates a fresh secret each run", () => {
    const a = buildOnboardingEnv({ publicUrl: "https://x.com" });
    const b = buildOnboardingEnv({ publicUrl: "https://x.com" });
    expect(a.JWT_SECRET).not.toBe(b.JWT_SECRET);
    expect(new URL(a.DATABASE_URL).password).not.toBe(
      new URL(b.DATABASE_URL).password,
    );
  });
});
