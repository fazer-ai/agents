import { describe, expect, test } from "bun:test";
import en from "@/client/locales/en.json";
import ptBR from "@/client/locales/pt-BR.json";
import { expectWaiverLedger } from "@/tests/utils/ledger";

// Every ConfigIssueKey the editor can render needs copy under `editor.configIssue.*`, in every
// locale. The lookup is dynamic (`t(\`editor.configIssue.${issue.key}\`)`), so a key with no entry
// fails nothing: it silently falls back to "This feature is enabled but has no credential set",
// which for several of these is not even true — the gate contradictions and the missing-endpoint
// warning have nothing to do with credentials. And since the keys reach the extractor through magic
// comments, forgetting one is invisible twice over: `bun i18n:extract` DELETES the hand-written
// entry as orphaned, and `bun check` stays green while the operator reads the wrong sentence. That
// is exactly how contactAuthNoUrl shipped wrong, which is why this file exists.
//
// Keys with a branch of their own in `issueMessage` are listed rather than pattern-matched, so a
// key that stops having one fails here until somebody writes its copy.
const HANDLED_ELSEWHERE = new Set([
  "textCap", // editor.configIssueTextCap / …NoField, interpolated
  "knowledge", // editor.configIssueKnowledge, interpolated
  "guardrailsFailing", // editor.configIssueGuardrailsFailing(Cause), interpolated
  "outOfHoursBoth", // editor.configIssueOutOfHoursBoth, interpolated
  "outOfHoursChatwoot", // editor.configIssueOutOfHoursChatwoot, interpolated
]);

// Keys raised ONLY for a credential that is pending or gone, never for a missing one — the gate
// runs fine without a credential, so `credIssue` is gated on the ref being present. Those two
// states read from their own namespaces, which is what the last test here checks.
const CREDENTIAL_STATES_ONLY = new Set(["contactAuth"]);

const source = await Bun.file(
  new URL("../../src/client/lib/configHealth.ts", import.meta.url),
).text();
const start = source.indexOf("export type ConfigIssueKey =");
const union = source.slice(start, source.indexOf(";", start));
const keys = [...union.matchAll(/\|\s*"([a-zA-Z]+)"/g)].map((m) => m[1] ?? "");

const copy = (
  locale: Record<string, unknown>,
  key: string,
): string | undefined => {
  const editor = locale.editor as Record<string, unknown> | undefined;
  const bag = editor?.configIssue as Record<string, unknown> | undefined;
  const value = bag?.[key];
  return typeof value === "string" ? value : undefined;
};

describe("config issue copy", () => {
  // The union is read out of the source, so the test is only honest while the regex still finds it.
  test("the key list is read from the source, and it found something", () => {
    expect(keys.length).toBeGreaterThan(10);
    expect(keys).toContain("contactAuthNoUrl");
    expect(keys).toContain("model");
  });

  for (const [name, bag] of [
    ["en", en],
    ["pt-BR", ptBR],
  ] as const) {
    test(`${name} has copy for every issue key`, () => {
      const missing = keys.filter(
        (k) =>
          !HANDLED_ELSEWHERE.has(k) &&
          !CREDENTIAL_STATES_ONLY.has(k) &&
          !copy(bag, k),
      );
      expect(missing).toEqual([]);
    });
  }

  // An entry identical to English is an untranslated placeholder, which is what `i18n:extract`
  // writes into every non-English file when a key is new.
  test("pt-BR is translated, not the English string copied over", () => {
    const untranslated = keys.filter(
      (k) =>
        !HANDLED_ELSEWHERE.has(k) &&
        !CREDENTIAL_STATES_ONLY.has(k) &&
        copy(en, k) !== undefined &&
        copy(en, k) === copy(ptBR, k),
    );
    expect(untranslated).toEqual([]);
  });

  // The other half of the same promise: a key excused from `configIssue.*` because it only ever
  // appears as a credential state has to actually HAVE those two states, or it falls back to the
  // generic sentence from a different direction.
  test("credential-state-only keys have pending and unresolved copy", () => {
    for (const key of CREDENTIAL_STATES_ONLY) {
      for (const [name, bag] of [
        ["en", en],
        ["pt-BR", ptBR],
      ] as const) {
        const editor = (bag as Record<string, unknown>).editor as Record<
          string,
          unknown
        >;
        for (const ns of ["configIssuePending", "configIssueUnresolved"]) {
          const entry = (editor[ns] as Record<string, unknown> | undefined)?.[
            key
          ];
          expect(`${name}.${ns}.${key}=${typeof entry}`).toBe(
            `${name}.${ns}.${key}=string`,
          );
        }
      }
    }
  });

  // Both lists above are subtracted from a key set READ OUT OF `configHealth.ts`, so appending to
  // either one silences a key that has no copy, and nothing here would notice. Pinned at the size
  // each was argued into: tests/utils/ledger.ts, issue #293.
  test("the ledgers this file waives with may only shrink", () => {
    expectWaiverLedger("HANDLED_ELSEWHERE", HANDLED_ELSEWHERE, 5);
    expectWaiverLedger("CREDENTIAL_STATES_ONLY", CREDENTIAL_STATES_ONLY, 1);
  });
});
