import { describe, expect, test } from "bun:test";
import type { ConfigIssue } from "@/modules/agents/config-health";
import { configIssueTranslator } from "@/modules/agents/config-health-copy";
import { configIssueMessage } from "@/modules/agents/config-health-message";

// Which locale entry an issue reads, and what gets substituted into it. This used to live inside the
// editor component, where the only way to exercise it was to mount the page — so the four keys that
// take VALUES were covered by nobody, in either reader.
//
// The server's translator is the one under test here rather than a stub, because it is the half that
// is new: the console gets interpolation from i18next, and this side does it in twelve lines. A
// placeholder that survives is a sentence reading "{{failures}} of the Checks could not run", which
// no assertion about keys would catch.
const en = configIssueTranslator("en");
const pt = configIssueTranslator("pt-BR");

const message = (
  issue: ConfigIssue,
  extra: Partial<Parameters<typeof configIssueMessage>[1]> = {},
) => configIssueMessage(issue, { translate: en, ...extra });

describe("configIssueMessage", () => {
  test("a capped field names the field and both numbers", () => {
    const out = message({
      key: "textCap",
      tab: "behavior",
      field: "handoff.message",
      length: 1200,
      max: 1000,
    });
    expect(out).toContain("handoff.message");
    expect(out).toContain("1200");
    expect(out).toContain("1000");
    expect(out).not.toContain("{{");
  });

  // The same issue with no tab is a different sentence, not the same one with a field missing: there
  // is no control in the console for it, so the fix is the API and the copy has to say so.
  test("a capped field with no editor control gets the other sentence", () => {
    const withTab = message({
      key: "textCap",
      tab: "behavior",
      field: "f",
      length: 2,
      max: 1,
    });
    const without = message({ key: "textCap", field: "f", length: 2, max: 1 });
    expect(without).not.toBe(withTab);
    expect(without).toContain("API");
  });

  test("a knowledge base is named", () => {
    const out = message({
      key: "knowledge",
      knowledgeBaseId: "7",
      knowledgeBaseName: "Catálogo 2026",
    });
    expect(out).toContain("Catálogo 2026");
    expect(out).not.toContain("{{");
  });

  // The count is the point of this line, and the window and the vendor's own words arrive from the
  // health snapshot rather than from the issue — so they are exactly what a renderer forgets to pass.
  test("a failing guardrail carries the count, the window and the cause", () => {
    const out = message(
      { key: "guardrailsFailing", failures: 12, lastFailureAt: "2026-09-01" },
      {
        translate: en,
        guardrailWindowHours: 24,
        guardrailLastError: "400 temperature is not supported",
        formatWhen: () => "3 hours ago",
      },
    );
    expect(out).toContain("12");
    expect(out).toContain("24");
    expect(out).toContain("3 hours ago");
    expect(out).toContain("400 temperature is not supported");
    expect(out).not.toContain("{{");
  });

  test("with no cause from the vendor, the sentence changes rather than trailing off", () => {
    const withCause = message(
      { key: "guardrailsFailing", failures: 1 },
      { translate: en, guardrailLastError: "boom" },
    );
    const without = message(
      { key: "guardrailsFailing", failures: 1 },
      { translate: en, guardrailLastError: "" },
    );
    expect(withCause).toContain("boom");
    expect(without).not.toContain("boom");
    expect(without).not.toBe(withCause);
    expect(without).not.toContain("{{");
  });

  // A timestamp with no formatter is the JSON caller's case: it gets the instant, not "-".
  test("an unformatted timestamp survives as itself", () => {
    const out = message(
      { key: "guardrailsFailing", failures: 1, lastFailureAt: "2026-09-01" },
      { translate: en },
    );
    expect(out).toContain("2026-09-01");
  });

  test("the out-of-hours collision names the inboxes", () => {
    const both = message({
      key: "outOfHoursBoth",
      inboxNames: ["Vendas", "Suporte"],
    });
    const chatwootOnly = message({
      key: "outOfHoursChatwoot",
      inboxNames: ["Vendas", "Suporte"],
    });
    expect(both).toContain("Vendas, Suporte");
    expect(chatwootOnly).toContain("Vendas, Suporte");
    // Two spellings of one collision, because the customer sees two different things.
    expect(both).not.toBe(chatwootOnly);
  });

  // The three credential states read from three different namespaces. They are keyed dynamically, so
  // a missing entry is not an error anywhere — it is the generic fallback, silently.
  test("pending, unresolved and missing are three different sentences", () => {
    const base = { key: "stt" } as const;
    const missing = message({ ...base });
    const pending = message({ ...base, pending: true, vaultId: "7" });
    const unresolved = message({ ...base, unresolved: true });
    expect(new Set([missing, pending, unresolved]).size).toBe(3);
    // And none of them is the generic default the renderer falls back to.
    expect(missing).not.toBe(
      "This feature is enabled but has no credential set.",
    );
    expect(pending).not.toBe(
      "This credential is referenced but not filled in yet.",
    );
  });

  test("the translator answers in the language it was built for", () => {
    const key = { key: "guardrails" } as const;
    expect(message(key, { translate: pt })).not.toBe(
      message(key, { translate: en }),
    );
  });

  // An unknown key has to degrade to the English sentence the caller supplied, not to the key itself:
  // this is the one behaviour the console gets from i18next for free and the server had to reproduce.
  test("a key with no catalog entry falls back to the supplied sentence", () => {
    expect(en("editor.configIssue.notAKeyAnybodyWrote", "fallback text")).toBe(
      "fallback text",
    );
    expect(
      en("editor.configIssue.notAKeyAnybodyWrote", "held {{n}} items", {
        n: 3,
      }),
    ).toBe("held 3 items");
  });
});
