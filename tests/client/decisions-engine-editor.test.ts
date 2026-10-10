import { describe, expect, test } from "bun:test";
import { credentialCompat } from "@/client/lib/credentialCompat";
import {
  type DecisionRuleForm,
  decisionsToForm,
  decisionsToStored,
  nativeToolsGranted,
  ruleToolNotGranted,
  startingDecisionsForm,
  withNativeToolGranted,
} from "@/client/pages/agents/decisionsFormState";
import {
  DECISIONS_STARTERS,
  type StarterNames,
  starterApplied,
  starterFits,
  withStarter,
} from "@/client/pages/agents/decisionsStarters";
import {
  watcherIssueUsed,
  watcherSectionUsed,
  watcherTabKeys,
} from "@/client/pages/agents/editorTabs";
import {
  decisionsBodyOf,
  decisionsHeadOf,
  observationToForm,
  observationToStored,
  timingOf,
  withDecisionsOf,
  withDraftEngine,
  withEngine,
} from "@/client/pages/agents/observationFormState";
import { decisionsIssues, RULES_MAX } from "@/modules/decisions/config";
import { credentialServes } from "@/modules/vault/secret-types";

// The monitoring agent's editor follows the engine (agents#1224): the decision setup (engine,
// classifier, questions, rules, rehearsal or live) is one thing drawn on General and on its own tab,
// saved apart from the Behavior tab's timing fields; a new decisions agent starts from ready
// questions instead of an empty list; and a rule says when its tool is not granted.

const BLOCK = {
  provider: "typesafe",
  credentialRef: "vault:12",
  questions: [
    { name: "pede_reembolso", type: "yes_no", instructions: "Pede reembolso?" },
  ],
  rules: [
    {
      when: [{ question: "pede_reembolso", minProbability: 0.7 }],
      action: { tool: "set_labels", args: { add: ["reembolso"] } },
    },
  ],
  apply: "shadow",
};
const STORED = {
  monitoring: {
    engine: "decisions",
    decisions: BLOCK,
    analysis: "incremental",
    window: { messages: 20 },
    debounce: { windowSeconds: 20, maxWindowSeconds: 60 },
  },
};

describe("the Behavior save and the decision setup are written apart", () => {
  test("a Behavior save writes the timing it edits and the decision setup as stored", () => {
    const synced = observationToForm(STORED);
    const form = observationToForm(STORED);
    form.windowSeconds = "0";
    form.engine = "llm";
    if (!form.decisions) throw new Error("fixture");
    form.decisions = { ...form.decisions, apply: "enforce" };
    form.decisionsEdited = true;
    const out = observationToStored(withDecisionsOf(form, synced));
    expect(out.debounce.windowSeconds).toBe(0);
    expect(out.engine).toBe("decisions");
    expect(out.decisions).toEqual(BLOCK);
  });

  test("a decisions save writes the setup it edits and the timing as stored", () => {
    const synced = observationToForm(STORED);
    const form = observationToForm(STORED);
    form.windowSeconds = "5";
    form.analysis = "on_resolve";
    if (!form.decisions) throw new Error("fixture");
    form.decisions = { ...form.decisions, apply: "enforce" };
    form.decisionsEdited = true;
    const out = observationToStored(withDecisionsOf(synced, form));
    expect(out.debounce.windowSeconds).toBe(20);
    expect(out.analysis).toBe("incremental");
    expect(out.decisions).toEqual({ ...BLOCK, apply: "enforce" });
  });

  test("the timing and the setup are told apart for the unsaved marks", () => {
    const a = observationToForm(STORED);
    const b = observationToForm(STORED);
    b.windowSeconds = "3";
    expect(timingOf(a)).not.toBe(timingOf(b));
    expect(decisionsHeadOf(a)).toBe(decisionsHeadOf(b));
    expect(decisionsBodyOf(a)).toBe(decisionsBodyOf(b));
    const c = observationToForm(STORED);
    c.engine = "llm";
    expect(decisionsHeadOf(a)).not.toBe(decisionsHeadOf(c));
    expect(decisionsBodyOf(a)).toBe(decisionsBodyOf(c));
    const d = observationToForm(STORED);
    if (!d.decisions) throw new Error("fixture");
    d.decisions = { ...d.decisions, apply: "enforce" };
    expect(decisionsHeadOf(a)).toBe(decisionsHeadOf(d));
    expect(decisionsBodyOf(a)).not.toBe(decisionsBodyOf(d));
  });
});

