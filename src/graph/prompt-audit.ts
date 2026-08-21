import { interpolatePromptVars, type PromptRenderOpts } from "./prompt";

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
  const body = interpolatePromptVars(args.template, args.vars, {
    ...args.opts,
    // `wrap` fires for time and schedule variables too, and those are kept: `name in vars` is what
    // tells them apart, because `buildPromptVars` answers neither a time nor a schedule name.
    wrap: (resolved, name) =>
      name in args.vars ? auditedPromptVar(name, resolved) : resolved,
  });
  if (args.sections.length === 0) return body;
  return `${body}\n\n${args.sections.map(auditedSection).join("\n")}`;
}
