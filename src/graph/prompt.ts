import {
  formatNextOpen,
  formatWindowsSummary,
  isOpenNow,
  nextOpening,
} from "@/modules/business-hours/announce";
import type { Schedule } from "@/modules/business-hours/hours";
import {
  DEFAULT_TIMEZONE,
  formatWithPattern,
  roundDownToMinutes,
} from "./time";

// Runtime-owned prompt composition: grounding discipline and safe context-variable interpolation.
// Both are applied by the runtime (prepare.ts), NOT delegated to the tenant's free-text prompt:
// grounding is a product invariant (an un-grounded agent that fabricates answers is the failure
// mode the market punishes), and interpolation values come from the (customer-controlled) contact
// record, so they are sanitized before they ever touch the system prompt (prompt-injection bound).

// Appended to the system prompt whenever the agent is granted the knowledge-base search tool. It
// turns "answer from the KB" into an enforced contract instead of a per-tenant prompting habit.
export const GROUNDING_DIRECTIVE = [
  "Knowledge & grounding rules:",
  "- When the customer asks something answerable from the knowledge base, call search_knowledge FIRST and base your answer ONLY on what it returns.",
  "- Never invent facts, prices, policies, dates, or commitments that are not supported by a search result or by the conversation itself.",
  "- Write a natural reply the customer can read directly: do NOT add reference markers like [1] or footnote-style citations to your answer.",
  "- If the search returns nothing relevant, say plainly that you don't have that information and offer to connect the customer with a human — do NOT guess.",
].join("\n");

export function composeSystemPrompt(
  basePrompt: string,
  opts: { grounded: boolean },
): string {
  const base = basePrompt.trim();
  if (!opts.grounded) return base;
  return base ? `${base}\n\n${GROUNDING_DIRECTIVE}` : GROUNDING_DIRECTIVE;
}

// ── context variables ──

export interface PromptVarContext {
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  inboxName?: string | null;
  // Operator-controlled (trusted) identity values.
  companyName?: string | null;
  agentName?: string | null;
}

export const VALUE_MAX = 120;

// NOTE: Contact/inbox values are customer-controlled → drop control chars and newlines (so a value
// can never forge multi-line "system" framing in the prompt), collapse whitespace, and bound length.
// Exported as sanitizePromptValue because every OTHER customer-controlled string we splice into the
// system prompt (e.g. the Chatwoot attribute values) must go through the same treatment. `max` is
// per-caller: VALUE_MAX suits identity variables, but a stored attribute (an address, a note) is
// legitimately longer — see ATTRIBUTE_VALUE_MAX in chatwoot/attributes.ts.
export function sanitizePromptValue(
  v: string | null | undefined,
  max: number = VALUE_MAX,
): string {
  if (!v) return "";
  let out = "";
  for (const ch of v) {
    const code = ch.codePointAt(0) ?? 0;
    // NOTE: C0 + DEL + C1. The C1 range matters as much as C0 and is easy to miss: U+0085 (NEL) is
    // a line break to plenty of renderers and tokenizers, and JS `\s` does NOT match it, so the
    // collapse below would let it through and a value could still forge a new line of framing.
    const control =
      code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    out += control ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, max);
}

// Placeholder → value. English canonical names plus the common pt-BR aliases the audience writes.
export function buildPromptVars(ctx: PromptVarContext): Record<string, string> {
  const name = sanitizePromptValue(ctx.contactName);
  const firstName = name.split(" ")[0] ?? "";
  const email = sanitizePromptValue(ctx.contactEmail);
  const phone = sanitizePromptValue(ctx.contactPhone);
  const inbox = sanitizePromptValue(ctx.inboxName);
  const company = sanitizePromptValue(ctx.companyName);
  const agent = sanitizePromptValue(ctx.agentName);
  return {
    contact_name: name,
    nome_contato: name,
    contact_first_name: firstName,
    primeiro_nome: firstName,
    contact_email: email,
    email_contato: email,
    contact_phone: phone,
    telefone_contato: phone,
    inbox_name: inbox,
    canal: inbox,
    company_name: company,
    nome_empresa: company,
    agent_name: agent,
    nome_agente: agent,
  };
}

// Default rounding slot for the "current time" variables: floors to the half hour so the injected
// value is stable within a 30-min window (prompt caching), unless the operator asks for the exact
// variant. Time variables map name → { rounded, defaultFormat, roundedSibling? }; the {{var:FORMAT}}
// suffix (using formatWithPattern tokens YYYY/MM/DD/HH/mm/ss) overrides the format, never the rounding.
export const TIME_ROUND_MINUTES = 30;
const TIME_VARS: Record<
  string,
  { rounded: boolean; defaultFormat: string; roundedSibling?: string }
