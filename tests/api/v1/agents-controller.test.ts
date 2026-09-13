import { describe, expect, test } from "bun:test";
import { agentUpdateSchema } from "@/modules/agents/service";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

// The agents controller constructs the full Elysia route graph at import time, which pulls in services
// that reach the prisma singleton. Mock it so importing the module is side-effect-free (no real DB).
setupPrismaMock();
const { parseExpectedUpdatedAt, splitAgentUpdateBody } = await import(
  "@/api/v1/agents.controller"
);

describe("parseExpectedUpdatedAt (optimistic-concurrency precondition boundary)", () => {
  test("a valid ISO string becomes the exact Date the service compares against", () => {
    const iso = "2026-06-17T12:34:56.000Z";
    const d = parseExpectedUpdatedAt(iso);
    expect(d).toBeInstanceOf(Date);
    expect((d as Date).toISOString()).toBe(iso);
  });

  test("omitted / empty → undefined (last-write-wins, the API/MCP default)", () => {
    expect(parseExpectedUpdatedAt(undefined)).toBeUndefined();
    expect(parseExpectedUpdatedAt("")).toBeUndefined();
  });

  test("an UNPARSEABLE timestamp degrades to undefined, NOT a throw (documented trade-off)", () => {
    // A malformed value drops the precondition rather than 400-ing; the editor must always send a real
    // ISO date or it silently loses overwrite protection. Pinned so the behavior can't change unnoticed.
    expect(parseExpectedUpdatedAt("not-a-date")).toBeUndefined();
    expect(parseExpectedUpdatedAt("2026-13-45T99:99:99Z")).toBeUndefined();
  });
});

describe("splitAgentUpdateBody (PATCH body → patch + precondition)", () => {
  test("strips expectedUpdatedAt so the strict update schema never sees it (regression)", () => {
    // The bug: the raw body (with expectedUpdatedAt) was forwarded to updateAgent, whose strict zod
    // schema rejected the extra key with `unrecognized_keys`. The split must hand the service a clean
    // patch + the precondition as a separate Date.
    const { patch, expectedUpdatedAt } = splitAgentUpdateBody({
      systemPrompt: "x",
      enabled: false,
      expectedUpdatedAt: "2026-06-17T12:00:00.000Z",
    });
    expect(patch).toEqual({ systemPrompt: "x", enabled: false });
    expect("expectedUpdatedAt" in patch).toBe(false);
    expect(expectedUpdatedAt).toBeInstanceOf(Date);
    // The cleaned patch is exactly what the strict schema accepts — the regression would re-fail here.
    expect(() => agentUpdateSchema.parse(patch)).not.toThrow();
  });

  test("a body without the precondition round-trips unchanged (last-write-wins)", () => {
    const { patch, expectedUpdatedAt } = splitAgentUpdateBody({
      systemPrompt: "y",
    });
    expect(patch).toEqual({ systemPrompt: "y" });
    expect(expectedUpdatedAt).toBeUndefined();
  });

  // #614: the opt-in that says "this bag is complete, drop what it omits" travels in the body and is
  // NOT part of the agent, so it has to come off the patch for the same reason expectedUpdatedAt
  // does — the strict schema refuses an unrecognized key.
  test("strips settingsMode and hands it back as the write's mode", () => {
    const { patch, settingsMode } = splitAgentUpdateBody({
      settings: { split: { enabled: false } },
      settingsMode: "replace",
    });
    expect(patch).toEqual({ settings: { split: { enabled: false } } });
    expect("settingsMode" in patch).toBe(false);
    expect(settingsMode).toBe("replace");
    expect(() => agentUpdateSchema.parse(patch)).not.toThrow();
  });

  test("a body that does not declare it gets undefined (the refusing default)", () => {
    const { settingsMode } = splitAgentUpdateBody({ systemPrompt: "y" });
    expect(settingsMode).toBeUndefined();
  });
});
