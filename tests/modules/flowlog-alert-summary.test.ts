import { describe, expect, test } from "bun:test";
import { EMPTY_COMPLETION_MESSAGE } from "@/graph/empty-completion";
import { preconditionFlowEvent } from "@/graph/tools/precondition";
import { alertSummary } from "@/modules/flowlog/alerts";
import type { FlowEvent } from "@/modules/flowlog/service";
import type { FlowLevel } from "@/modules/flowlog/stages";
import { spendCeilingFlowEvent } from "@/modules/spend-ceiling/service";

// The alert body, issue #610. The first three events are the ones a production Discord channel
// received as `[observe via openai] skipped`, `[delivery] ok` and `[delivery] error (×23)`, with the
// detail each row carried, so the expected bodies are what those alerts should have said.

type AlertEvent = FlowEvent & { level: FlowLevel };

describe("alertSummary", () => {
  test("a superseded observation names the skip, not the trigger", () => {
    const ev: AlertEvent = {
      stage: "observe",
      level: "warn",
      status: "skipped",
      provider: "openai",
      model: "gpt-5.6-luna",
      detail: { reason: "burst", skipped: "superseded", messagesRead: 12 },
    };
    expect(alertSummary(ev)).toBe("[observe via openai] skipped: superseded");
  });

  test("a delivery recovered on retry says recovered, not ok", () => {
    const ev: AlertEvent = {
      stage: "delivery",
      level: "warn",
      status: "ok",
      detail: {
        outcome: "recovered",
        deliveryEvent: "message_created",
        deliveryId: 88,
        messageId: 13990249,
        conversationId: 4412,
      },
    };
    expect(alertSummary(ev)).toBe("[delivery] ok: recovered");
  });

  test("a stranded delivery says stranded, and on which status", () => {
    const ev: AlertEvent = {
      stage: "delivery",
      level: "error",
      status: "error",
      detail: {
        outcome: "stranded",
        deliveryEvent: "message_created",
        strandedOn: "PROCESSING",
        messageId: 13990250,
        conversationId: 4413,
        knownToMirror: true,
      },
    };
    expect(alertSummary(ev)).toBe(
      "[delivery] error: stranded strandedOn=PROCESSING",
    );
  });

  test("an error with text keeps the text, whatever detail says", () => {
    const ev: AlertEvent = {
      stage: "generate",
      level: "error",
      status: "error",
      provider: "openai",
      errorMessage: "model exploded",
      detail: { outcome: "stranded" },
    };
    expect(alertSummary(ev)).toBe("[generate via openai] model exploded");
  });

  test("a turn answered by the fallback labels the reason, so it does not read as a timeout", () => {
    const ev: AlertEvent = {
      stage: "observe",
      level: "warn",
      status: "ok",
      provider: "openrouter",
      detail: {
        reason: "burst",
        fallbackFrom: "openai",
        fallbackReason: "HTTP 503",
      },
    };
    expect(alertSummary(ev)).toBe(
      "[observe via openrouter] ok: fallbackReason=HTTP 503",
    );
  });

  test("the empty-completion reason is a vocabulary word too", () => {
    const ev: AlertEvent = {
      stage: "generate",
      level: "warn",
      status: "ok",
      provider: "openrouter",
      detail: {
        fallbackFrom: "openai",
        fallbackReason: EMPTY_COMPLETION_MESSAGE,
      },
    };
    expect(alertSummary(ev)).toBe(
      `[generate via openrouter] ok: fallbackReason=${EMPTY_COMPLETION_MESSAGE}`,
    );
  });

  test("a flag whose value is a count is named by its key", () => {
    const ev: AlertEvent = {
      stage: "generate",
      level: "warn",
      status: "ok",
      provider: "openai",
      detail: { toolLimitHit: 3, toolCalls: 3 },
    };
    expect(alertSummary(ev)).toBe("[generate via openai] ok: toolLimitHit");
  });

  test("only the first cause is named", () => {
    const ev: AlertEvent = {
      stage: "contact_auth",
      level: "warn",
      status: "skipped",
      detail: { outcome: "no_identity", shared: false, reason: "no_contact" },
    };
    expect(alertSummary(ev)).toBe("[contact_auth] skipped: no_identity");
  });

  test("outside observe, reason is the cause", () => {
    const ev: AlertEvent = {
      stage: "tts",
      level: "warn",
      status: "skipped",
      detail: { reason: "no_voice" },
    };
    expect(alertSummary(ev)).toBe("[tts] skipped: no_voice");
  });

  // The builders the emit sites use, so a builder that renames its key breaks this file and not an
  // operator's night.
  test("the spend ceiling says it is over", () => {
    const ev = spendCeilingFlowEvent(
      { state: "over", usedUsd: 12, ceilingUsd: 10 },
      "inbox",
    );
    expect(alertSummary({ ...ev, level: ev.level ?? "info" })).toBe(
      "[spend_ceiling] skipped: over",
    );
  });

  test("an unreadable precondition names the phase, never the error class or the key", () => {
    const ev = preconditionFlowEvent({
      tool: "transferir",
      cond: {
        kind: "attribute",
        scope: "contact",
        key: "cpf_validado",
        equals: "sim",
      },
      reason: "unreadable",
      err: new TypeError("connection to postgres://user:pw@db/app failed"),
    });
    const body = alertSummary({ ...ev, level: ev.level ?? "info" });
    expect(body).toBe("[tool] error: phase=precondition_unreadable");
  });

  test("with nothing to explain it, the body is the status as before", () => {
    const ev: AlertEvent = {
      stage: "route",
      level: "warn",
      status: "skipped",
      detail: { chatwootInboxId: 12 },
    };
    expect(alertSummary(ev)).toBe("[route] skipped");
    expect(alertSummary({ stage: "route", level: "warn" })).toBe(
      "[route] warn",
    );
  });

  // THE FENCE, pinned by values that must never reach an alert. Each allowlisted key is fed
  // something that is not a vocabulary word, and the keys outside the list carry the payloads a tool
  // line really has when the operator turns tool values on.
  test("text, addresses and unlisted keys never reach the body", () => {
    const ev: AlertEvent = {
      stage: "tool",
      level: "warn",
      status: "error",
      detail: {
        args: { cpf: "123.456.789-00", nome: "Zebrafina Quixotesca" },
        output: "cliente_zebrafina",
        skipped: "zebrafina@example.com",
        failed: "https://example.com/zebrafina",
        outcome: "cancel for Zebrafina",
        state: "a\nb",
        reason: "",
        fallbackUnavailable: "Zebrafina Quixotesca",
        phase: { nested: "zebrafina" },
        strandedOn: ["zebrafina"],
      },
    };
    const body = alertSummary(ev);
    expect(body).toBe("[tool] error");
    expect(body.toLowerCase()).not.toContain("zebrafina");
  });

  test("the body stays bounded however long the error is", () => {
    const body = (n: number) =>
      alertSummary({
        stage: "generate",
        level: "error",
        errorMessage: "x".repeat(n),
      });
    expect(body(20_000).length).toBe(body(2_000).length);
    expect(body(2_000).length).toBeLessThan(320);
  });
});