> = {
  hora_atual: { rounded: true, defaultFormat: "HH:mm" },
  current_time: { rounded: true, defaultFormat: "HH:mm" },
  // Exact time-of-day vars: the value changes every minute, defeating prompt caching. roundedSibling
  // names the cache-stable variant the editor suggests instead.
  hora_atual_exata: {
    rounded: false,
    defaultFormat: "HH:mm",
    roundedSibling: "hora_atual",
  },
  current_time_exact: {
    rounded: false,
    defaultFormat: "HH:mm",
    roundedSibling: "current_time",
  },
  data_atual: { rounded: false, defaultFormat: "DD/MM/YYYY" },
  current_date: { rounded: false, defaultFormat: "DD/MM/YYYY" },
  data_hora_atual: { rounded: true, defaultFormat: "DD/MM/YYYY HH:mm" },
  current_datetime: { rounded: true, defaultFormat: "DD/MM/YYYY HH:mm" },
};

// ── schedule variables ──

// The agent's own Availability, as the three questions a customer actually asks it: whether it is
// open, when it opens next, and what its hours are. Without these the agent answers all three from
// whatever the operator typed into the system prompt, which drifts from the schedule the gate
// enforces the moment either one changes — and the customer is then told one thing by the agent and
// another by the gate.
//
// The pt-BR and EN names are NOT two aliases of one value, the way {{nome_contato}}/{{contact_name}}
// are: each answer is prose, and the name the operator reached for is the only signal of which
// language the surrounding prompt is written in. An agent has no language of its own.
type ScheduleVarKind = "is_open" | "next_open" | "summary";
const SCHEDULE_VARS: Record<
  string,
  { kind: ScheduleVarKind; lang: "pt" | "en" }
> = {
  esta_aberto: { kind: "is_open", lang: "pt" },
  is_open: { kind: "is_open", lang: "en" },
  proximo_atendimento: { kind: "next_open", lang: "pt" },
  next_open_at: { kind: "next_open", lang: "en" },
  horario_atendimento: { kind: "summary", lang: "pt" },
  business_hours: { kind: "summary", lang: "en" },
};

// Same locales the away message's two spellings pick (availability/away.ts), so an agent that tells
// the customer "we are back {proximo_atendimento}" and one that answers "{{proximo_atendimento}}" in
// its own words are never rendering the same instant two different ways.
const SCHEDULE_WORDS: Record<
  "pt" | "en",
  {
    locale: string;
    yes: string;
    no: string;
    now: string;
    never: string;
    alwaysOpen: string;
  }
> = {
  pt: {
    locale: "pt-BR",
    yes: "sim",
    no: "não",
    now: "agora",
    never: "sem previsão",
    alwaysOpen: "sempre aberto",
  },
  en: {
    locale: "en-US",
    yes: "yes",
    no: "no",
    now: "now",
    never: "not scheduled",
    alwaysOpen: "always open",
  },
};

function renderScheduleVar(
  v: { kind: ScheduleVarKind; lang: "pt" | "en" },
  schedule: Schedule | null,
  now: Date,
  tz: string,
  fmt: string | undefined,
): string {
  const w = SCHEDULE_WORDS[v.lang];
  // An absent schedule and a schedule with no windows are the same always-on state, and
  // formatWindowsSummary's own empty-input fallback is where that lands.
  if (v.kind === "summary") {
    return formatWindowsSummary(
      schedule?.windows ?? [],
      w.alwaysOpen,
      w.locale,
    );
  }
  if (v.kind === "is_open") return isOpenNow(schedule, now) ? w.yes : w.no;
  const next = nextOpening(schedule, now);
  if (next.kind === "now") return w.now;
  if (next.kind === "never") return w.never;
  // An explicit :FORMAT is the operator asking for a shape; the default is the one #154 argued for
  // the away message (weekday AND date, because a bare weekday is ambiguous for exactly the closures
  // #148 added). Both surfaces speak to the same customer, so they render the instant identically.
  if (fmt) return formatWithPattern(next.when, tz, fmt);
  return formatNextOpen(next.when, now, tz, w.locale);
}

// {{ var }} or {{ var:FORMAT }} — spaces optional, var is lowercase + underscores, format is any
// run of non-`}` chars. Single-brace {x} is intentionally NOT matched (clean migration). Exported
// as a source string (build a fresh RegExp per use — the global flag carries lastIndex) so the
// editor's syntax highlighter marks exactly what the runtime will interpolate.
export const PROMPT_PLACEHOLDER_SOURCE =
  "\\{\\{\\s*([a-z_]+)(?::([^}]+))?\\s*\\}\\}";
const PLACEHOLDER = new RegExp(PROMPT_PLACEHOLDER_SOURCE, "g");

