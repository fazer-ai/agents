// The per-test (and per-hook) timeout tests/setup.ts sets for the whole suite. Kept here so the waits
// that must outlast it, or fit inside it, are derived from the same number (see
// tests/utils/role-catalog-lock.ts).
export const TEST_TIMEOUT_MS = 30_000;
