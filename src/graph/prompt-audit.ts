import {
  interpolatePromptVars,
  type PromptRenderOpts,
  SCHEDULE_VARS,
} from "./prompt";

// Every spelling that resolves from the agent's Availability, EN aliases included: the collapse has
// to key on the same names the interpolation answers, or one spelling would keep expanding.
const SCHEDULE_VAR_NAMES = new Set<string>(Object.keys(SCHEDULE_VARS));

// The system prompt as `execution_logs.detail` is allowed to keep it.
//
// The Logs page records the prompt the agent was given this turn so an operator can inspect it
// (docs/logs.md, item 15). The prompt it was recording was the RESOLVED one, and resolving is
// exactly where the customer enters it: `{{nome_contato}}` becomes the contact's real name,
// `{{telefone_contato}}` their number, and the attribute-context block (whose own builder calls its
// values "ultimately customer-authored") is appended whole. That column is documented to carry
// allowlisted ids, counts and enums and NEVER message text or PII, and it is served by the Logs page
// and by `GET /v1/logs`. Both statements could not be true at once (issue #141).
//
// What the operator actually needs from this field is the prompt's STRUCTURE: which rules the agent
// was given, which A/B variant was in play, which variables the prompt used and whether they
// resolved, which context blocks were built for this turn. None of that is the value. So the values
// are the only thing that goes:
//
//   "Você atende {{nome_contato}}."        →  "Você atende {{nome_contato: string(19)}}."
//   "Hoje é {{data_atual}}."               →  "Hoje é 2026-08-20."
//   "Olá {{cliente_vip}}."                 →  "Olá {{cliente_vip}}."
//   <attribute_values>…512 chars…</…>      →  <atributos chaves="conversation:cpf" chars="512"/>
//
// A CONTEXT variable is one `buildPromptVars` answers: the contact's name, e-mail and phone, the
// inbox, the company, the agent. All of them are masked, not just the three that are obviously the
// customer's: the next entry added to that table would otherwise ship unmasked until someone
// remembered this file, which is the failure mode `src/modules/flowlog/shape.ts` was written to
// avoid. TIME variables are resolved as they were, because no person authored them and the hour the
// agent believed it was is often the whole answer to "why did it say we were closed". SCHEDULE
// variables ({{esta_aberto}}, {{proximo_atendimento}}, {{horario_atendimento}}) are kept for the
// same reason: they answer from the agent's OWN configured hours, which the operator wrote, and
// they are the other half of that same answer.
//
// A placeholder that did NOT resolve stays literally as it was written, which is what the prompt
// itself does with it, so a typo'd variable name still reads as a typo here and can never be
// confused with one that resolved.

// One appended block, named by what built it rather than by its rendered text.
export interface AuditedSection {
  // Stable label for the block (`atributos`, `agendamentos`).
  label: string;
  // The keys the OPERATOR selected, which is why they can be named: their provenance is the agent's
  // own configuration, never the conversation. Omitted when the block has no such selection.
  keys?: readonly string[];
  // The rendered block, used only for its length.
  text: string;
}

export function auditedPromptVar(name: string, resolved: string): string {
  return `{{${name}: string(${resolved.length})}}`;
}

export function auditedSection(section: AuditedSection): string {
  const keys =
    section.keys && section.keys.length > 0
      ? ` chaves="${section.keys.join(" ")}"`
      : "";
  return `<${section.label}${keys} chars="${section.text.length}"/>`;
}

export function buildPromptAudit(args: {
  // The composed prompt BEFORE interpolation: the operator's own text.
  template: string;
  // The context variables offered to this turn, by placeholder name.
  vars: Record<string, string>;
  // The SAME options the turn's own rendering was given, passed WHOLE rather than re-listed field by
  // field. The two renderings have to answer every placeholder identically, and the one time this
  // list was a copy it went out of date on the very next option added to the other one: the schedule
  // variables resolved for the model and stayed literal here, so the row reported an unresolved
  // placeholder the model had in fact been handed a value for.
  //
  // `now` is REQUIRED here, unlike on `interpolatePromptVars`: the audited prompt is built after the
  // real one, with a DB read in between, and both fall back to their own `new Date()` when it is
  // absent. An exact time variable would then cross a minute boundary and the logged prompt would
  // report an hour the model never saw. Taking the instant instead of defaulting it makes that a
  // type error.
  opts: PromptRenderOpts & { now: Date };
  // The blocks appended to the finished prompt, in the order they were appended.
  sections: readonly AuditedSection[];
}): string {
  // A schedule variable is kept in full ONCE PER NAME, and measured after that.
  //
  // Keeping them is deliberate — they answer from the agent's own configured hours, which is often
  // the whole answer to "why did it say we were closed" — but a rendered schedule is not small: at
  // the 200 windows a schedule may hold, `{{horario_atendimento}}` turns 23 characters into 2,639,
  // a factor of 114. A prompt that uses it in every paragraph would therefore produce an audit two
  // orders of magnitude past the ceiling the debug mode of #58 sizes from the prompt cap, and the
  // field the mode exists to show would be truncated by the mode itself.
  //
  // The first occurrence carries the answer; the ones after it repeat it verbatim and add nothing.
  // So they collapse into the same `{{name: string(N)}}` a masked context variable uses, which reads
  // as "this variable again, this long" rather than as something withheld. The bound that buys is
  // one full rendering per schedule name, three names in all.
  const spent = new Set<string>();
  const body = interpolatePromptVars(args.template, args.vars, {
    ...args.opts,
    // `wrap` fires for time and schedule variables too, and those are kept: `name in vars` is what
    // tells them apart, because `buildPromptVars` answers neither a time nor a schedule name.
    wrap: (resolved, name) => {
      if (name in args.vars) return auditedPromptVar(name, resolved);
      if (!SCHEDULE_VAR_NAMES.has(name)) return resolved;
      // Keyed on the RENDERING, not on the name: the placeholder takes a format suffix, so
      // `{{next_open_at:YYYY}}` and `{{next_open_at:HH:mm}}` are the same variable answering two
      // different things, and collapsing the second would drop an answer the operator asked for.
      // What repeats verbatim is what adds nothing.
      const seen = `${name}\u0000${resolved}`;
      if (spent.has(seen)) return auditedPromptVar(name, resolved);
      spent.add(seen);
      return resolved;
    },
  });
  if (args.sections.length === 0) return body;
  return `${body}\n\n${args.sections.map(auditedSection).join("\n")}`;
}
