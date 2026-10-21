import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError } from "@/lib/errors";
import { inRange } from "@/lib/number-range";
import type { TenantContext } from "@/lib/tenancy";
import { templateChoice } from "@/modules/agents/settings-schema";
import type { LoadChatwootClientDeps } from "@/modules/chatwoot/instance";
import { loadAgentTemplateDefinitions } from "@/modules/chatwoot/management";
import { REMINDER_OFFSET_RANGE } from "@/modules/integrations/calendar-config-ranges";
import {
  configuredChoices,
  misplacedAppointmentVar,
  PROACTIVE_KINDS,
  readServiceWindowConfig,
  templateChoiceProblem,
} from "@/modules/service-window/service";

// The save-time rules of the service window's templates (docs/service-window.md). Two halves: what
// the bag alone can answer, and what needs the inbox's synced templates, which is a Chatwoot read and
// so runs OUTSIDE the agent's row lock.

function rawServiceWindow(settings: unknown): Record<string, unknown> | null {
  if (!settings || typeof settings !== "object") return null;
  const block = (settings as Record<string, unknown>).serviceWindow;
  return block && typeof block === "object"
    ? (block as Record<string, unknown>)
    : null;
}

// Whether this write changes the block at all: an untouched block is never re-judged, so a rule
// added later does not lock an operator out of saving an unrelated field.
function serviceWindowChanged(settings: unknown, stored: unknown): boolean {
  if (settings === undefined) return false;
  return (
    JSON.stringify(rawServiceWindow(settings)) !==
    JSON.stringify(rawServiceWindow(stored))
  );
}

// The rules the bag answers alone: each reminder offset is a number of hours with a template under
// it, and the appointment's placeholders appear only where an appointment exists.
export function assertSettingsServiceWindow(
  settings: unknown,
  stored: unknown,
): void {
  if (!serviceWindowChanged(settings, stored)) return;
  const raw = rawServiceWindow(settings);
  const byKind = raw?.templates;
  if (byKind && typeof byKind === "object") {
    for (const [kind, value] of Object.entries(
      byKind as Record<string, unknown>,
    )) {
      const where = `serviceWindow.templates.${kind}`;
      if (!(PROACTIVE_KINDS as readonly string[]).includes(kind)) {
        throw new AppError(
          `${where}: not a proactive kind (${PROACTIVE_KINDS.join(", ")})`,
          400,
          "errors.serviceWindowKind",
          { where, kinds: PROACTIVE_KINDS.join(", ") },
          where,
        );
      }
      if (value !== null && !templateChoice.safeParse(value).success) {
        throw new AppError(
          `${where}: not a template choice ({ name, language, params, … })`,
          400,
          "errors.serviceWindowReminderChoice",
          { where },
          where,
        );
      }
    }
  }
  const byOffset = raw?.reminderTemplates;
  if (byOffset && typeof byOffset === "object") {
    const seen = new Set<number>();
    for (const [offset, value] of Object.entries(
      byOffset as Record<string, unknown>,
    )) {
      const hours = Number(offset);
      const where = `serviceWindow.reminderTemplates.${offset}`;
      // "24" and "24.0" are one reminder, and the reader would keep only one of them.
      if (seen.has(hours)) {
        throw new AppError(
          `${where}: another key already names the reminder ${hours} hours before`,
          400,
          "errors.serviceWindowReminderOffsetRepeated",
          { where, hours },
          where,
        );
      }
      seen.add(hours);
      if (!inRange(hours, REMINDER_OFFSET_RANGE)) {
        throw new AppError(
          `${where}: the key is a reminder offset in hours`,
          400,
          "errors.serviceWindowReminderOffset",
          { where },
          where,
        );
      }
      if (value !== null && !templateChoice.safeParse(value).success) {
        throw new AppError(
          `${where}: not a template choice ({ name, language, params, … })`,
          400,
          "errors.serviceWindowReminderChoice",
          { where },
          where,
        );
      }
    }
  }
  const misplaced = misplacedAppointmentVar(readServiceWindowConfig(settings));
  if (misplaced) {
    throw new AppError(
      `${misplaced.where}: {{${misplaced.placeholder}}} is an appointment placeholder, and only appointment reminders have an appointment`,
      400,
      "errors.serviceWindowAppointmentVar",
      { where: misplaced.where, placeholder: `{{${misplaced.placeholder}}}` },
      misplaced.where,
    );
  }
}

// The rule that needs the inbox: every template this write sets or changes exists there, in its
// language, and is filled with as many parameters as it takes. A choice the write leaves as it was
// is not re-judged (a template retired at Meta must not block saving the window hours). When the
// templates cannot be read (no inbox bound, an instance down, an unofficial channel that has none)
// there is nothing to judge against, and the write goes through as it did before this rule.
export async function assertServiceWindowTemplatesUsable(
  ctx: TenantContext,
  agentId: bigint,
  settings: unknown,
  stored: unknown,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<void> {
  const before = new Map(
    configuredChoices(readServiceWindowConfig(stored)).map((c) => [
      c.where,
      JSON.stringify(c.choice),
    ]),
  );
  const changed = configuredChoices(readServiceWindowConfig(settings)).filter(
    (c) => before.get(c.where) !== JSON.stringify(c.choice),
  );
  if (changed.length === 0) return;
  const { templates, byInbox, complete } = await loadAgentTemplateDefinitions(
    ctx,
    agentId,
    deps,
    base,
  );
  if (!complete || templates.length === 0) return;
  for (const { where, choice } of changed) {
    // Judged in every inbox that has the template, since a send goes out through its conversation's
    // inbox; against the union only to say it exists nowhere.
    const holders = byInbox.filter((defs) =>
      defs.some((d) => d.name === choice.name),
    );
    const problem =
      holders.length === 0
        ? templateChoiceProblem(choice, templates)
        : (holders
            .map((defs) => templateChoiceProblem(choice, defs))
            .find((p) => p !== null) ?? null);
    if (problem) {
      throw new AppError(
        `${where}: ${problem.message}`,
        422,
        `errors.${problem.key}`,
        { where, ...problem.params },
        where,
      );
    }
  }
}
