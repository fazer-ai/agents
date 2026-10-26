import { expect, test } from "bun:test";
import config from "@/config";

// Not a test of its own (no `.test` in the name, so the suite never collects it):
// tests/signup-policy-pin.test.ts runs it in a child `bun test` with a signup policy exported, and
// it passes only if the preload kept that policy out of `config`.
test("the signup policy the suite sees is the default one", () => {
  expect({
    signupEnabled: config.signupEnabled,
    allowedSignupDomains: config.allowedSignupDomains,
    adminSignupDomains: config.adminSignupDomains,
  }).toEqual({
    signupEnabled: false,
    allowedSignupDomains: [],
    adminSignupDomains: [],
  });
});
