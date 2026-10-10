import { describe, expect, test } from "bun:test";
import en from "@/client/locales/en.json";
import ptBR from "@/client/locales/pt-BR.json";
import type {
  ConfigIssue,
  ConfigIssueKey,
} from "@/modules/agents/config-health";
import { configIssueMessage } from "@/modules/agents/config-health-message";
import { expectWaiverLedger } from "@/tests/utils/ledger";

// Every ConfigIssueKey the editor can render needs copy in every locale. Most lookups are dynamic
// (`t(\`editor.configIssue.${issue.key}\`)`), so a missing entry fails nothing: it falls back to
// "This feature is enabled but has no credential set", untrue for the gate contradictions and the
// missing-endpoint warning. The keys reach the extractor through magic comments, so `bun
// i18n:extract` DELETES a forgotten one as orphaned while `bun check` stays green. So each issue is
// rendered through the real renderer with a translator that answers only from the catalog, and a
// lookup the catalog cannot answer is reported instead of falling back.

// Every key of the union, typed as a Record so the compiler holds the list to the union in both
// directions: a key added there is a missing property here, a key removed is an excess one.
const ALL_KEYS: Record<ConfigIssueKey, true> = {
  model: true,
  modelNotRunnable: true,
  modelNoEndpoint: true,
  modelBadEndpoint: true,
  stt: true,
  tts: true,
  ttsNormalize: true,
  memoryModel: true,
  suggestionReviewModel: true,
  modelFallback: true,
  vision: true,
  decisions: true,
  guardrails: true,
  guardrailsFailing: true,
  contactAuth: true,
  contactAuthUnlockHandoff: true,
  contactAuthSilentRefusal: true,
  contactAuthNoUrl: true,
  knowledge: true,
  embedding: true,
  redirect: true,
  outOfHoursBoth: true,
  outOfHoursChatwoot: true,
  textCap: true,
};

// Keys raised ONLY for a credential that is pending or gone, never for a missing one: the gate runs
// fine without a credential, so `credIssue` is gated on the ref being present.
const CREDENTIAL_STATES_ONLY = new Set<ConfigIssueKey>(["contactAuth"]);

// Every shape an issue reaches the renderer in: one per key, the two credential states for the keys
// that only have those, and both arms of each branch that picks between two sentences.
function everyIssue(): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  for (const key of Object.keys(ALL_KEYS) as ConfigIssueKey[]) {
    if (CREDENTIAL_STATES_ONLY.has(key)) {
      out.push({ key, pending: true }, { key, unresolved: true });
    } else {
      out.push({ key });
    }
  }
  out.push({ key: "textCap", tab: "behavior" });
  return out;
}

function lookup(bag: unknown, key: string): string | undefined {
  let node: unknown = bag;
  for (const segment of key.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === "string" ? node : undefined;
}

// What the renderer asked for, and which of those the catalog could not answer.
function render(bag: unknown, issue: ConfigIssue, guardrailLastError = "") {
  const asked: string[] = [];
  const missing: string[] = [];
  const text = configIssueMessage(issue, {
    translate: (key) => {
      asked.push(key);
      const found = lookup(bag, key);
      if (found === undefined) missing.push(key);
      return found ?? "";
    },
    guardrailLastError,
  });
  return { text, asked, missing };
}

describe("config issue copy", () => {
  for (const [name, bag] of [
    ["en", en],
    ["pt-BR", ptBR],
  ] as const) {
    test(`${name} has copy for every issue the renderer can be handed`, () => {
      const missing = [
        ...everyIssue().flatMap((i) => render(bag, i).missing),
        // The guardrails branch picks its sentence on whether the last error is known.
        ...render(bag, { key: "guardrailsFailing" }, "timeout").missing,
      ];
      expect(missing).toEqual([]);
    });
  }

  // An entry identical to English is an untranslated placeholder, which is what `i18n:extract`
  // writes into every non-English file when a key is new.
  test("pt-BR is translated, not the English string copied over", () => {
    const untranslated = everyIssue().flatMap((issue) => {
      const a = render(en, issue);
      const b = render(ptBR, issue);
      return a.text !== "" && a.text === b.text ? a.asked : [];
    });
    expect(untranslated).toEqual([]);
  });

  // NOTE: a key moved into CREDENTIAL_STATES_ONLY stops being asked for its plain copy, so the list is
  // pinned at its size and may only shrink (tests/utils/ledger.ts).
  test("the ledger this file waives with may only shrink", () => {
    expectWaiverLedger("CREDENTIAL_STATES_ONLY", CREDENTIAL_STATES_ONLY, 1);
  });
});
