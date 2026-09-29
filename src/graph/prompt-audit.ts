import {
  interpolatePromptVars,
  type PromptRenderOpts,
  SCHEDULE_VARS,
} from "./prompt";

// Every spelling that resolves from the agent's Availability, EN aliases included: the collapse has
// to key on the same names the interpolation answers, or one spelling would keep expanding.
const SCHEDULE_VAR_NAMES = new Set<string>(Object.keys(SCHEDULE_VARS));

// The system prompt as `execution_logs.detail` is allowed to keep it (docs/logs.md): the structure
// stays and customer values go. Every CONTEXT variable is masked, not only the obviously personal
// ones, so the next entry added to `buildPromptVars` cannot ship unmasked. TIME and SCHEDULE
// variables keep their values (nobody in the conversation authored them, and they often explain
// "why did it say we were closed"). An unresolved placeholder stays literal, so a typo reads as one.

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
  // The SAME options the turn's own rendering was given, passed whole rather than re-listed, so both
  // renderings answer every placeholder identically. `now` is required: the audit is built after a
  // DB read, and defaulting it could cross a minute and log an hour the model never saw.
  opts: PromptRenderOpts & { now: Date };
  // The blocks appended to the finished prompt, in the order they were appended.
  sections: readonly AuditedSection[];
}): string {
  // A schedule variable is kept in full once per rendering, then collapsed to the masked form.
  // A rendered schedule can be over 100 times its placeholder, so repeating it in full would push the
  // audit past the debug mode's ceiling and truncate the very field it shows.
  const spent = new Set<string>();
  const body = interpolatePromptVars(args.template, args.vars, {
    ...args.opts,
    // NOTE: `wrap` fires for time and schedule variables too, and those are kept: `name in vars` tells
    // them apart, because `buildPromptVars` answers neither a time nor a schedule name.
    wrap: (resolved, name) => {
      if (name in args.vars) return auditedPromptVar(name, resolved);
      if (!SCHEDULE_VAR_NAMES.has(name)) return resolved;
      // Keyed on the rendering, not the name: with a format suffix, `{{next_open_at:YYYY}}` and
      // `{{next_open_at:HH:mm}}` answer different things, and collapsing the second drops an answer.
      const seen = `${name}\u0000${resolved}`;
      if (spent.has(seen)) return auditedPromptVar(name, resolved);
      spent.add(seen);
      return resolved;
    },
  });
  if (args.sections.length === 0) return body;
  return `${body}\n\n${args.sections.map(auditedSection).join("\n")}`;
}
