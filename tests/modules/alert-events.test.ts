import { describe, expect, test } from "bun:test";
import { alertEventsOf } from "@/modules/flowlog/alerts";
import { ALERT_EVENTS, isAlertEvent } from "@/modules/flowlog/events";

// Which events a warn or error line is of, the question a channel's left-out list is asked.

describe("alertEventsOf", () => {
  test("the tool-limit line is the tool limit", () => {
    expect(
      alertEventsOf({
        stage: "generate",
        level: "warn",
        status: "ok",
        detail: { toolLimitHit: 10, toolCalls: 17 },
      }),
    ).toEqual(["tool_limit"]);
  });

  test("the fallback line is a fallback, and its primary's failure class does not make it a provider failure", () => {
    expect(
      alertEventsOf({
        stage: "generate",
        level: "warn",
        status: "ok",
        provider: "anthropic",
        detail: {
          fallbackFrom: "openai",
          fallbackReason: "HTTP 503",
          primaryFailure: "HTTP 503",
        },
      }),
    ).toEqual(["model_fallback"]);
  });

  test("a failure class or a missing fallback on a stage that calls a model is a provider failure", () => {
    for (const stage of [
      "generate",
      "vision",
      "stt",
      "tts",
      "normalize",
      "embed",
      "observe",
    ] as const) {
      expect(
        alertEventsOf({
          stage,
          level: "error",
          status: "error",
          detail: { failure: "HTTP 401" },
          errorMessage: "unauthorized",
        }),
      ).toEqual(["provider_failure"]);
    }
    expect(
      alertEventsOf({
        stage: "generate",
        level: "error",
        status: "error",
        detail: { fallbackUnavailable: "not_configured" },
      }),
    ).toEqual(["provider_failure"]);
  });

  test("the same failure class on a stage that calls no model is no provider failure", () => {
    for (const stage of ["split", "tool"] as const) {
      expect(
        alertEventsOf({
          stage,
          level: "error",
          status: "error",
          detail: { failure: "HTTP 502" },
          errorMessage: "bad gateway",
        }),
      ).toEqual([]);
    }
  });

  test("an empty response retried, and a turn that ended without a reply", () => {
    expect(
      alertEventsOf({
        stage: "generate",
        level: "warn",
        status: "ok",
        detail: { retriedEmptyResponse: 1, willRetry: true },
      }),
    ).toEqual(["empty_response"]);
    expect(
      alertEventsOf({
        stage: "generate",
        level: "warn",
        status: "ok",
        detail: {
          silenceUnexplained: true,
          resolveDiscarded: false,
          silenceRetried: true,
        },
      }),
    ).toEqual(["no_reply"]);
    expect(
      alertEventsOf({
        stage: "generate",
        level: "warn",
        status: "ok",
        detail: { silenceTokenSuppressed: true },
      }),
    ).toEqual(["no_reply"]);
  });

  test("a line can be several events, and a `false` flag is none", () => {
    expect(
      alertEventsOf({
        stage: "generate",
        level: "warn",
        status: "ok",
        detail: { toolLimitHit: 10, fallbackReason: "timeout" },
      }),
    ).toEqual(["tool_limit", "model_fallback"]);
    expect(
      alertEventsOf({
        stage: "generate",
        level: "warn",
        status: "ok",
        detail: { toolLimitHit: false },
      }),
    ).toEqual([]);
  });

  test("a line the stage list already tells apart is no event", () => {
    expect(
      alertEventsOf({
        stage: "dead_letter",
        level: "error",
        status: "error",
        detail: { unit: "job", kind: "FOLLOWUP" },
        errorMessage: "job exhausted its retries",
      }),
    ).toEqual([]);
    expect(
      alertEventsOf({
        stage: "capacity",
        level: "warn",
        detail: { waitedOn: "model_semaphore" },
      }),
    ).toEqual([]);
  });
});

describe("the vocabulary", () => {
  test("is closed and spelled the way the wire spells it", () => {
    expect([...ALERT_EVENTS]).toEqual([
      "tool_limit",
      "model_fallback",
      "provider_failure",
      "empty_response",
      "no_reply",
    ]);
    expect(isAlertEvent("tool_limit")).toBe(true);
    expect(isAlertEvent("toolLimitHit")).toBe(false);
    expect(isAlertEvent("generate")).toBe(false);
  });
});