describe("switching to questions and rules and back", () => {
  test("leaves nothing unsaved when the draft could not run", () => {
    const stored = observationToForm({});
    const there = withEngine(stored, "decisions");
    expect(decisionsHeadOf(there)).not.toBe(decisionsHeadOf(stored));
    const back = withEngine(
      { ...there, decisionsEdited: true } as typeof there,
      "llm",
    );
    expect(decisionsHeadOf(back)).toBe(decisionsHeadOf(stored));
    expect(decisionsBodyOf(back)).toBe(decisionsBodyOf(stored));
  });
});

describe("the tabs of a monitoring agent follow its engine", () => {
  test("the language model keeps Knowledge and has no questions tab", () => {
    const tabs = watcherTabKeys("llm");
    expect(tabs.has("knowledge")).toBe(true);
    expect(tabs.has("decisions")).toBe(false);
    expect(tabs.has("tools")).toBe(true);
  });

  test("questions and rules drop Knowledge, keep Tools and gain their own tab", () => {
    const tabs = watcherTabKeys("decisions");
    expect(tabs.has("knowledge")).toBe(false);
    expect(tabs.has("decisions")).toBe(true);
    expect(tabs.has("tools")).toBe(true);
    expect(tabs.has("guardrails")).toBe(false);
    expect(tabs.has("playground")).toBe(false);
  });
});

const NAMES: StarterNames = {
  sentimentLevels: [
    "muito negativo",
    "negativo",
    "neutro",
    "positivo",
    "muito positivo",
  ],
  sentimentLabels: [
    "sentimento-muito-negativo",
    "sentimento-negativo",
    "sentimento-neutro",
    "sentimento-positivo",
    "sentimento-muito-positivo",
  ],
  subjectOptions: ["duvida", "reclamacao", "cancelamento", "outro"],
  subjectAttribute: "assunto",
  humanLabel: "quer-humano",
  sentimentQuestion: "Qual é o sentimento do cliente?",
  subjectQuestion: "Qual é o assunto principal?",
  humanQuestion: "O cliente pede para falar com uma pessoa?",
};

describe("the starting points of a decisions agent", () => {
  const keyed = () => ({
    ...startingDecisionsForm(),
    credentialRef: "vault:3",
  });

  test("each one alone makes a block the server accepts", () => {
    for (const kind of DECISIONS_STARTERS) {
      const form = withStarter(keyed(), kind, NAMES);
      expect(decisionsIssues(decisionsToStored(form))).toEqual([]);
      expect(form.questions.length).toBe(1);
      expect(form.rules.length).toBeGreaterThan(0);
      expect(starterApplied(form, kind)).toBe(true);
    }
  });

  test("all three together are accepted, and adding one twice adds nothing", () => {
    let form = keyed();
    for (const kind of DECISIONS_STARTERS)
      form = withStarter(form, kind, NAMES);
    expect(decisionsIssues(decisionsToStored(form))).toEqual([]);
    const names = form.questions.map((q) => q.name);
    expect(new Set(names).size).toBe(3);
    const again = withStarter(form, "sentiment", NAMES);
    expect(again.questions.length).toBe(3);
    expect(again.rules.length).toBe(form.rules.length);
  });

  test("sentiment writes one label per level and takes the other four off", () => {
    const form = withStarter(keyed(), "sentiment", NAMES);
    const labelRules = form.rules.filter((r) => r.tool === "set_labels");
    expect(labelRules.length).toBe(5);
    const first = labelRules[0]?.args as { add: string[]; remove: string[] };
    expect(first.add).toEqual(["sentimento-muito-negativo"]);
    expect(first.remove.length).toBe(4);
  });

  test("a starter whose rules would pass the limit is not offered and adds nothing", () => {
    let form = keyed();
    const filler = (n: number): DecisionRuleForm => ({
      key: `f${n}`,
      origin: null,
      when: [],
      tool: "set_labels",
      args: {},
    });
    form = {
      ...form,
      rules: Array.from({ length: RULES_MAX - 4 }, (_, n) => filler(n)),
    };
    expect(starterFits(form, "sentiment", NAMES)).toBe(false);
    expect(withStarter(form, "sentiment", NAMES)).toBe(form);
    expect(starterFits(form, "human", NAMES)).toBe(true);
    expect(withStarter(form, "human", NAMES).rules.length).toBe(RULES_MAX - 3);
  });

  test("a starter added to a stored block keeps the stored questions and rules", () => {
    const base = decisionsToForm(BLOCK);
    if (!base) throw new Error("fixture");
    const form = withStarter(base, "human", NAMES);
    expect(form.questions.map((q) => q.name)[0]).toBe("pede_reembolso");
    expect(form.rules.length).toBe(2);
    expect(form.rules[0]?.origin).toBe(0);
    expect(form.rules[1]?.origin).toBeNull();
  });
});

