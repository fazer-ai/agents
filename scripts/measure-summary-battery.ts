// A/B battery for the attendance summariser (modules/memory/summarize.ts).
//
// It exists because the summary this call writes is not a reply that is read once: it becomes the
// memory head, position 0 of every future turn for that contact, written once and never rewritten.
// So "does a cheaper model do here" is a question that has to be MEASURED, and the number has to be
// re-derivable by whoever reads it later — the previous battery's harness was never committed and
// its figures had to be reconstructed by hand.
//
// It drives the production function with a real model rather than re-implementing the prompt, so it
// cannot drift from what ships. Every axis is deterministic (no judge model), which is what makes a
// published figure reproducible.
//
//   OPENAI_API_KEY=... bun scripts/measure-summary-battery.ts --models gpt-5.4-mini,gpt-5.4-nano --n 32
//
// Axes, the same ones the prompt's own comment publishes:
//   complete facts   every fact the next attendance would need is present
//   name             the customer's name survived (the axis that rejected variant C)
//   invention        something asserted that the transcript does not contain
//   leaked writing   a run of non-Latin script inside a pt-BR summary (a model artifact)
//   median length    characters — text without facts is context paid for on every later turn

import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import { createChatModel } from "@/graph/models";
import { summarizeAttendance } from "@/modules/memory/summarize";

interface Scenario {
  id: string;
  messages: BaseMessage[];
  // Every one must be present for the summary to count as complete.
  facts: { label: string; re: RegExp }[];
  // The customer's name, scored on its own: losing it is memory damage, not cosmetics.
  name: RegExp;
  // Asserted by a summary but absent from the transcript.
  inventions: { label: string; re: RegExp }[];
}

const SCENARIOS: Scenario[] = [
  {
    // Simple: one request, one price, one date, closed.
    id: "1-simples",
    messages: [
      new HumanMessage("oi, boa tarde! queria saber quanto custa a avaliação"),
      new AIMessage(
        "Boa tarde! A avaliação sai por R$ 250,00. Posso já deixar um horário reservado?",
      ),
      new HumanMessage("pode sim. meu nome é Ana"),
      new AIMessage(
        "Perfeito, Ana. Tenho terça-feira às 14h. Fica bom pra você?",
      ),
      new HumanMessage("terça 14h tá ótimo, pode marcar"),
      new AIMessage(
        "Marcado, Ana: avaliação na terça-feira às 14h, R$ 250,00. Até lá!",
      ),
    ],
    facts: [
      { label: "nome", re: /\bana\b/i },
      { label: "valor 250", re: /250/ },
      { label: "terça", re: /ter[çc]a/i },
      { label: "14h", re: /\b14\s*h|14:00/i },
      { label: "avaliação", re: /avalia[çc][ãa]o/i },
    ],
    name: /\bana\b/i,
    inventions: [],
  },
  {
    // Hard, and hard in three specific ways: the value CHANGES mid-conversation (a summary that
    // reports the first one is wrong, not merely short), a constraint is stated ONCE and early (the
    // position a shorter summary drops first), and nothing is closed (the shape that invites a model
    // to invent a conclusion).
    id: "2-valor-muda",
    messages: [
      new HumanMessage(
        "bom dia! me chamo Marcelo. antes de mais nada, só consigo de manhã, trabalho à tarde e à noite",
      ),
      new AIMessage(
        "Bom dia, Marcelo! Anotado. Sobre qual procedimento você gostaria de saber?",
      ),
      new HumanMessage("a limpeza"),
      new AIMessage("A limpeza está R$ 400,00."),
      new HumanMessage("nossa, tá salgado"),
      new AIMessage(
        "Deixa eu conferir aqui... me desculpe, Marcelo, esse valor está desatualizado. A limpeza está R$ 350,00.",
      ),
      new HumanMessage("ah, melhorou. deixa eu ver com minha esposa e te falo"),
      new AIMessage("Claro! Fico à disposição."),
    ],
    facts: [
      { label: "nome", re: /\bmarcelo\b/i },
      { label: "valor final 350", re: /350/ },
      { label: "restrição manhã", re: /manh[ãa]/i },
      { label: "limpeza", re: /limpeza/i },
      {
        label: "sem fechamento",
        re: /n[ãa]o\s+(fechou|confirmou|definiu)|aguard|pendente|vai\s+(ver|falar|retornar)|em\s+aberto|esposa|sem\s+(defini|confirma)/i,
      },
    ],
    name: /\bmarcelo\b/i,
    inventions: [
      // Nothing was scheduled: no day and no time exist in this transcript.
      { label: "horário inventado", re: /\b\d{1,2}\s*h\b|\b\d{1,2}:\d{2}\b/ },
      {
        label: "dia inventado",
        re: /segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo/i,
      },
    ],
  },
];

