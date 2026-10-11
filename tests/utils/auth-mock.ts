import { mock } from "bun:test";

type AuthModule = typeof import("@/client/contexts/AuthContext");

const store = globalThis as { __realAuthContext?: AuthModule };

// Replaces only what a test names in `@/client/contexts/AuthContext` and keeps every other export
// real. A module mock lasts for the rest of the process, so a factory that returns two exports leaves
// the next file in the same worker without `AuthContext` or `useTtsCheckInfo`, and it fails at import
// with an error that names neither file. The real exports are copied on the first call, which comes
// before any mock of this module because every mock of it goes through here
// (tests/lib/auth-mock-sweep.test.ts).
export async function mockAuthContext(
  overrides: Record<string, unknown>,
): Promise<void> {
  store.__realAuthContext ??= {
    ...(await import("@/client/contexts/AuthContext")),
  };
  const real = store.__realAuthContext;
  mock.module("@/client/contexts/AuthContext", () => ({
    ...real,
    ...overrides,
  }));
}