// Replaces ONLY allowlisted {{placeholders}}; an unknown one is left untouched (the tenant sees its
// own literal, never a leak/empty). Static values are pre-sanitized by buildPromptVars; time
// variables are computed from `opts.now` (default: real now) in `opts.timezone`.
export function interpolatePromptVars(
  template: string,
  vars: Record<string, string>,
  opts: {
    timezone?: string;
    now?: Date;
    // Called for every successfully-resolved placeholder (context or time var) with the resolved
    // value and the variable name; its return replaces the value. Defaults to identity. Unknown
    // placeholders are left untouched and never wrapped. The preview uses it to mark dynamic text.
    wrap?: (resolved: string, name: string) => string;
    // The agent's Availability, when this caller resolves one: a null `schedule` means no Availability
    // is configured, which the gate treats as always on. Omitting the option entirely says this caller
    // has no notion of a schedule (the WhatsApp template path), and the schedule placeholders are then
    // left as the operator's own literal rather than answered with a guess.
    availability?: { schedule: Schedule | null };
  } = {},
): string {
  const wrap = opts.wrap ?? ((v: string) => v);
  // ONE timezone for the whole template. The schedule's own wins because its windows are wall times
  // in it, and because the two are the same row on the real path (prepare.ts reads the clock from the
  // BusinessHours it also reads the grid from). Resolving it per variable instead is how a caller that
  // supplies a schedule and no timezone — the editor preview — ends up rendering {{hora_atual}} in the
  // product default next to a {{proximo_atendimento}} in the agent's zone, disagreeing about the hour
  // inside one prompt.
  const tz =
    opts.availability?.schedule?.timezone || opts.timezone || DEFAULT_TIMEZONE;
  return template.replace(
    PLACEHOLDER,
    (match, key: string, fmt: string | undefined) => {
      const timeVar = TIME_VARS[key];
      if (timeVar) {
        const now = opts.now ?? new Date();
        const when = timeVar.rounded
          ? roundDownToMinutes(now, TIME_ROUND_MINUTES)
          : now;
        return wrap(
          formatWithPattern(when, tz, fmt?.trim() || timeVar.defaultFormat),
          key,
        );
      }
      const scheduleVar = SCHEDULE_VARS[key];
      if (scheduleVar && opts.availability) {
        return wrap(
          renderScheduleVar(
            scheduleVar,
            opts.availability.schedule,
            opts.now ?? new Date(),
            tz,
            fmt?.trim() || undefined,
          ),
          key,
        );
      }
      return key in vars ? wrap(vars[key] as string, key) : match;
    },
  );
}

// All interpolatable time-variable names (incl. EN aliases). Used internally for the known-var set;
// the editor's "insert variable" helper shows the deduped pt-BR subset (PROMPT_TIME_VARS_DISPLAY).
export const PROMPT_TIME_VARS = Object.keys(TIME_VARS);

// Canonical pt-BR time vars shown in the editor's "insert variable" helper. Interpolation still
// accepts the EN aliases (current_time/current_date/…) for compat, but listing both names side by
// side just confused operators ("current_time vs hora_atual?"). One name per concept here.
export const PROMPT_TIME_VARS_DISPLAY = [
  "hora_atual",
  "hora_atual_exata",
  "data_atual",
  "data_hora_atual",
];

// Canonical pt-BR schedule vars for the editor's "insert variable" helper, same rule as the time
// vars: one name per concept, with the EN spellings still interpolating.
export const PROMPT_SCHEDULE_VARS_DISPLAY = [
  "esta_aberto",
  "proximo_atendimento",
  "horario_atendimento",
];

export const PROMPT_CONTEXT_VARS = [
  "nome_empresa",
  "nome_agente",
  "nome_contato",
  "primeiro_nome",
  "email_contato",
  "telefone_contato",
  "canal",
];

// Every interpolatable name (time vars + both EN/pt-BR context aliases), so the editor's syntax
// highlighter can tell a real {{var}} from a typo. Derived from the same sources the runtime uses.
const PROMPT_ALL_VARS = new Set<string>([
  ...PROMPT_TIME_VARS,
  ...Object.keys(SCHEDULE_VARS),
  ...Object.keys(buildPromptVars({})),
]);

export function isKnownPromptVar(name: string): boolean {
  return PROMPT_ALL_VARS.has(name);
}

// ── rounding / caching helpers (editor UI) ──

// Classifies a display time var for the editor's help tooltip: "rounded" (floored to the slot, stable
// across requests → good for prompt caching), "exact" (time-of-day recomputed every minute → defeats
// caching), or "date" (date-only, stable within a day). null for non-time vars. Derived from TIME_VARS
// so the tooltip never drifts from the runtime.
export type TimeVarKind = "rounded" | "exact" | "date";
export function timeVarKind(name: string): TimeVarKind | null {
  const v = TIME_VARS[name];
  if (!v) return null;
  if (v.rounded) return "rounded";
  return v.roundedSibling ? "exact" : "date";
}

// Scans a prompt template for exact time-of-day vars (cache-volatile) and returns each distinct one
// with the rounded sibling to suggest. Empty when there is nothing to warn about. Powers the editor's
// "prefer the rounded variable" caching hint.
export function findExactTimeVarUsages(
  template: string,
): Array<{ name: string; suggestion: string }> {
  const re = new RegExp(PROMPT_PLACEHOLDER_SOURCE, "g");
  const seen = new Set<string>();
  const out: Array<{ name: string; suggestion: string }> = [];
  for (const m of template.matchAll(re)) {
    const name = m[1];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const sibling = TIME_VARS[name]?.roundedSibling;
    if (sibling) out.push({ name, suggestion: sibling });
  }
  return out;
}