describe("a rule whose tool the agent was not granted", () => {
  const rule = (tool: string): DecisionRuleForm => ({
    key: "r",
    origin: 0,
    when: [],
    tool,
    args: {},
  });

  test("is said apart from one that runs", () => {
    const granted = new Set(["set_labels"]);
    expect(ruleToolNotGranted(rule("set_labels"), granted)).toBe(false);
    expect(ruleToolNotGranted(rule("private_note"), granted)).toBe(true);
  });

  test("a rule with no tool yet is incomplete, not ungranted", () => {
    expect(ruleToolNotGranted(rule(""), new Set())).toBe(false);
  });
});

describe("the native tools a grant set allows", () => {
  const ALL = ["set_labels", "private_note", "handoff_to_human"];

  test("no NATIVE row allows every native tool, a row is its allowlist", () => {
    expect([...nativeToolsGranted([], ALL)].sort()).toEqual([...ALL].sort());
    expect([
      ...nativeToolsGranted(
        [{ source: "NATIVE", enabledTools: ["private_note"] }],
        ALL,
      ),
    ]).toEqual(["private_note"]);
    expect(
      nativeToolsGranted([{ source: "NATIVE", enabledTools: [] }], ALL).size,
    ).toBe(0);
  });

  test("allowing one tool adds it to the row and keeps the other grants", () => {
    const grants = [
      { source: "HTTP", toolDefinitionId: "t1" },
      { source: "NATIVE", enabledTools: ["private_note"] },
    ];
    const next = withNativeToolGranted(grants, "set_labels");
    expect(next[0]).toEqual(grants[0]);
    expect(next[1]?.enabledTools).toEqual(["private_note", "set_labels"]);
    expect(withNativeToolGranted(next, "set_labels")).toEqual(next);
    expect(withNativeToolGranted([], "set_labels")).toEqual([]);
  });
});

describe("what a watcher on questions and rules does not draw", () => {
  test("memory and the fallback provider, which only a chat model uses", () => {
    for (const id of ["memory", "modelFallback"]) {
      expect(watcherSectionUsed("decisions", id)).toBe(false);
      expect(watcherSectionUsed("llm", id)).toBe(true);
    }
    for (const id of ["observation", "stt", "vision", "limits", undefined]) {
      expect(watcherSectionUsed("decisions", id)).toBe(true);
    }
  });

  test("General's Model card on questions and rules, and its Classifier on the language model", () => {
    expect(watcherSectionUsed("decisions", "general-model")).toBe(false);
    expect(watcherSectionUsed("decisions", "general-classifier")).toBe(true);
    expect(watcherSectionUsed("llm", "general-classifier")).toBe(false);
    expect(watcherSectionUsed("llm", "general-model")).toBe(true);
    expect(watcherSectionUsed("llm", "general-engine")).toBe(true);
  });

  test("warnings about knowledge bases, which it never searches", () => {
    for (const key of ["knowledge", "embedding"]) {
      expect(watcherIssueUsed("decisions", key)).toBe(false);
      expect(watcherIssueUsed("llm", key)).toBe(true);
    }
    expect(watcherIssueUsed("decisions", "decisions")).toBe(true);
    expect(watcherIssueUsed("decisions", "stt")).toBe(true);
  });
});

// The classifier's key list shows what can serve as that provider's API key, the same kinds the
// server accepts for it, and nothing of another nature (tracing keys and the like).
describe("the classifier's key list", () => {
  test("offers the provider's own kind and a generic key, and never a tracing key", () => {
    expect(credentialCompat.decisions("openai").sort()).toEqual([
      "generic",
      "openai",
    ]);
    expect(credentialCompat.decisions("typesafe")).toEqual(["generic"]);
    for (const provider of ["openai", "typesafe"]) {
      const kinds = credentialCompat.decisions(provider);
      expect(kinds.includes("langfuse")).toBe(false);
      for (const kind of kinds) {
        expect(credentialServes({ kind, valueFitsKind: true }, "apiKey")).toBe(
          true,
        );
      }
    }
  });
});

describe("the settings the warnings are computed from", () => {
  test("carry the engine as edited for a watcher, and only the engine", () => {
    const synced = {
      monitoring: { engine: "llm", analysis: "incremental" },
      stt: { enabled: true },
    };
    const form = withEngine(observationToForm(synced), "decisions");
    const out = withDraftEngine(synced, form, true) as {
      monitoring: { engine: string; analysis: string };
      stt: unknown;
    };
    expect(out.monitoring.engine).toBe("decisions");
    expect(out.monitoring.analysis).toBe("incremental");
    expect(out.stt).toEqual({ enabled: true });
    expect(withDraftEngine(synced, form, false)).toBe(synced);
  });
});