// A run of 2+ characters outside Latin and general punctuation, inside a pt-BR summary. This is the
// model artifact the prompt's comment records ("com обещa de retorno"), never anything the
// transcript holds.
const NON_LATIN = /[^ -ɏ -⁯\s]{2,}/;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2
    ? (s[mid] as number)
    : Math.round(((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1]
    ? (process.argv[i + 1] as string)
    : fallback;
}

const models = arg("models", "gpt-5.4-mini,gpt-5.4-nano")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const n = Number.parseInt(arg("n", "32"), 10);
// Narrow the run to the scenarios that decide a given question: the axis that separates two models
// is rarely all of them, and a cell costs real provider calls.
const only = arg("scenarios", "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
const scenarios = only.length
  ? SCENARIOS.filter((sc) => only.some((o) => sc.id.startsWith(o)))
  : SCENARIOS;
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error(
    "OPENAI_API_KEY is required (this battery makes real provider calls).",
  );
  process.exit(1);
}

console.log(
  `models=${models.join(", ")}  n=${n}  scenarios=${scenarios.map((s) => s.id).join(", ")}`,
);
console.log(`total calls: ${models.length * scenarios.length * n}\n`);

for (const modelId of models) {
  const model = createChatModel({ provider: "openai", model: modelId, apiKey });
  for (const sc of scenarios) {
    let complete = 0;
    let named = 0;
    let invented = 0;
    let leaked = 0;
    let failed = 0;
    const lengths: number[] = [];
    const missing = new Map<string, number>();

    // Sequential on purpose: a burst of 32 concurrent calls is the shape that gets rate-limited, and
    // a rate-limit error would be scored as a failure rather than surfacing as one.
    for (let i = 0; i < n; i++) {
      const res = await summarizeAttendance(model, sc.messages);
      if (res.error || !res.summary) {
        failed++;
        continue;
      }
      const s = res.summary;
      lengths.push(s.length);
      const absent = sc.facts.filter((f) => !f.re.test(s));
      if (!absent.length) complete++;
      for (const f of absent)
        missing.set(f.label, (missing.get(f.label) ?? 0) + 1);
      if (sc.name.test(s)) named++;
      if (sc.inventions.some((inv) => inv.re.test(s))) invented++;
      if (NON_LATIN.test(s)) leaked++;
    }

    const scored = n - failed;
    console.log(
      `${modelId.padEnd(16)} ${sc.id.padEnd(14)} ` +
        `completos ${String(complete).padStart(2)}/${scored}  ` +
        `nome ${String(named).padStart(2)}/${scored}  ` +
        `invencao ${String(invented).padStart(2)}/${scored}  ` +
        `vazada ${String(leaked).padStart(2)}/${scored}  ` +
        `mediana ${median(lengths)}` +
        (failed ? `  [${failed} falharam]` : ""),
    );
    if (missing.size) {
      const worst = [...missing.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}x`);
      console.log(`${" ".repeat(31)}faltou: ${worst.join(", ")}`);
    }
  }
}
